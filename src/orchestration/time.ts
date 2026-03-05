const SQLITE_UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export function parseUtcTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;

  const trimmed = value.trim();
  const normalized = SQLITE_UTC_TIMESTAMP_RE.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
