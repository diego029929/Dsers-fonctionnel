import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import bodyParser from "body-parser";

import { prisma } from "./lib/prisma.js";
import { logger, httpLogger } from "./lib/logger.js";
import { stripe } from "./lib/stripe.js";
import {
  sendOrderToManufacturer,
  verifyManufacturerSignature,
} from "./lib/manufacturer.js";

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// --- Middlewares globaux ---
app.use(cors());
app.use(helmet());
app.use(httpLogger);

// ⚠️ On met JSON parser par défaut, mais pas pour Stripe webhook
app.use((req, res, next) => {
  if (req.originalUrl === "/webhooks/stripe") {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// --- Routes ---

// ✅ Health check
app.get("/", (_, res) => {
  res.json({ ok: true, service: "mini-dsers-backend" });
});

// ✅ List active products
app.get("/products", async (_, res) => {
  const products = await prisma.product.findMany({
    where: { active: true },
  });
  res.json(products);
});

// ✅ Create Stripe Checkout Session
app.post("/checkout", async (req, res) => {
  try {
    const { email, items } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: "No items in checkout" });
    }

    const dbItems = await prisma.product.findMany({
      where: { id: { in: items.map((i: any) => i.productId) } },
    });

    let amountCents = 0;
    const lineItems: any[] = [];

    for (const i of items) {
      const product = dbItems.find((p) => p.id === i.productId);
      if (!product) continue;

      amountCents += product.priceCents * i.quantity;

      lineItems.push({
        price_data: {
          currency: product.currency,
          product_data: { name: product.title },
          unit_amount: product.priceCents,
        },
        quantity: i.quantity,
      });
    }

    // 📦 Crée une commande dans la BDD
    const order = await prisma.order.create({
      data: {
        email,
        amountCents,
        currency: "eur",
        lineItems: {
          create: items.map((i: any) => ({
            productId: i.productId,
            quantity: i.quantity,
            unitPriceCents:
              dbItems.find((p) => p.id === i.productId)?.priceCents || 0,
          })),
        },
      },
    });

    // 💳 Crée une session Stripe Checkout
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: email,
      line_items: lineItems,
      mode: "payment",
      success_url: `${PUBLIC_BASE_URL}/success.html?orderId=${order.id}`,
      cancel_url: `${PUBLIC_BASE_URL}/cancel.html?orderId=${order.id}`,
      metadata: { orderId: order.id },
    });

    // 🔄 Met à jour la commande avec l’ID de session Stripe
    await prisma.order.update({
      where: { id: order.id },
      data: { stripeSessionId: session.id },
    });

    res.json({ id: session.id, url: session.url });
  } catch (err) {
    logger.error("Erreur création checkout :", err);
    res.status(500).json({ error: "Échec création de la session de paiement" });
  }
});

// ✅ Webhook Stripe : écoute les événements de paiement
app.post(
  "/webhooks/stripe",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) return res.status(500).send("Stripe webhook secret not set");

    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig!, webhookSecret);
    } catch (err: any) {
      logger.error("⚠️ Signature Stripe invalide :", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      const session = event.data.object as any;

      if (event.type === "checkout.session.completed") {
        const orderId = session.metadata?.orderId;

        if (orderId) {
          await prisma.order.update({
            where: { id: orderId },
            data: {
              status: "PAID",
              stripePaymentIntentId: session.payment_intent,
            },
          });

          const order = await prisma.order.findUnique({
            where: { id: orderId },
            include: { lineItems: { include: { product: true } } },
          });

          if (order) {
            const payload = {
              orderId: order.id,
              email: order.email,
              items: order.lineItems.map((li) => ({
                sku: li.product.sku,
                quantity: li.quantity,
              })),
              shippingAddress: session.shipping_details?.address
                ? {
                    name: session.customer_details?.name || "",
                    address1: session.shipping_details.address.line1,
                    address2: session.shipping_details.address.line2,
                    city: session.shipping_details.address.city,
                    postalCode: session.shipping_details.address.postal_code,
                    country: session.shipping_details.address.country,
                  }
                : {
                    name: "",
                    address1: "",
                    city: "",
                    postalCode: "",
                    country: "",
                  },
              notifyUrl: `${PUBLIC_BASE_URL}/webhooks/manufacturer`,
            };

            const manufacturer = await sendOrderToManufacturer(payload);

            await prisma.order.update({
              where: { id: order.id },
              data: {
                status: "SENT_TO_SUPPLIER",
                fulfillmentId: manufacturer.fulfillmentId,
              },
            });
          }
        }
      }

      await prisma.paymentEvent.create({
        data: {
          type: event.type,
          raw: event as any,
          orderId: (event.data.object as any).metadata?.orderId,
        },
      });
    } catch (err) {
      logger.error("Erreur traitement webhook Stripe :", err);
    }

    res.json({ received: true });
  }
);

// ✅ Webhook du fabricant (mise à jour de la livraison)
app.post(
  "/webhooks/manufacturer",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["x-signature"] as string | undefined;

    if (!verifyManufacturerSignature(req.body, signature)) {
      return res.status(400).send("Signature fournisseur invalide");
    }

    const event = JSON.parse(req.body.toString());
    logger.info({ event }, "Réception webhook fournisseur");

    if (event.type === "FULFILLMENT_ACCEPTED") {
      await prisma.order.updateMany({
        where: { fulfillmentId: event.fulfillmentId },
        data: { status: "FULFILLMENT_ACCEPTED" },
      });
    } else if (event.type === "SHIPPED") {
      await prisma.order.updateMany({
        where: { fulfillmentId: event.fulfillmentId },
        data: { status: "SHIPPED", trackingNumber: event.trackingNumber },
      });
    }

    res.json({ ok: true });
  }
);

// ✅ Consulter une commande
app.get("/orders/:id", async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: { lineItems: true },
  });

  if (!order) return res.status(404).json({ error: "Commande introuvable" });

  res.json(order);
});

// 🚀 Lancer le serveur
app.listen(PORT, () => {
  logger.info(`✅ Serveur lancé sur http://localhost:${PORT}`);
});
