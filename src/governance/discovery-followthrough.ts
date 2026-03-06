import type { ToolCallResult } from "../types.js";

export interface DiscoveryFollowThroughState {
  pendingVenues: string[];
  misses: number;
  detectedAt: string;
}

export interface DiscoveryFollowThroughDecision {
  nextState: DiscoveryFollowThroughState | null;
  injectMessage?: string;
}

const DEFAULT_KNOWN_VENUES = [
  "clawnews",
  "clawdbot",
  "agentdirectory",
  "registry",
];

function containsIgnoreCase(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function extractKnownVenuesFromDiscovery(
  discoveryResult: string,
  knownTargets: string[],
): string[] {
  if (!discoveryResult.trim()) return [];
  const candidates = [...knownTargets, ...DEFAULT_KNOWN_VENUES];
  const venues = new Set<string>();
  for (const candidate of candidates) {
    const normalized = candidate.trim();
    if (!normalized) continue;
    if (containsIgnoreCase(discoveryResult, normalized)) {
      venues.add(normalized);
    }
  }
  return [...venues];
}

function hasFollowThroughAction(toolCalls: ToolCallResult[]): boolean {
  return toolCalls.some((call) =>
    !call.error
    && (call.name === "add_distribution_target"
      || call.name === "send_message"
      || call.name === "record_project_metric"
      || call.name === "register_erc8004"));
}

export function evaluateDiscoveryFollowThrough(
  currentState: DiscoveryFollowThroughState | null,
  toolCalls: ToolCallResult[],
  knownTargets: string[],
  nowIso: string,
): DiscoveryFollowThroughDecision {
  const successfulDiscover = toolCalls.find((call) => call.name === "discover_agents" && !call.error);
  const followThrough = hasFollowThroughAction(toolCalls);

  if (successfulDiscover) {
    const discovered = extractKnownVenuesFromDiscovery(successfulDiscover.result || "", knownTargets);
    if (discovered.length > 0) {
      return {
        nextState: {
          pendingVenues: discovered,
          misses: 0,
          detectedAt: nowIso,
        },
      };
    }
  }

  if (!currentState) {
    return { nextState: null };
  }

  if (followThrough) {
    return { nextState: null };
  }

  const misses = currentState.misses + 1;
  const pendingVenueList = currentState.pendingVenues.slice(0, 3).join(", ");
  if (misses >= 2) {
    return {
      nextState: null,
      injectMessage:
        `DISCOVERY FOLLOW-THROUGH REQUIRED: You discovered known venue(s) (${pendingVenueList}) but still have not executed ` +
        `distribution follow-through after two turns. Immediately add a distribution target, contact/publish, or mark blocked with evidence.`,
    };
  }

  return {
    nextState: { ...currentState, misses },
    injectMessage:
      `DISCOVERY FOLLOW-THROUGH REQUIRED: You discovered known venue(s) (${pendingVenueList}). ` +
      `Next turn must create a distribution target or execute a distribution action.`,
  };
}
