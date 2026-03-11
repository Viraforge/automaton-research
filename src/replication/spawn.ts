/**
 * Spawn
 *
 * Spawn child automatons in new VPS instances (Vultr) or Conway sandboxes.
 * Uses the lifecycle state machine for tracked transitions.
 * Cleans up compute resources on ANY failure after creation.
 */

import type {
  ConwayClient,
  AutomatonIdentity,
  AutomatonConfig,
  AutomatonDatabase,
  GenesisConfig,
  ChildAutomaton,
} from "../types.js";
import type { ChildLifecycle } from "./lifecycle.js";
import type { ComputeProvider, SshCredential } from "../providers/types.js";
import { ulid } from "ulid";
import { propagateConstitution, propagateConstitutionSsh } from "./constitution.js";

/** Valid Conway sandbox pricing tiers. */
const SANDBOX_TIERS = [
  { memoryMb: 512,  vcpu: 1, diskGb: 5 },
  { memoryMb: 1024, vcpu: 1, diskGb: 10 },
  { memoryMb: 2048, vcpu: 2, diskGb: 20 },
  { memoryMb: 4096, vcpu: 2, diskGb: 40 },
  { memoryMb: 8192, vcpu: 4, diskGb: 80 },
];

/** Find the smallest valid tier that has at least the requested memory. */
function selectSandboxTier(requestedMemoryMb: number) {
  return SANDBOX_TIERS.find((t) => t.memoryMb >= requestedMemoryMb) ?? SANDBOX_TIERS[SANDBOX_TIERS.length - 1];
}

function readRuntimeNumber(
  db: AutomatonDatabase,
  key: string,
  fallback: number,
): number {
  const raw = db.getKV(key);
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  const legacy = Number((db as any).config?.[key.replace("runtime.", "")]);
  if (Number.isFinite(legacy)) return legacy;
  return fallback;
}

/**
 * Validate that an address is a well-formed, non-zero Ethereum wallet address.
 */
export function isValidWalletAddress(address: string): boolean {
  return (
    /^0x[a-fA-F0-9]{40}$/.test(address) && address !== "0x" + "0".repeat(40)
  );
}

/**
 * Spawn a child automaton in a new compute environment.
 * In sovereign mode uses Vultr VPS; in legacy mode uses Conway sandbox.
 */
export async function spawnChild(
  conway: ConwayClient,
  identity: AutomatonIdentity,
  db: AutomatonDatabase,
  genesis: GenesisConfig,
  lifecycle?: ChildLifecycle,
  compute?: ComputeProvider,
): Promise<ChildAutomaton> {
  if (compute && lifecycle) {
    return spawnChildSovereign(compute, identity, db, genesis, lifecycle);
  }
  return spawnChildConway(conway, identity, db, genesis, lifecycle);
}

/**
 * Spawn a child automaton in a Vultr VPS instance.
 */
async function spawnChildSovereign(
  compute: ComputeProvider,
  identity: AutomatonIdentity,
  db: AutomatonDatabase,
  genesis: GenesisConfig,
  lifecycle: ChildLifecycle,
): Promise<ChildAutomaton> {
  // Count only "viable" children (those that might succeed, not cleanup/terminal states)
  // Excludes new states: dead, cleaned_up, failed, stopped, unhealthy (will be auto-stopped)
  // Excludes old/legacy states: errored, error
  const existing = db.getChildren().filter((c) => {
    const nonViableStates = ["dead", "cleaned_up", "failed", "stopped", "unhealthy", "errored", "error"];
    return !nonViableStates.includes(c.status);
  });
  const maxChildren = readRuntimeNumber(db, "runtime.maxChildren", 3);
  if (existing.length >= maxChildren) {
    throw new Error(
      `Cannot spawn: already at max children (${maxChildren}). Active: ${existing.length}. Kill or wait for existing children to complete.`,
    );
  }

  const childId = ulid();
  let instanceId: string | undefined;

  try {
    lifecycle.initChild(childId, genesis.name, "", genesis.genesisPrompt);

    // Create Vultr instance
    const label = `automaton-child-${genesis.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
    const instance = await compute.createInstance({ label });
    instanceId = instance.id;

    db.raw.prepare("UPDATE children SET sandbox_id = ? WHERE id = ?").run(instance.id, childId);
    lifecycle.transition(childId, "sandbox_created", `instance ${instance.id} created`);

    // Wait for active + get SSH credentials
    const active = await compute.waitForActive(instance.id);
    const credential: SshCredential = active.defaultPassword
      ? { type: "password", password: active.defaultPassword }
      : { type: "key" };

    // Install runtime via SSH
    await compute.sshExec(active.mainIp, credential, "apt-get update -qq && apt-get install -y -qq nodejs npm git curl", 120_000);
    await compute.sshExec(active.mainIp, credential, "npm install -g @conway/automaton@latest 2>/dev/null || true", 60_000);

    // Write genesis config
    const genesisJson = JSON.stringify({
      name: genesis.name,
      genesisPrompt: genesis.genesisPrompt,
      creatorMessage: genesis.creatorMessage,
      creatorAddress: identity.address,
      parentAddress: identity.address,
    }, null, 2);
    await compute.sshExec(active.mainIp, credential, "mkdir -p /root/.automaton", 10_000);
    await compute.sshWriteFile(active.mainIp, credential, "/root/.automaton/genesis.json", genesisJson);

    // Propagate constitution via SSH
    try {
      await propagateConstitutionSsh(compute, active.mainIp, credential, instance.id, db.raw);
    } catch {
      // Constitution file not found locally
    }

    lifecycle.transition(childId, "runtime_ready", "runtime installed");

    // Initialize child wallet
    const initResult = await compute.sshExec(active.mainIp, credential, "automaton --init 2>&1", 60_000);
    const walletMatch = (initResult.stdout || "").match(/0x[a-fA-F0-9]{40}/);
    const childWallet = walletMatch ? walletMatch[0] : "";

    if (!isValidWalletAddress(childWallet)) {
      throw new Error(`Child wallet address invalid: ${childWallet}`);
    }

    db.raw.prepare("UPDATE children SET address = ? WHERE id = ?").run(childWallet, childId);
    lifecycle.transition(childId, "wallet_verified", `wallet ${childWallet} verified`);

    db.insertModification({
      id: ulid(),
      timestamp: new Date().toISOString(),
      type: "child_spawn",
      description: `Spawned child: ${genesis.name} on instance ${instance.id} (${active.mainIp})`,
      reversible: false,
    });

    return {
      id: childId,
      name: genesis.name,
      address: childWallet as any,
      sandboxId: instance.id,
      genesisPrompt: genesis.genesisPrompt,
      creatorMessage: genesis.creatorMessage,
      fundedAmountCents: 0,
      status: "wallet_verified" as any,
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    if (instanceId) {
      try { await compute.destroyInstance(instanceId); } catch { /* suppress cleanup errors */ }
    }
    try {
      lifecycle.transition(childId, "failed", error instanceof Error ? error.message : String(error));
    } catch { /* may fail if child doesn't exist yet */ }
    throw error;
  }
}

/**
 * Spawn a child automaton in a Conway sandbox using lifecycle state machine.
 */
async function spawnChildConway(
  conway: ConwayClient,
  identity: AutomatonIdentity,
  db: AutomatonDatabase,
  genesis: GenesisConfig,
  lifecycle?: ChildLifecycle,
): Promise<ChildAutomaton> {
  // Count only "viable" children (those that might succeed, not cleanup/terminal states)
  // Excludes new states: dead, cleaned_up, failed, stopped, unhealthy (will be auto-stopped)
  // Excludes old/legacy states: errored, error
  const existing = db.getChildren().filter((c) => {
    const nonViableStates = ["dead", "cleaned_up", "failed", "stopped", "unhealthy", "errored", "error"];
    return !nonViableStates.includes(c.status);
  });
  const maxChildren = readRuntimeNumber(db, "runtime.maxChildren", 3);
  if (existing.length >= maxChildren) {
    throw new Error(
      `Cannot spawn: already at max children (${maxChildren}). Active: ${existing.length}. Kill or wait for existing children to complete.`,
    );
  }

  const childId = ulid();
  let sandboxId: string | undefined;
  let reusedSandbox: { id: string } | null = null;

  // If no lifecycle provided, use legacy path
  if (!lifecycle) {
    return spawnChildLegacy(conway, identity, db, genesis, childId);
  }

  try {
    // State: requested
    lifecycle.initChild(childId, genesis.name, "", genesis.genesisPrompt);

    // Get child sandbox memory from config (default 1024MB)
    const childMemoryMb = readRuntimeNumber(db, "runtime.childSandboxMemoryMb", 1024);

    // Try to reuse an existing sandbox whose DB record is 'failed' but
    // is still running remotely, before creating a new one.
    reusedSandbox = await findReusableSandbox(conway, db);

    const tier = selectSandboxTier(childMemoryMb);

    let sandbox: { id: string };
    if (reusedSandbox) {
      sandbox = reusedSandbox;
    } else {
      sandbox = await conway.createSandbox({
        name: `automaton-child-${genesis.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
        vcpu: tier.vcpu,
        memoryMb: tier.memoryMb,
        diskGb: tier.diskGb,
      });
    }
    sandboxId = sandbox.id;

    // Create a scoped client so all exec/writeFile calls target the CHILD sandbox
    const childConway = conway.createScopedClient(sandbox.id);

    // Update sandbox ID in children table
    db.raw
      .prepare("UPDATE children SET sandbox_id = ? WHERE id = ?")
      .run(sandbox.id, childId);

    // State: sandbox_created
    lifecycle.transition(
      childId,
      "sandbox_created",
      `sandbox ${sandbox.id} created`,
    );

    // Install runtime (on the CHILD sandbox)
    await childConway.exec("apt-get update -qq && apt-get install -y -qq nodejs npm git curl", 120_000);
    await childConway.exec(
      "git clone https://github.com/Conway-Research/automaton.git /root/automaton && cd /root/automaton && npm install && npm run build",
      180_000,
    );

    // Write genesis configuration (on the CHILD sandbox)
    await childConway.exec("mkdir -p /root/.automaton", 10_000);
    const genesisJson = JSON.stringify(
      {
        name: genesis.name,
        genesisPrompt: genesis.genesisPrompt,
        creatorMessage: genesis.creatorMessage,
        creatorAddress: identity.address,
        parentAddress: identity.address,
      },
      null,
      2,
    );
    await childConway.writeFile("/root/.automaton/genesis.json", genesisJson);

    // Propagate constitution with hash verification
    try {
      await propagateConstitution(childConway, sandbox.id, db.raw);
    } catch {
      // Constitution file not found locally
    }

    // State: runtime_ready
    lifecycle.transition(childId, "runtime_ready", "runtime installed");

    // Initialize child wallet (on the CHILD sandbox)
    const initResult = await childConway.exec("node /root/automaton/dist/index.js --init 2>&1", 60_000);
    const walletMatch = (initResult.stdout || "").match(/0x[a-fA-F0-9]{40}/);
    const childWallet = walletMatch ? walletMatch[0] : "";

    if (!isValidWalletAddress(childWallet)) {
      throw new Error(`Child wallet address invalid: ${childWallet}`);
    }

    // Update address in children table
    db.raw
      .prepare("UPDATE children SET address = ? WHERE id = ?")
      .run(childWallet, childId);

    // State: wallet_verified
    lifecycle.transition(
      childId,
      "wallet_verified",
      `wallet ${childWallet} verified`,
    );

    // Record spawn modification
    db.insertModification({
      id: ulid(),
      timestamp: new Date().toISOString(),
      type: "child_spawn",
      description: `Spawned child: ${genesis.name} in sandbox ${sandbox.id}${reusedSandbox ? " (reused)" : ""}`,
      reversible: false,
    });

    // If we reused a sandbox, update the old children record to 'cleaned_up'
    // so it doesn't get reused again.
    if (reusedSandbox) {
      db.raw.prepare(
        "UPDATE children SET status = 'cleaned_up' WHERE sandbox_id = ? AND status = 'failed'",
      ).run(sandbox.id);
    }

    const child: ChildAutomaton = {
      id: childId,
      name: genesis.name,
      address: childWallet as any,
      sandboxId: sandbox.id,
      genesisPrompt: genesis.genesisPrompt,
      creatorMessage: genesis.creatorMessage,
      fundedAmountCents: 0,
      status: "wallet_verified" as any,
      createdAt: new Date().toISOString(),
    };

    return child;
  } catch (error) {
    // Note: sandbox deletion is disabled by the Conway API (prepaid, non-refundable).
    // Failed sandboxes are left running and may be reused by findReusableSandbox().

    // Transition to failed if lifecycle has been initialized
    try {
      lifecycle.transition(
        childId,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
    } catch {
      // May fail if child doesn't exist yet
    }

    throw error;
  }
}

/**
 * Legacy spawn path for backward compatibility when no lifecycle is provided.
 */
async function spawnChildLegacy(
  conway: ConwayClient,
  identity: AutomatonIdentity,
  db: AutomatonDatabase,
  genesis: GenesisConfig,
  childId: string,
): Promise<ChildAutomaton> {
  let sandboxId: string | undefined;

  // Get child sandbox memory from config (default 1024MB)
  const childMemoryMb = readRuntimeNumber(db, "runtime.childSandboxMemoryMb", 1024);

  const legacyTier = selectSandboxTier(childMemoryMb);

  try {
    const sandbox = await conway.createSandbox({
      name: `automaton-child-${genesis.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
      vcpu: legacyTier.vcpu,
      memoryMb: legacyTier.memoryMb,
      diskGb: legacyTier.diskGb,
    });
    sandboxId = sandbox.id;

    // Create a scoped client so all exec/writeFile calls target the CHILD sandbox
    const childConway = conway.createScopedClient(sandbox.id);

    await childConway.exec(
      "apt-get update -qq && apt-get install -y -qq nodejs npm git curl",
      120_000,
    );
    await childConway.exec(
      "git clone https://github.com/Conway-Research/automaton.git /root/automaton && cd /root/automaton && npm install && npm run build",
      180_000,
    );
    await childConway.exec("mkdir -p /root/.automaton", 10_000);

    const genesisJson = JSON.stringify(
      {
        name: genesis.name,
        genesisPrompt: genesis.genesisPrompt,
        creatorMessage: genesis.creatorMessage,
        creatorAddress: identity.address,
        parentAddress: identity.address,
      },
      null,
      2,
    );
    await childConway.writeFile("/root/.automaton/genesis.json", genesisJson);

    try {
      await propagateConstitution(childConway, sandbox.id, db.raw);
    } catch {
      // Constitution file not found
    }

    const initResult = await childConway.exec("node /root/automaton/dist/index.js --init 2>&1", 60_000);
    const walletMatch = (initResult.stdout || "").match(/0x[a-fA-F0-9]{40}/);
    const childWallet = walletMatch ? walletMatch[0] : "";

    if (!isValidWalletAddress(childWallet)) {
      throw new Error(`Child wallet address invalid: ${childWallet}`);
    }

    const child: ChildAutomaton = {
      id: childId,
      name: genesis.name,
      address: childWallet as any,
      sandboxId: sandbox.id,
      genesisPrompt: genesis.genesisPrompt,
      creatorMessage: genesis.creatorMessage,
      fundedAmountCents: 0,
      status: "spawning",
      createdAt: new Date().toISOString(),
    };

    db.insertChild(child);

    db.insertModification({
      id: ulid(),
      timestamp: new Date().toISOString(),
      type: "child_spawn",
      description: `Spawned child: ${genesis.name} in sandbox ${sandbox.id}`,
      reversible: false,
    });

    return child;
  } catch (error) {
    // Sandbox deletion disabled — failed sandboxes left for potential reuse.
    throw error;
  }
}

/**
 * Find a reusable sandbox: one that is marked 'failed' in the local DB
 * but is still running remotely. Returns the first match or null.
 */
async function findReusableSandbox(
  conway: ConwayClient,
  db: AutomatonDatabase,
): Promise<{ id: string } | null> {
  try {
    const failedChildren = db.getChildren().filter((c) => c.status === "failed" && c.sandboxId);
    if (failedChildren.length === 0) return null;

    const remoteSandboxes = await conway.listSandboxes();
    const runningIds = new Set(
      remoteSandboxes
        .filter((s) => s.status === "running")
        .map((s) => s.id),
    );

    for (const child of failedChildren) {
      if (runningIds.has(child.sandboxId)) {
        return { id: child.sandboxId };
      }
    }
  } catch {
    // If listing fails, just create a new sandbox
  }
  return null;
}
