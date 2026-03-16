/**
 * End-to-end x402 Payment Flow Tests
 *
 * Exercises the full x402 payment path:
 *   1. Client sends request → gets HTTP 402 with payment requirements
 *   2. Client signs EIP-712 payment authorization
 *   3. Client retries with PAYMENT-SIGNATURE header
 *   4. Server verifies signature and returns gated content
 *
 * Uses the real polymarket-api server and the real x402Fetch client
 * with a test wallet (Hardhat account #0). No real funds needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem";

// Hardhat account #0 — deterministic test key, NEVER use in production
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

let server: http.Server;
let baseUrl: string;
let testAccount: PrivateKeyAccount;

async function loadPolymarketApp() {
  vi.resetModules();
  const mod = await import(
    // @ts-expect-error — CJS module from services/polymarket-api
    "../../services/polymarket-api/server.js"
  );
  return mod.default ?? mod;
}

describe("x402 e2e payment flow", () => {
  beforeEach(async () => {
    // Configure server for test environment
    process.env.PRICE_CENTS = "1";
    process.env.PAY_TO_ADDRESS =
      "0xa2e4B81f2CD154A0857b280754507f369eD685ba";
    process.env.BASE_RPC_URL = ""; // skip on-chain balance check in tests

    const app = await loadPolymarketApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
    testAccount = privateKeyToAccount(TEST_PRIVATE_KEY);
  });

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    delete process.env.PRICE_CENTS;
    delete process.env.PAY_TO_ADDRESS;
    delete process.env.BASE_RPC_URL;
    vi.restoreAllMocks();
  });

  it("completes full payment: 402 → sign → retry → gated content", async () => {
    // Step 1: Request gated endpoint without payment — expect 402
    const initialResp = await fetch(`${baseUrl}/v1/markets`);
    expect(initialResp.status).toBe(402);

    // Step 2: Parse payment requirements from 402 response
    const paymentRequiredHeader = initialResp.headers.get("payment-required");
    expect(paymentRequiredHeader).toBeTruthy();

    const paymentRequired = JSON.parse(
      Buffer.from(paymentRequiredHeader!, "base64").toString("utf-8"),
    );
    expect(paymentRequired.x402Version).toBe(2);
    expect(paymentRequired.accepts).toHaveLength(1);

    const requirement = paymentRequired.accepts[0];
    expect(requirement.scheme).toBe("exact");
    expect(requirement.network).toBe("eip155:8453");
    expect(requirement.payToAddress).toBe(process.env.PAY_TO_ADDRESS);

    // Step 3: Sign EIP-712 payment authorization
    const now = Math.floor(Date.now() / 1000);
    const nonce = `0x${Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString("hex")}` as `0x${string}`;

    const amount = BigInt(requirement.maxAmountRequired);
    const message = {
      from: testAccount.address,
      to: requirement.payToAddress as `0x${string}`,
      value: amount,
      validAfter: BigInt(now - 60),
      validBefore: BigInt(now + 300),
      nonce,
    };

    const signature = await testAccount.signTypedData({
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 8453,
        verifyingContract: requirement.usdcAddress as `0x${string}`,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message,
    });

    // Step 4: Build payment payload and retry with signature
    const payment = {
      x402Version: 2,
      scheme: "exact",
      network: "eip155:8453",
      payload: {
        signature,
        authorization: {
          from: testAccount.address,
          to: requirement.payToAddress,
          value: amount.toString(),
          validAfter: message.validAfter.toString(),
          validBefore: message.validBefore.toString(),
          nonce,
        },
      },
    };

    const paymentHeader = Buffer.from(JSON.stringify(payment)).toString(
      "base64",
    );
    const paidResp = await fetch(`${baseUrl}/v1/markets`, {
      headers: {
        "X-Payment": paymentHeader,
      },
    });

    // Step 5: Verify gated content is returned
    expect(paidResp.status).toBe(200);
    const data = await paidResp.json();
    expect(data.payer).toBe(testAccount.address);
    expect(data.markets).toBeDefined();
    expect(data.markets.length).toBeGreaterThan(0);
    expect(data.price_cents).toBe(1);
  });

  it("rejects replayed payment (same nonce)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const nonce = `0x${Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString("hex")}` as `0x${string}`;

    const message = {
      from: testAccount.address,
      to: process.env.PAY_TO_ADDRESS! as `0x${string}`,
      value: 10000n,
      validAfter: BigInt(now - 60),
      validBefore: BigInt(now + 300),
      nonce,
    };

    const signature = await testAccount.signTypedData({
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 8453,
        verifyingContract:
          "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message,
    });

    const payment = {
      x402Version: 2,
      scheme: "exact",
      network: "eip155:8453",
      payload: {
        signature,
        authorization: {
          from: testAccount.address,
          to: process.env.PAY_TO_ADDRESS,
          value: "10000",
          validAfter: message.validAfter.toString(),
          validBefore: message.validBefore.toString(),
          nonce,
        },
      },
    };

    const paymentHeader = Buffer.from(JSON.stringify(payment)).toString(
      "base64",
    );

    // First request: should succeed
    const resp1 = await fetch(`${baseUrl}/v1/markets`, {
      headers: { "X-Payment": paymentHeader },
    });
    expect(resp1.status).toBe(200);

    // Second request with same nonce: should be rejected (replay)
    const resp2 = await fetch(`${baseUrl}/v1/markets`, {
      headers: { "X-Payment": paymentHeader },
    });
    expect(resp2.status).toBe(402);
    const body = await resp2.json();
    expect(body.error).toContain("replay");
  });

  it("rejects insufficient payment amount", async () => {
    const now = Math.floor(Date.now() / 1000);
    const nonce = `0x${Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString("hex")}` as `0x${string}`;

    // Sign for 1 atomic unit (way below 1 cent = 10000 atomic units)
    const message = {
      from: testAccount.address,
      to: process.env.PAY_TO_ADDRESS! as `0x${string}`,
      value: 1n,
      validAfter: BigInt(now - 60),
      validBefore: BigInt(now + 300),
      nonce,
    };

    const signature = await testAccount.signTypedData({
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 8453,
        verifyingContract:
          "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message,
    });

    const payment = {
      x402Version: 2,
      scheme: "exact",
      network: "eip155:8453",
      payload: {
        signature,
        authorization: {
          from: testAccount.address,
          to: process.env.PAY_TO_ADDRESS,
          value: "1",
          validAfter: message.validAfter.toString(),
          validBefore: message.validBefore.toString(),
          nonce,
        },
      },
    };

    const paymentHeader = Buffer.from(JSON.stringify(payment)).toString(
      "base64",
    );
    const resp = await fetch(`${baseUrl}/v1/markets`, {
      headers: { "X-Payment": paymentHeader },
    });

    expect(resp.status).toBe(402);
    const body = await resp.json();
    expect(body.error).toContain("Insufficient payment");
  });

  it("returns free-tier content without payment", async () => {
    const resp = await fetch(`${baseUrl}/v1/free-markets`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.markets).toBeDefined();
    expect(data.markets.length).toBeGreaterThan(0);
  });

  it("health endpoint is accessible without payment", async () => {
    const resp = await fetch(`${baseUrl}/health`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.status).toBe("ok");
  });
});
