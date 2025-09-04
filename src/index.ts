import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import bodyParser from "body-parser";

import { prisma } from "./lib/prisma.js";
import { logger, httpLogger } from "./lib/logger.js";
import { sendOrderToManufacturer, verifyManufacturerSignature } from "./lib/manufacturer.js";

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// --- Middlewares globaux ---
app.use(cors({
  origin: "https://diego029929.github.io" // autorise ton frontend
}));
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

// ⚡️ Route test backend pour le frontend
app.get("/test-backend", (_, res) => {
  res.json({ message: "Successful" });
});

// ⚡️ Route panier simulé (test frontend)
app.get("/cart", (_, res) => {
  res.json({
    items: [
      { id: 1, name: "Produit test 1", price: 10 },
      { id: 2, name: "Produit test 2", price: 20 },
    ]
  });
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
        
