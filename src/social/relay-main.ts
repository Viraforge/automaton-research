/**
 * Social Relay Process Entrypoint
 *
 * Starts the sovereign social relay as a standalone process for production
 * deployment behind a reverse proxy (for example relay.compintel.co).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRelayServer } from "./relay-server.js";

function resolveDbPath(): string {
  const fromEnv = process.env.RELAY_DB_PATH?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return path.join(os.homedir(), ".automaton", "relay", "social-relay.db");
}

function resolvePort(): number {
  const raw = process.env.RELAY_PORT?.trim();
  if (!raw) {
    return 8787;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`Invalid RELAY_PORT: ${raw}`);
  }
  return n;
}

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  const port = resolvePort();

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const relay = createRelayServer({
    port,
    dbPath,
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[relay] received ${signal}; shutting down`);
    await relay.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await relay.start();
  console.log(`[relay] started on :${port}`);
  console.log(`[relay] db: ${dbPath}`);
}

main().catch((error) => {
  console.error("[relay] fatal:", error);
  process.exit(1);
});

