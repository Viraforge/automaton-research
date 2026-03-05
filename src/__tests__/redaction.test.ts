import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../observability/redaction.js";

describe("redactSensitiveText", () => {
  it("redacts env-style secret assignments", () => {
    const redacted = redactSensitiveText("ZAI_API_KEY=abcdef1234567890");
    expect(redacted).toContain("ZAI_API_KEY=ab***90");
    expect(redacted).not.toContain("abcdef1234567890");
  });

  it("redacts JSON secret values", () => {
    const redacted = redactSensitiveText('{"apiKey":"super-secret-value"}');
    expect(redacted).toContain('"apiKey":"su***ue"');
    expect(redacted).not.toContain("super-secret-value");
  });

  it("redacts authorization header values", () => {
    const redacted = redactSensitiveText("Authorization: Bearer token-value-123456");
    expect(redacted).toContain("Authorization: Be***56");
    expect(redacted).not.toContain("token-value-123456");
  });

  it("does not redact non-secret keys like keyword", () => {
    const redacted = redactSensitiveText('{"keyword":"automation","limit":5}');
    expect(redacted).toContain('"keyword":"automation"');
  });
});

