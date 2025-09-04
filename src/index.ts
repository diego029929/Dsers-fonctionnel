import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import bodyParser from "body-parser";

import { prisma } from "./lib/prisma.js";
import { logger, httpLogger } from "./lib/logger.js";
import {
  sendOrderToManufacturer,
  verifyManufacturerSignature,
} from "./lib/manufacturer.js";

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// --- Middlewares globaux ---
app.use(
  cors({
    origin: "https://diego029929.github.io",
    methods: ["GET", "POST", "OPTIONS"],
  })
);
app.use(helmet());
app.use(httpLogger);
app.use(express.json());

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

// ⚡️ Checkout simulé
app.post("/checkout", async (req, res) => {
  try {
    const { email, items } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: "No items in checkout" });
    }

    // 📦 Crée une commande dans la BDD
    const dbItems = await prisma.product.findMany({
      where: { id: { in: items.map((i: any) => i.productId) } },
    });

    let amountCents = 0;

    for (const i of items) {
      const product = dbItems.find((p) => p.id === i.productId);
      if (!product) continue;
      amountCents += product.priceCents * i.quantity;
    }

    const order = await prisma.order.create({
      data: {
        email,
        amountCents,
        currency: "eur",
        status: "PAID", // Marqué payé directement pour simulation
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

    res.json({ message: "successful", orderId: order.id });
  } catch (err) {
    logger.error("Erreur création checkout :", err);
    res.status(500).json({ error: "Échec création de la commande" });
  }
});

// ✅ Webhook du fabricant
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
        
