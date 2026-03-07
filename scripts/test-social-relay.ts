#!/usr/bin/env node
/**
 * Production-grade signed message probe for Phase 11 relay verification.
 *
 * This utility:
 * 1. Creates a test account from a known private key
 * 2. Signs a real send/poll/count sequence using the relay protocol
 * 3. Sends each to the relay endpoint
 * 4. Validates successful protocol-level responses
 *
 * Exit codes:
 *   0 = All signed operations succeeded
 *   1 = Any operation failed (critical for gate)
 *
 * Evidence:
 *   stdout = JSON log with timestamps, operations, and HTTP codes
 *   stderr = diagnostic errors
 */

import { privateKeyToAccount } from "viem/accounts";
import { signSendPayload, signPollPayload } from "../src/social/signing.js";
import { verifyMessageSignature, verifyPollSignature } from "../src/social/protocol.js";

const RELAY_URL = process.env.RELAY_URL || "https://relay.compintel.co";
const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SIGNING_PREFIX = "Automaton";

interface ProbeResult {
  operation: string;
  timestamp: string;
  http_code?: number;
  success: boolean;
  error?: string;
}

const results: ProbeResult[] = [];

async function logResult(operation: string, success: boolean, httpCode?: number, error?: string) {
  const result: ProbeResult = {
    operation,
    timestamp: new Date().toISOString(),
    success,
  };
  if (httpCode !== undefined) result.http_code = httpCode;
  if (error) result.error = error;
  results.push(result);
  console.log(JSON.stringify(result));
}

async function probeSendMessage(): Promise<boolean> {
  try {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);

    const payload = await signSendPayload(
      account,
      TEST_RECIPIENT,
      `Probe message at ${new Date().toISOString()}`,
      undefined,
      SIGNING_PREFIX,
    );

    // Verify we can verify our own signature (sanity check)
    const canVerifyOwn = await verifyMessageSignature(
      {
        to: payload.to,
        content: payload.content,
        signed_at: payload.signed_at,
        signature: payload.signature,
      },
      payload.from,
    );

    if (!canVerifyOwn) {
      await logResult("send_message", false, undefined, "Self-signature verification failed");
      return false;
    }

    // Send to relay
    const response = await fetch(`${RELAY_URL}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: payload.from,
        to: payload.to,
        content: payload.content,
        signed_at: payload.signed_at,
        signature: payload.signature,
      }),
    });

    const success = response.ok;
    await logResult("send_message", success, response.status);
    return success;
  } catch (err) {
    await logResult("send_message", false, undefined, String(err));
    return false;
  }
}

async function probePollMessages(): Promise<boolean> {
  try {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);

    const pollPayload = await signPollPayload(account, SIGNING_PREFIX);

    // Verify we can verify our own poll signature
    const canVerifyOwn = await verifyPollSignature(
      pollPayload.address,
      pollPayload.timestamp,
      pollPayload.signature,
    );

    if (!canVerifyOwn) {
      await logResult("poll_messages", false, undefined, "Self-signature verification failed");
      return false;
    }

    // Send poll request with signature headers
    const response = await fetch(`${RELAY_URL}/v1/messages/poll`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Relay-Address": pollPayload.address,
        "X-Relay-Signature": pollPayload.signature,
        "X-Relay-Timestamp": pollPayload.timestamp,
      },
      body: JSON.stringify({ cursor: "" }),
    });

    const success = response.ok;
    await logResult("poll_messages", success, response.status);
    return success;
  } catch (err) {
    await logResult("poll_messages", false, undefined, String(err));
    return false;
  }
}

async function probeMessageCount(): Promise<boolean> {
  try {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);

    const countPayload = await signPollPayload(account, SIGNING_PREFIX);

    // Verify we can verify our own signature
    const canVerifyOwn = await verifyPollSignature(
      countPayload.address,
      countPayload.timestamp,
      countPayload.signature,
    );

    if (!canVerifyOwn) {
      await logResult("message_count", false, undefined, "Self-signature verification failed");
      return false;
    }

    // Send count request with signature headers
    const response = await fetch(`${RELAY_URL}/v1/messages/count`, {
      method: "GET",
      headers: {
        "X-Relay-Address": countPayload.address,
        "X-Relay-Signature": countPayload.signature,
        "X-Relay-Timestamp": countPayload.timestamp,
      },
    });

    const success = response.ok;
    await logResult("message_count", success, response.status);
    return success;
  } catch (err) {
    await logResult("message_count", false, undefined, String(err));
    return false;
  }
}

async function main() {
  try {
    const probes = [
      probeSendMessage(),
      probePollMessages(),
      probeMessageCount(),
    ];

    const results_array = await Promise.all(probes);
    const allPassed = results_array.every(r => r === true);

    process.exit(allPassed ? 0 : 1);
  } catch (err) {
    console.error("Fatal probe error:", err);
    process.exit(1);
  }
}

main();
