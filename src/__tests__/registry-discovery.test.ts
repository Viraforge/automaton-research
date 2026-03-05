import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAgentCard, isAllowedUri } from "../registry/discovery.js";

describe("registry/discovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses valid base64 data URI agent cards", async () => {
    const card = {
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: "Discovery Scout",
      description: "Finds useful agents",
      services: [{ name: "web", endpoint: "https://example.com" }],
    };
    const encoded = Buffer.from(JSON.stringify(card), "utf8").toString("base64");
    const uri = `data:application/json;base64,${encoded}`;

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const parsed = await fetchAgentCard(uri);

    expect(parsed?.name).toBe("Discovery Scout");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects oversized data URI cards", async () => {
    const card = {
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: "Huge",
      description: "x".repeat(5000),
    };
    const encoded = Buffer.from(JSON.stringify(card), "utf8").toString("base64");
    const uri = `data:application/json;base64,${encoded}`;

    const parsed = await fetchAgentCard(uri, { maxCardSizeBytes: 200 });
    expect(parsed).toBeNull();
  });

  it("keeps non-https/ipfs non-data URIs blocked", () => {
    expect(isAllowedUri("javascript:alert(1)")).toBe(false);
    expect(isAllowedUri("file:///etc/passwd")).toBe(false);
  });
});

