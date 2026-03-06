import os from "node:os";
import path from "node:path";
import type { AutomatonConfig, DistributionChannelStatus } from "../types.js";
import type { Database as SqliteDatabase } from "better-sqlite3";
import type { DistributionChannelRow } from "../state/database.js";
import {
  getDistributionChannel,
  listDistributionChannels,
  markDistributionChannelStatus,
  upsertDistributionChannel,
} from "../state/database.js";
import { canUseChannel, classifyChannelTransition } from "../governance/channel-state.js";

export const DISTRIBUTION_CHANNEL_IDS = {
  socialRelay: "social_relay",
  erc8004: "erc8004_registry",
  discovery: "agent_discovery",
  byokInference: "byok_inference",
} as const;

type KnownChannelId = (typeof DISTRIBUTION_CHANNEL_IDS)[keyof typeof DISTRIBUTION_CHANNEL_IDS];

function nowIso(): string {
  return new Date().toISOString();
}

function defaultOperatorTargetsPath(): string {
  return path.join(os.homedir(), ".automaton", "distribution-targets.json");
}

export function ensureCoreDistributionChannels(
  db: SqliteDatabase,
  config?: AutomatonConfig,
): void {
  const existingSocial = getDistributionChannel(db, DISTRIBUTION_CHANNEL_IDS.socialRelay);
  upsertDistributionChannel(db, {
    id: DISTRIBUTION_CHANNEL_IDS.socialRelay,
    name: "Social Relay Messaging",
    channelType: "messaging",
    requiresConfig: true,
    supportsMessaging: true,
    supportsPublish: false,
    supportsListing: false,
    status: existingSocial?.status ?? (config?.socialRelayUrl ? "ready" : "misconfigured"),
    blockerReason: existingSocial?.blockerReason ?? (config?.socialRelayUrl ? null : "social relay not configured"),
    cooldownUntil: existingSocial?.cooldownUntil ?? null,
    lastCheckedAt: nowIso(),
  });

  const existingErc8004 = getDistributionChannel(db, DISTRIBUTION_CHANNEL_IDS.erc8004);
  upsertDistributionChannel(db, {
    id: DISTRIBUTION_CHANNEL_IDS.erc8004,
    name: "ERC-8004 Registry",
    channelType: "onchain_registry",
    requiresFunding: true,
    supportsListing: true,
    supportsMessaging: false,
    supportsPublish: true,
    status: existingErc8004?.status ?? "ready",
    blockerReason: existingErc8004?.blockerReason ?? null,
    cooldownUntil: existingErc8004?.cooldownUntil ?? null,
    lastCheckedAt: nowIso(),
  });

  const existingDiscovery = getDistributionChannel(db, DISTRIBUTION_CHANNEL_IDS.discovery);
  upsertDistributionChannel(db, {
    id: DISTRIBUTION_CHANNEL_IDS.discovery,
    name: "Agent Discovery",
    channelType: "discovery",
    supportsListing: true,
    supportsMessaging: false,
    supportsPublish: false,
    status: existingDiscovery?.status ?? "ready",
    blockerReason: existingDiscovery?.blockerReason ?? null,
    cooldownUntil: existingDiscovery?.cooldownUntil ?? null,
    lastCheckedAt: nowIso(),
  });

  const existingByok = getDistributionChannel(db, DISTRIBUTION_CHANNEL_IDS.byokInference);
  upsertDistributionChannel(db, {
    id: DISTRIBUTION_CHANNEL_IDS.byokInference,
    name: "BYOK Inference",
    channelType: "inference",
    supportsPublish: false,
    supportsMessaging: false,
    supportsListing: false,
    status: existingByok?.status ?? "ready",
    blockerReason: existingByok?.blockerReason ?? null,
    cooldownUntil: existingByok?.cooldownUntil ?? null,
    lastCheckedAt: nowIso(),
  });

  // Ensure a stable config default for operator target loading.
  if (!config?.distribution?.operatorTargetsPath) {
    config && (config.distribution = {
      ...(config.distribution ?? {}),
      operatorTargetsPath: defaultOperatorTargetsPath(),
    });
  }
}

function maybeAutoRecover(
  db: SqliteDatabase,
  row: DistributionChannelRow,
  config?: AutomatonConfig,
  now: string = nowIso(),
): DistributionChannelRow {
  if (row.id === DISTRIBUTION_CHANNEL_IDS.socialRelay && row.status === "misconfigured" && config?.socialRelayUrl) {
    markDistributionChannelStatus(db, row.id, "ready", {
      blockerReason: null,
      cooldownUntil: null,
      lastCheckedAt: now,
    });
    const refreshed = getDistributionChannel(db, row.id);
    return refreshed ?? row;
  }

  if ((row.status === "cooldown" || row.status === "quota_exhausted") && row.cooldownUntil) {
    const untilMs = Date.parse(row.cooldownUntil);
    if (Number.isFinite(untilMs) && untilMs <= Date.now()) {
      markDistributionChannelStatus(db, row.id, "ready", {
        blockerReason: null,
        cooldownUntil: null,
        lastCheckedAt: now,
      });
      const refreshed = getDistributionChannel(db, row.id);
      return refreshed ?? row;
    }
  }

  return row;
}

export function getChannelUseDecision(
  db: SqliteDatabase,
  channelId: KnownChannelId | string,
  config?: AutomatonConfig,
): { allowed: boolean; status: DistributionChannelStatus; reason: string | null } {
  ensureCoreDistributionChannels(db, config);
  const row = getDistributionChannel(db, channelId);
  if (!row) {
    return { allowed: true, status: "ready", reason: null };
  }

  const refreshed = maybeAutoRecover(db, row, config);
  const allowed = canUseChannel(refreshed.status, nowIso(), refreshed.cooldownUntil);
  const reason = allowed
    ? null
    : (refreshed.blockerReason || `channel unavailable (${refreshed.status})`);
  return { allowed, status: refreshed.status, reason };
}

function parseProviderResetTimestamp(message: string): string | null {
  const isoMatch = message.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/);
  if (isoMatch) return isoMatch[1] ?? null;

  const plainMatch = message.match(/\b(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\b/);
  if (!plainMatch) return null;
  const [, y, m, d, hh, mm, ss] = plainMatch;
  const utcMs = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
  return Number.isFinite(utcMs) ? new Date(utcMs).toISOString() : null;
}

export function recordChannelOutcome(
  db: SqliteDatabase,
  channelId: KnownChannelId | string,
  message: string,
  config?: AutomatonConfig,
): void {
  ensureCoreDistributionChannels(db, config);
  const now = nowIso();
  const resetIso = parseProviderResetTimestamp(message);
  const transition = classifyChannelTransition(
    { channelId, message, nowIso: now },
    {
      transientCooldownMs: config?.distribution?.channelCooldownDefaultMs ?? 5 * 60_000,
      quotaResetIso: resetIso,
    },
  );
  if (!transition) return;
  markDistributionChannelStatus(db, channelId, transition.status, {
    blockerReason: transition.blockerReason,
    cooldownUntil: transition.cooldownUntil,
    lastCheckedAt: now,
  });
}

export function listDistributionChannelsWithRecovery(
  db: SqliteDatabase,
  config?: AutomatonConfig,
): DistributionChannelRow[] {
  ensureCoreDistributionChannels(db, config);
  const now = nowIso();
  const rows = listDistributionChannels(db);
  return rows.map((row) => maybeAutoRecover(db, row, config, now));
}
