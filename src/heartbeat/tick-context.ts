/**
 * Tick Context
 *
 * Builds a shared context for each heartbeat tick.
 * Fetches USDC balance ONCE per tick and shares across all tasks
 * to avoid redundant API calls.
 */

import type BetterSqlite3 from "better-sqlite3";
import type { Address } from "viem";
import type {
  HeartbeatConfig,
  TickContext,
} from "../types.js";
import { getUsdcBalance } from "../wallet/x402.js";
import { createLogger } from "../observability/logger.js";

type DatabaseType = BetterSqlite3.Database;
const logger = createLogger("heartbeat.tick");

let counter = 0;
function generateTickId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  counter++;
  return `${timestamp}-${random}-${counter.toString(36)}`;
}

/**
 * Build a TickContext for the current tick.
 *
 * - Generates a unique tickId
 * - In sovereign mode: fetches USDC balance ONLY, derives tier from USDC
 * - In legacy mode: fetches both credits and USDC, derives tier from credits
 * - Reads lowComputeMultiplier from config
 */
export async function buildTickContext(
  db: DatabaseType,
  config: HeartbeatConfig,
  walletAddress?: Address,
): Promise<TickContext> {
  const tickId = generateTickId();
  const startedAt = new Date();

  let creditBalance = 0;
  let usdcBalance = 0;

  // Always use USDC (Conway removed)
  if (walletAddress) {
    try {
      usdcBalance = await getUsdcBalance(walletAddress);
    } catch (err: any) {
      logger.error("Failed to fetch USDC balance", err instanceof Error ? err : undefined);
    }
  }
  // Convert USDC to cents for creditBalance compatibility
  creditBalance = Math.round(usdcBalance * 100);

  // Wallet balance is for optional x402 payments only.
  // Do not throttle heartbeat tasks based on zero wallet balance.
  const survivalTier = "normal"; // Wallet funds are optional; don't throttle heartbeat
  const lowComputeMultiplier = config.lowComputeMultiplier ?? 4;

  return {
    tickId,
    startedAt,
    creditBalance,
    usdcBalance,
    survivalTier,
    lowComputeMultiplier,
    config,
    db,
  };
}
