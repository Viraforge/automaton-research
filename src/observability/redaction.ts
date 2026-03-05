const SECRET_KV_PATTERN = /\b([A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE|AUTH|BEARER))\b\s*[:=]\s*([^\s"']+)/g;
const JSON_SECRET_PATTERN = /"([A-Za-z0-9_]*(?:key|token|secret|password|cookie|auth)[A-Za-z0-9_]*)"\s*:\s*"([^"]+)"/gi;
const AUTH_HEADER_PATTERN = /\b(Authorization)\b\s*:\s*([^\r\n]+)/gi;

function maskSecret(raw: string): string {
  if (!raw) return "[REDACTED]";
  if (raw.length <= 8) return "[REDACTED]";
  return `${raw.slice(0, 2)}***${raw.slice(-2)}`;
}

export function redactSensitiveText(text: string): string {
  if (!text) return text;

  let redacted = text;
  redacted = redacted.replace(SECRET_KV_PATTERN, (_match, key: string, value: string) =>
    `${key}=${maskSecret(value)}`);
  redacted = redacted.replace(JSON_SECRET_PATTERN, (_match, key: string, value: string) =>
    `"${key}":"${maskSecret(value)}"`);
  redacted = redacted.replace(AUTH_HEADER_PATTERN, (_match, key: string, value: string) =>
    `${key}: ${maskSecret(value)}`);
  return redacted;
}

