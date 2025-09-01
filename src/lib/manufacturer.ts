import axios from "axios";
import crypto from "crypto";

const API_URL = process.env.MANUFACTURER_API_URL;
const API_KEY = process.env.MANUFACTURER_API_KEY;
const OUTBOUND_WEBHOOK_SECRET = process.env.MANUFACTURER_WEBHOOK_SECRET;

export async function sendOrderToManufacturer(payload: {
  orderId: string;
  email: string;
  items: Array<{ sku: string; quantity: number; }>;
  shippingAddress: {
    name: string;
    address1: string;
    address2?: string;
    city: string;
    postalCode: string;
    country: string;
    phone?: string;
  };
  notifyUrl: string;
}) {
  const url = `${API_URL}/orders`;
  const res = await axios.post(url, payload, {
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json"
    },
    timeout: 15000
  });
  return res.data as { fulfillmentId: string };
}

export function verifyManufacturerSignature(rawBody: Buffer, signature: string | undefined) {
  if (!OUTBOUND_WEBHOOK_SECRET) return false;
  if (!signature) return false;
  const hmac = crypto.createHmac("sha256", OUTBOUND_WEBHOOK_SECRET);
  hmac.update(rawBody);
  const digest = hmac.digest("hex");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
      }
