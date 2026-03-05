const SECRET_KV_PATTERN = /\b([A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE|AUTH|BEARER))\b\s*[:=]\s*([^\s"']+)/g;
const JSON_SECRET_KEY_PATTERN = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|authorization|bearer|secret)$/i;
const JSON_SECRET_PATTERN = /"([A-Za-z0-9_-]+)"\s*:\s*"([^"]+)"/g;
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
  redacted = redacted.replace(JSON_SECRET_PATTERN, (match, key: string, value: string) =>
    JSON_SECRET_KEY_PATTERN.test(key) ? `"${key}":"${maskSecret(value)}"` : match);
  redacted = redacted.replace(AUTH_HEADER_PATTERN, (_match, key: string, value: string) =>
    `${key}: ${maskSecret(value)}`);
  return redacted;
}

