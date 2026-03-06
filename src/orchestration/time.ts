const SQLITE_UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
export const CHILD_LIVENESS_STALE_MS = 30 * 60_000;

export function parseUtcTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;

  const trimmed = value.trim();
  const normalized = SQLITE_UTC_TIMESTAMP_RE.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isChildRecent(
  lastChecked: string | null | undefined,
  createdAt: string | null | undefined,
  nowMs: number = Date.now(),
  staleMs: number = CHILD_LIVENESS_STALE_MS,
): boolean {
  const latest = parseUtcTimestamp(lastChecked) ?? parseUtcTimestamp(createdAt);
  if (latest === null) return false;
  const thresholdMs = Number.isFinite(staleMs) ? Math.max(1, Math.floor(staleMs)) : CHILD_LIVENESS_STALE_MS;
  return nowMs - latest <= thresholdMs;
}
