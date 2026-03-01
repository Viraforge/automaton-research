#!/usr/bin/env tsx
/**
 * Live API test: Porkbun Domain Provider
 *
 * Tests: check domain availability, list owned domains
 * Run: npx tsx scripts/test-porkbun.ts
 *
 * Reads porkbunApiKey and porkbunSecretKey from ~/.automaton/automaton.json
 */

import fs from "fs";
import path from "path";
import { createPorkbunProvider } from "../src/providers/porkbun.js";

const CONFIG_PATH = path.join(
  process.env.HOME || "/root",
  ".automaton",
  "automaton.json",
);

async function main() {
  console.log("=== Porkbun Domain Provider Test ===\n");

  // Load config
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Config not found: ${CONFIG_PATH}`);
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  const apiKey = config.porkbunApiKey;
  const secretKey = config.porkbunSecretKey;
  if (!apiKey || !secretKey) {
    console.error("porkbunApiKey and/or porkbunSecretKey not set in config");
    process.exit(1);
  }

  const provider = createPorkbunProvider(apiKey, secretKey);

  // Test 1: Check availability of a likely-taken domain
  console.log("1. Checking availability: google.com (should be taken)...");
  const takenResult = await provider.checkAvailability("google.com");
  console.log(`   Available: ${takenResult.available}`);
  console.log(`   Registration: $${takenResult.registrationPrice ?? "N/A"}`);
  console.log(`   Renewal: $${takenResult.renewalPrice ?? "N/A"}`);

  // Test 2: Check availability of a random domain (likely available)
  const randomDomain = `sovereign-test-${Date.now()}.xyz`;
  console.log(`\n2. Checking availability: ${randomDomain} (should be available)...`);
  const availResult = await provider.checkAvailability(randomDomain);
  console.log(`   Available: ${availResult.available}`);
  console.log(`   Registration: $${availResult.registrationPrice ?? "N/A"}`);
  console.log(`   Renewal: $${availResult.renewalPrice ?? "N/A"}`);

  // Test 3: List owned domains
  console.log("\n3. Listing owned domains...");
  const domains = await provider.listDomains();
  console.log(`   Found ${domains.length} domain(s)`);
  for (const d of domains) {
    console.log(`   - ${d.domain}`);
  }

  console.log("\n=== Porkbun test complete ===");
}

main().catch((err) => {
  console.error("Porkbun test failed:", err);
  process.exit(1);
});
