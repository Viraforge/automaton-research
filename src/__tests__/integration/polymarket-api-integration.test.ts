/**
 * Integration tests for the polymarket-api service.
 *
 * Covers happy path + common failure modes:
 *   - Valid x402 payment → gated content returned
 *   - Invalid payment (expired, wrong payee, malformed) → 402 with error
 *   - Pricing endpoint returns current price
 *   - Admin pricing mutation (local-only)
 *   - Internal token bypass
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";

// Hardhat account #0 — deterministic test key
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ACCOUNT = privateKeyToAccount(TEST_PRIVATE_KEY);
const PAY_TO = "0xa2e4B81f2CD154A0857b280754507f369eD685ba";

const EIP712_DOMAIN = {
  name: "USD Coin",
  version: "2",
  chainId: 8453,
  verifyingContract:
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`,
} as const;

const TRANSFER_WITH_AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function randomNonce(): `0x${string}` {
  return `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;
}

async function signTestPayment(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const defaults = {
    from: TEST_ACCOUNT.address,
    to: PAY_TO as `0x${string}`,
    value: 10000n,
    validAfter: BigInt(now - 60),
    validBefore: BigInt(now + 300),
    nonce: randomNonce(),
  };
  const message = { ...defaults, ...overrides };

  const signature = await TEST_ACCOUNT.signTypedData({
    domain: EIP712_DOMAIN,
    types: TRANSFER_WITH_AUTH_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  });

  return {
    x402Version: 2,
    scheme: "exact",
    network: "eip155:8453",
    payload: {
      signature,
      authorization: {
        from: String(message.from),
        to: String(message.to),
        value: message.value.toString(),
        validAfter: message.validAfter.toString(),
        validBefore: message.validBefore.toString(),
        nonce: message.nonce,
      },
    },
  };
}

function encodePayment(payment: unknown): string {
  return Buffer.from(JSON.stringify(payment)).toString("base64");
}

let server: http.Server;
let baseUrl: string;
let tmpDir: string;

async function loadApp() {
  vi.resetModules();
  const mod = await import(
    // @ts-expect-error — CJS module
    "../../../services/polymarket-api/server.js"
  );
  return mod.default ?? mod;
}

describe("polymarket-api integration", () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-integration-"));
    process.env.PRICE_STATE_PATH = path.join(tmpDir, "price-state.json");
    process.env.PRICE_CENTS = "1";
    process.env.PAY_TO_ADDRESS = PAY_TO;
    process.env.BASE_RPC_URL = "";
    process.env.INTERNAL_API_TOKEN = "";

    const app = await loadApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    delete process.env.PRICE_STATE_PATH;
    delete process.env.PRICE_CENTS;
    delete process.env.PAY_TO_ADDRESS;
    delete process.env.BASE_RPC_URL;
    delete process.env.INTERNAL_API_TOKEN;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  describe("happy path", () => {
    it("returns markets data with valid payment", async () => {
      const payment = await signTestPayment();
      const resp = await fetch(`${baseUrl}/v1/markets`, {
        headers: { "X-Payment": encodePayment(payment) },
      });

      expect(resp.status).toBe(200);
      const data = await resp.json();
      expect(data.payer).toBe(TEST_ACCOUNT.address);
      expect(data.markets).toBeInstanceOf(Array);
      expect(data.markets.length).toBeGreaterThan(0);
      expect(data.markets[0]).toHaveProperty("id");
      expect(data.markets[0]).toHaveProperty("question");
      expect(data.markets[0]).toHaveProperty("probability");
    });

    it("returns correct pricing info", async () => {
      const resp = await fetch(`${baseUrl}/v1/pricing`);
      expect(resp.status).toBe(200);
      const data = await resp.json();
      expect(data.price_cents).toBe(1);
      expect(data.price_usd).toBe("0.01");
    });

    it("returns free-tier data without payment", async () => {
      const resp = await fetch(`${baseUrl}/v1/free-markets`);
      expect(resp.status).toBe(200);
      const data = await resp.json();
      expect(data.markets).toBeInstanceOf(Array);
    });
  });

  describe("payment failure modes", () => {
    it("rejects expired payment (validBefore in past)", async () => {
      const now = Math.floor(Date.now() / 1000);
      const payment = await signTestPayment({
        validBefore: BigInt(now - 100),
      });

      const resp = await fetch(`${baseUrl}/v1/markets`, {
        headers: { "X-Payment": encodePayment(payment) },
      });

      expect(resp.status).toBe(402);
      const body = await resp.json();
      expect(body.error).toContain("expired");
    });

    it("rejects future payment (validAfter in future)", async () => {
      const now = Math.floor(Date.now() / 1000);
      const payment = await signTestPayment({
        validAfter: BigInt(now + 3600),
      });

      const resp = await fetch(`${baseUrl}/v1/markets`, {
        headers: { "X-Payment": encodePayment(payment) },
      });

      expect(resp.status).toBe(402);
      const body = await resp.json();
      expect(body.error).toContain("not yet valid");
    });

    it("rejects malformed base64 header", async () => {
      const resp = await fetch(`${baseUrl}/v1/markets`, {
        headers: { "X-Payment": "not-valid-base64!!!" },
      });

      expect(resp.status).toBe(402);
      const body = await resp.json();
      expect(body.error).toContain("Malformed");
    });

    it("rejects request with no payment header", async () => {
      const resp = await fetch(`${baseUrl}/v1/markets`);
      expect(resp.status).toBe(402);

      const body = await resp.json();
      expect(body.x402Version).toBe(2);
      expect(body.accepts).toBeInstanceOf(Array);
      expect(body.accepts[0].scheme).toBe("exact");
    });

    it("rejects payment with wrong payee address", async () => {
      const wrongPayee = "0x0000000000000000000000000000000000000001";
      const payment = await signTestPayment({
        to: wrongPayee as `0x${string}`,
      });
      // Fix the authorization to match the signed message
      payment.payload.authorization.to = wrongPayee;

      const resp = await fetch(`${baseUrl}/v1/markets`, {
        headers: { "X-Payment": encodePayment(payment) },
      });

      expect(resp.status).toBe(402);
      const body = await resp.json();
      expect(body.error).toContain("Wrong payee");
    });

    it("rejects payment with missing signature", async () => {
      const payment = await signTestPayment();
      delete (payment.payload as any).signature;

      const resp = await fetch(`${baseUrl}/v1/markets`, {
        headers: { "X-Payment": encodePayment(payment) },
      });

      expect(resp.status).toBe(402);
      const body = await resp.json();
      expect(body.error).toContain("missing signature");
    });

    it("rejects insufficient payment amount", async () => {
      const payment = await signTestPayment({ value: 1n });

      const resp = await fetch(`${baseUrl}/v1/markets`, {
        headers: { "X-Payment": encodePayment(payment) },
      });

      expect(resp.status).toBe(402);
      const body = await resp.json();
      expect(body.error).toContain("Insufficient payment");
    });
  });

  describe("internal token bypass", () => {
    it("allows access with valid internal token", async () => {
      // Restart server with INTERNAL_API_TOKEN set
      if (server?.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      process.env.INTERNAL_API_TOKEN = "test-secret-token";
      const app = await loadApp();
      server = http.createServer(app);
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;

      const resp = await fetch(`${baseUrl}/v1/markets`, {
        headers: { "X-Internal-Token": "test-secret-token" },
      });

      expect(resp.status).toBe(200);
      const data = await resp.json();
      expect(data.payer).toBe("internal");
    });

    it("rejects access with wrong internal token", async () => {
      if (server?.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      process.env.INTERNAL_API_TOKEN = "test-secret-token";
      const app = await loadApp();
      server = http.createServer(app);
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;

      const resp = await fetch(`${baseUrl}/v1/markets`, {
        headers: { "X-Internal-Token": "wrong-token" },
      });

      expect(resp.status).toBe(402);
    });
  });

  describe("admin pricing", () => {
    it("updates price from local request", async () => {
      const resp = await fetch(`${baseUrl}/v1/admin/pricing`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ price_cents: 5 }),
      });

      expect(resp.status).toBe(200);
      const data = await resp.json();
      expect(data.updated).toBe(true);
      expect(data.price_cents).toBe(5);
      expect(data.previous_price_cents).toBe(1);

      // Verify updated price is reflected in 402 response
      const gated = await fetch(`${baseUrl}/v1/markets`);
      expect(gated.status).toBe(402);
      const gatedBody = await gated.json();
      expect(gatedBody.accepts[0].maxAmountRequired).toBe("50000"); // 5 cents * 10000
    });

    it("rejects invalid price values", async () => {
      const resp = await fetch(`${baseUrl}/v1/admin/pricing`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ price_cents: -1 }),
      });

      expect(resp.status).toBe(400);
    });

    it("rejects pricing update from proxied external IP", async () => {
      const resp = await fetch(`${baseUrl}/v1/admin/pricing`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "8.8.8.8",
        },
        body: JSON.stringify({ price_cents: 99 }),
      });

      expect(resp.status).toBe(403);
    });
  });

  describe("402 response format", () => {
    it("includes both standard and legacy payment-required headers", async () => {
      const resp = await fetch(`${baseUrl}/v1/markets`);
      expect(resp.status).toBe(402);
      expect(resp.headers.get("payment-required")).toBeTruthy();
      expect(resp.headers.get("x-payment-required")).toBeTruthy();
    });

    it("payment-required body contains valid x402 structure", async () => {
      const resp = await fetch(`${baseUrl}/v1/markets`);
      const body = await resp.json();

      expect(body.x402Version).toBe(2);
      expect(body.accepts).toBeInstanceOf(Array);
      expect(body.accepts[0]).toMatchObject({
        scheme: "exact",
        network: "eip155:8453",
        payToAddress: PAY_TO,
        requiredDeadlineSeconds: 300,
      });
    });
  });
});
