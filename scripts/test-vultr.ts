#!/usr/bin/env tsx
/**
 * Live API test: Vultr Compute Provider
 *
 * Tests: create instance → wait for active → SSH echo → destroy
 * Run: npx tsx scripts/test-vultr.ts
 *
 * Reads vultrApiKey from ~/.automaton/automaton.json
 */

import fs from "fs";
import path from "path";
import { createVultrProvider, listSshKeys } from "../src/providers/vultr.js";

const CONFIG_PATH = path.join(
  process.env.HOME || "/root",
  ".automaton",
  "automaton.json",
);

async function main() {
  console.log("=== Vultr Provider Test ===\n");

  // Load config
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Config not found: ${CONFIG_PATH}`);
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  const apiKey = config.vultrApiKey;
  if (!apiKey) {
    console.error("vultrApiKey not set in config");
    process.exit(1);
  }

  const provider = createVultrProvider(apiKey);

  // Test 1: List existing instances
  console.log("1. Listing existing instances...");
  const instances = await provider.listInstances();
  console.log(`   Found ${instances.length} instance(s)`);
  for (const inst of instances) {
    console.log(`   - ${inst.label} (${inst.id}) [${inst.status}] ${inst.mainIp}`);
  }

  // Test 2: List SSH keys
  console.log("\n2. Listing SSH keys...");
  const keys = await listSshKeys(apiKey);
  console.log(`   Found ${keys.length} key(s)`);
  for (const k of keys) {
    console.log(`   - ${k.name} (${k.id})`);
  }

  // Test 3: Create a small instance
  console.log("\n3. Creating test instance (vc2-1c-1gb, ewr)...");
  const instance = await provider.createInstance({
    label: `test-sovereign-${Date.now()}`,
    region: "ewr",
    plan: "vc2-1c-1gb",
  });
  console.log(`   Created: ${instance.id} [${instance.status}]`);

  // Test 4: Wait for active
  console.log("\n4. Waiting for instance to become active (up to 5 min)...");
  const active = await provider.waitForActive(instance.id, 300_000);
  console.log(`   Active! IP: ${active.mainIp}`);

  // Test 5: SSH echo (wait a bit for sshd to come up)
  console.log("\n5. Waiting 30s for sshd, then SSH echo test...");
  await new Promise((r) => setTimeout(r, 30_000));

  if (active.defaultPassword) {
    const result = await provider.sshExec(
      active.mainIp,
      { type: "password", password: active.defaultPassword },
      'echo "sovereign-test-ok"',
      15_000,
    );
    console.log(`   SSH stdout: ${result.stdout.trim()}`);
    console.log(`   SSH exit code: ${result.exitCode}`);
  } else {
    console.log("   (no default password — skipping SSH test)");
  }

  // Test 6: Destroy
  console.log("\n6. Destroying test instance...");
  await provider.destroyInstance(instance.id);
  console.log("   Destroyed.");

  console.log("\n=== Vultr test complete ===");
}

main().catch((err) => {
  console.error("Vultr test failed:", err);
  process.exit(1);
});
