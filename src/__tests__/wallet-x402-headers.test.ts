import { afterEach, describe, expect, it, vi } from "vitest";
import { x402Fetch } from "../wallet/x402.js";

const TEST_PAYMENT_REQUIRED = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      maxAmountRequired: "10000",
      payToAddress: "0xa2e4B81f2CD154A0857b280754507f369eD685ba",
      requiredDeadlineSeconds: 300,
      usdcAddress: "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca",
    },
  ],
};

function buildResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

describe("x402Fetch header compatibility", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses PAYMENT-REQUIRED and sends PAYMENT-SIGNATURE on retry", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy
      .mockResolvedValueOnce(
        buildResponse(
          402,
          { error: "Payment required" },
          {
            "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(TEST_PAYMENT_REQUIRED)).toString("base64"),
          },
        ),
      )
      .mockResolvedValueOnce(buildResponse(200, { ok: true }));

    const fakeAccount = {
      address: "0x1111111111111111111111111111111111111111",
      signTypedData: vi.fn().mockResolvedValue("0xdeadbeef"),
    } as any;

    const result = await x402Fetch("https://paid.example.com/v1/data", fakeAccount, "GET");

    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const retryHeaders = fetchSpy.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(retryHeaders["PAYMENT-SIGNATURE"]).toBeTruthy();
  });
});
