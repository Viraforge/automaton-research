import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let app;
let tmpDir;
let priceStatePath;
let server;
let baseUrl;

async function loadApp() {
  vi.resetModules();
  const mod = await import("./server.js");
  return mod.default ?? mod;
}

describe("server dynamic pricing", () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-api-price-"));
    priceStatePath = path.join(tmpDir, "price-state.json");
    process.env.PRICE_STATE_PATH = priceStatePath;
    process.env.PRICE_CENTS = "1";
    app = await loadApp();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    delete process.env.PRICE_STATE_PATH;
    delete process.env.PRICE_CENTS;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns boot pricing and exposes it via /v1/pricing", async () => {
    const pricing = await fetch(`${baseUrl}/v1/pricing`);
    expect(pricing.status).toBe(200);
    const pricingJson = await pricing.json();
    expect(pricingJson).toMatchObject({
      price_cents: 1,
      price_usd: "0.01",
    });

    const gated = await fetch(`${baseUrl}/v1/markets`);
    expect(gated.status).toBe(402);
    const gatedJson = await gated.json();
    expect(gatedJson.accepts[0].maxAmountRequired).toBe("10000");
  });

  it("updates price at runtime and persists it", async () => {
    const update = await fetch(`${baseUrl}/v1/admin/pricing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ price_cents: 17 }),
    });
    expect(update.status).toBe(200);
    const updateJson = await update.json();
    expect(updateJson).toMatchObject({
      updated: true,
      previous_price_cents: 1,
      price_cents: 17,
      price_usd: "0.17",
    });

    const gated = await fetch(`${baseUrl}/v1/markets`);
    expect(gated.status).toBe(402);
    const gatedJson = await gated.json();
    expect(gatedJson.accepts[0].maxAmountRequired).toBe("170000");

    const persisted = JSON.parse(fs.readFileSync(priceStatePath, "utf8"));
    expect(persisted.priceCents).toBe(17);
    expect(typeof persisted.updatedAt).toBe("string");
  });

  it("blocks pricing mutation when proxied from non-local client ip", async () => {
    const res = await fetch(`${baseUrl}/v1/admin/pricing`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "8.8.8.8",
      },
      body: JSON.stringify({ price_cents: 9 }),
    });

    expect(res.status).toBe(403);
  });
});
