#!/usr/bin/env tsx
/**
 * Live API test: Cloudflare DNS Provider
 *
 * Tests: list zones → add TXT record → verify → delete
 * Run: npx tsx scripts/test-cloudflare.ts
 *
 * Reads cloudflareApiToken and cloudflareZoneId from ~/.automaton/automaton.json
 */

import fs from "fs";
import path from "path";
import { createCloudflareProvider } from "../src/providers/cloudflare.js";

const CONFIG_PATH = path.join(
  process.env.HOME || "/root",
  ".automaton",
  "automaton.json",
);

async function main() {
  console.log("=== Cloudflare DNS Provider Test ===\n");

  // Load config
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Config not found: ${CONFIG_PATH}`);
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  const apiToken = config.cloudflareApiToken;
  if (!apiToken) {
    console.error("cloudflareApiToken not set in config");
    process.exit(1);
  }

  const provider = createCloudflareProvider(apiToken);

  // Test 1: List zones
  console.log("1. Listing DNS zones...");
  const zones = await provider.listZones();
  console.log(`   Found ${zones.length} zone(s)`);
  for (const z of zones) {
    console.log(`   - ${z.name} (${z.id}) [${z.status}]`);
  }

  if (zones.length === 0) {
    console.log("\n   No zones found — skipping record tests.");
    console.log("\n=== Cloudflare test complete (partial) ===");
    return;
  }

  // Use configured zone or first available
  const zoneId = config.cloudflareZoneId || zones[0].id;
  const zoneName = zones.find((z) => z.id === zoneId)?.name || zones[0].name;
  console.log(`\n   Using zone: ${zoneName} (${zoneId})`);

  // Test 2: List existing records
  console.log("\n2. Listing existing records...");
  const records = await provider.listRecords(zoneId);
  console.log(`   Found ${records.length} record(s)`);
  for (const r of records.slice(0, 5)) {
    console.log(`   - ${r.type} ${r.host} → ${r.value.substring(0, 40)}`);
  }
  if (records.length > 5) {
    console.log(`   ... and ${records.length - 5} more`);
  }

  // Test 3: Add a TXT record
  const testName = `_sovereign-test-${Date.now()}`;
  const testValue = `v=test sovereign-providers ${new Date().toISOString()}`;
  console.log(`\n3. Adding TXT record: ${testName}.${zoneName}...`);
  const added = await provider.addRecord(zoneId, "TXT", `${testName}.${zoneName}`, testValue);
  console.log(`   Created: ${added.id} → ${added.value}`);

  // Test 4: Verify it appears in list
  console.log("\n4. Verifying record in list...");
  const updatedRecords = await provider.listRecords(zoneId);
  const found = updatedRecords.find((r) => r.id === added.id);
  console.log(`   Found: ${found ? "yes" : "NO"}`);

  // Test 5: Delete the test record
  console.log("\n5. Deleting test record...");
  await provider.deleteRecord(zoneId, added.id);
  console.log("   Deleted.");

  console.log("\n=== Cloudflare test complete ===");
}

main().catch((err) => {
  console.error("Cloudflare test failed:", err);
  process.exit(1);
});
