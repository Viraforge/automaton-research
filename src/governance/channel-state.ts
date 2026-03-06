import type { DistributionChannelStatus } from "../types.js";

export interface ChannelTransitionInput {
  channelId: string;
  message: string;
  nowIso?: string;
}

export interface ChannelTransitionResult {
  status: DistributionChannelStatus;
  blockerReason: string | null;
  cooldownUntil: string | null;
}

function addMs(isoNow: string, ms: number): string {
  const t = new Date(isoNow).getTime();
  return new Date(t + Math.max(0, ms)).toISOString();
}

export function classifyChannelTransition(
  input: ChannelTransitionInput,
  opts?: {
    transientCooldownMs?: number;
    quotaResetIso?: string | null;
  },
): ChannelTransitionResult | null {
  const message = input.message || "";
  const nowIso = input.nowIso ?? new Date().toISOString();

  if (/Social relay not configured/i.test(message)) {
    return {
      status: "misconfigured",
      blockerReason: "social relay not configured",
      cooldownUntil: null,
    };
  }

  if (/Insufficient ETH for gas/i.test(message)) {
    return {
      status: "funding_required",
      blockerReason: "insufficient gas funding",
      cooldownUntil: null,
    };
  }

  if (/Weekly\/Monthly Limit Exhausted/i.test(message)) {
    return {
      status: "quota_exhausted",
      blockerReason: "provider quota exhausted",
      cooldownUntil: opts?.quotaResetIso ?? null,
    };
  }

  if (/\b(429|500|502|503|504)\b/i.test(message) || /timeout|ETIMEDOUT/i.test(message)) {
    const cooldownMs = opts?.transientCooldownMs ?? 5 * 60_000;
    return {
      status: "cooldown",
      blockerReason: "transient failure",
      cooldownUntil: addMs(nowIso, cooldownMs),
    };
  }

  return null;
}

export function canUseChannel(
  status: DistributionChannelStatus,
  nowIso?: string,
  cooldownUntil?: string | null,
): boolean {
  const now = new Date(nowIso ?? new Date().toISOString()).getTime();
  const cooldownAt = cooldownUntil ? new Date(cooldownUntil).getTime() : null;
  if (status === "disabled" || status === "blocked_by_policy" || status === "misconfigured" || status === "funding_required") {
    return false;
  }
  if ((status === "cooldown" || status === "quota_exhausted") && cooldownAt != null && Number.isFinite(cooldownAt)) {
    return cooldownAt <= now;
  }
  return status === "ready" || status === "cooldown" || status === "quota_exhausted";
}

