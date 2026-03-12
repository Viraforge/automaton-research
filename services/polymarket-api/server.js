const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { verifyX402Payment, USDC_ADDRESS } = require("./verify-x402.js");

const app = express();
app.use(cors());
app.use(express.json());

const PAY_TO_ADDRESS = process.env.PAY_TO_ADDRESS || "0xa2e4B81f2CD154A0857b280754507f369eD685ba";
const BASE_RPC_URL = process.env.BASE_RPC_URL || "";
const DEFAULT_PRICE_CENTS = parseInt(process.env.PRICE_CENTS || "1", 10);
const PRICE_STATE_PATH = process.env.PRICE_STATE_PATH || path.join(__dirname, "price-state.json");
const PORT = parseInt(process.env.PORT || "8081", 10);
const MAX_PRICE_CENTS = 100_000;
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "";

function toValidPriceCents(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null;
  if (parsed < 1 || parsed > MAX_PRICE_CENTS) return null;
  return parsed;
}

function loadPriceFromState() {
  try {
    const raw = fs.readFileSync(PRICE_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return toValidPriceCents(parsed?.priceCents);
  } catch (_err) {
    return null;
  }
}

function persistPriceToState(priceCents) {
  const tmpPath = `${PRICE_STATE_PATH}.tmp`;
  const payload = JSON.stringify(
    { priceCents, updatedAt: new Date().toISOString() },
    null,
    2,
  );
  fs.writeFileSync(tmpPath, payload, "utf8");
  fs.renameSync(tmpPath, PRICE_STATE_PATH);
}

const bootPrice = toValidPriceCents(DEFAULT_PRICE_CENTS) || 1;
let currentPriceCents = loadPriceFromState() || bootPrice;

function getPriceCents() {
  return currentPriceCents;
}

function setPriceCents(nextPriceCents) {
  currentPriceCents = nextPriceCents;
  persistPriceToState(nextPriceCents);
}

function formatUsdFromCents(cents) {
  return (cents / 100).toFixed(2);
}

function isLoopbackAddress(ip) {
  if (!ip) return false;
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return true;
  return false;
}

function extractForwardedClientIp(req) {
  const header = req.headers["x-forwarded-for"];
  if (!header || typeof header !== "string") return null;
  const first = header.split(",")[0]?.trim();
  return first || null;
}

function canMutatePricing(req) {
  const socketIp = req.socket?.remoteAddress || "";
  if (!isLoopbackAddress(socketIp)) return false;
  // If proxied through Caddy, x-forwarded-for contains the original client.
  // Only allow updates from local callers end-to-end.
  const forwardedIp = extractForwardedClientIp(req);
  if (forwardedIp && !isLoopbackAddress(forwardedIp)) return false;
  return true;
}

// Payment requirement response (x402 spec)
function buildPaymentRequiredPayload(error = "Payment required") {
  const priceCents = getPriceCents();
  return {
    x402Version: 2,
    error,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        maxAmountRequired: String(priceCents * 10000), // cents -> atomic units
        payToAddress: PAY_TO_ADDRESS,
        requiredDeadlineSeconds: 300,
        usdcAddress: USDC_ADDRESS,
      },
    ],
  };
}

function paymentRequiredResponse(res, error = "Payment required") {
  const payload = buildPaymentRequiredPayload(error);
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
  return res
    .status(402)
    .set("PAYMENT-REQUIRED", encoded)
    .set("X-Payment-Required", encoded)
    .json(payload);
}

// x402 payment middleware
async function requirePayment(req, res, next) {
  const priceCents = getPriceCents();

  // Allow internal requests with valid token (skip payment for agent's own services)
  const internalToken = req.headers["x-internal-token"];
  const expectedToken = INTERNAL_API_TOKEN;

  if (expectedToken && internalToken === expectedToken) {
    req.payer = "internal";
    return next();
  }

  const paymentHeader = req.headers["payment-signature"] || req.headers["x-payment"];
  if (!paymentHeader) {
    return paymentRequiredResponse(res);
  }

  const result = await verifyX402Payment(paymentHeader, {
    payToAddress: PAY_TO_ADDRESS,
    minAmountCents: priceCents,
    rpcUrl: BASE_RPC_URL || undefined,
  });

  if (!result.valid) {
    return paymentRequiredResponse(res, result.error || "Payment failed");
  }

  req.payer = result.from;
  next();
}

// -- Routes --

// Health (ungated)
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Free tier (ungated)
app.get("/v1/free-markets", (req, res) => {
  res.json({
    markets: [
      { id: "demo-1", question: "Demo market (free tier)", outcome: "Yes/No" },
    ],
  });
});

app.get("/v1/pricing", (_req, res) => {
  const priceCents = getPriceCents();
  res.json({
    price_cents: priceCents,
    price_usd: formatUsdFromCents(priceCents),
  });
});

app.post("/v1/admin/pricing", (req, res) => {
  if (!canMutatePricing(req)) {
    return res.status(403).json({ error: "pricing updates allowed only from local host" });
  }
  const nextPriceCents = toValidPriceCents(req.body?.price_cents);
  if (!nextPriceCents) {
    return res.status(400).json({
      error: `price_cents must be an integer between 1 and ${MAX_PRICE_CENTS}`,
    });
  }
  const previous = getPriceCents();
  setPriceCents(nextPriceCents);
  return res.json({
    updated: true,
    previous_price_cents: previous,
    price_cents: nextPriceCents,
    price_usd: formatUsdFromCents(nextPriceCents),
  });
});

// Paid tier (gated)
app.get("/v1/markets", requirePayment, (req, res) => {
  const priceCents = getPriceCents();
  res.json({
    payer: req.payer,
    price_cents: priceCents,
    price_usd: formatUsdFromCents(priceCents),
    markets: [
      { id: "pm-1", question: "Will BTC exceed $100k by end of Q1 2026?", probability: 0.72 },
      { id: "pm-2", question: "Will ETH merge to PoS?", probability: 0.95 },
    ],
  });
});

// Only start listening if run directly (not imported by tests)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Polymarket API listening on port ${PORT}`);
  });
}

module.exports = app;
