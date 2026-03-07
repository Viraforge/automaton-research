/**
 * Sovereign Provider Interfaces
 *
 * Abstractions for infrastructure providers that replace Conway platform APIs.
 * Each provider is a plain module exporting async functions — no class hierarchies.
 */

import type { ExecResult, DomainSearchResult, DomainRegistration, DnsRecord } from "../types.js";

// ─── Compute Provider (Vultr) ──────────────────────────────────

export interface CreateInstanceOptions {
  /** Human-readable label for the instance */
  label?: string;
  /** Vultr region ID (e.g., "ewr" for New Jersey) */
  region?: string;
  /** Vultr plan ID (e.g., "vc2-1c-1gb") */
  plan?: string;
  /** OS ID (e.g., 2136 for Ubuntu 24.04 x64) */
  osId?: number;
  /** SSH key IDs to install */
  sshKeyIds?: string[];
  /** Startup script (bash, run on first boot) */
  startupScript?: string;
}

export interface InstanceInfo {
  id: string;
  label: string;
  status: string;
  region: string;
  mainIp: string;
  vcpu: number;
  ram: number;
  disk: number;
  os: string;
  defaultPassword?: string;
  createdAt: string;
}

export interface ComputeProvider {
  createInstance(opts: CreateInstanceOptions): Promise<InstanceInfo>;
  destroyInstance(instanceId: string): Promise<void>;
  listInstances(): Promise<InstanceInfo[]>;
  getInstanceStatus(instanceId: string): Promise<InstanceInfo>;
  waitForActive(instanceId: string, timeoutMs?: number): Promise<InstanceInfo>;
  sshExec(ip: string, credential: SshCredential, command: string, timeout?: number): Promise<ExecResult>;
  sshWriteFile(ip: string, credential: SshCredential, remotePath: string, content: string): Promise<void>;
}

export interface SshCredential {
  type: "password" | "key";
  password?: string;
  privateKeyPath?: string;
}

// ─── Domain Provider (Porkbun) ─────────────────────────────────

export interface DomainProvider {
  checkAvailability(domain: string): Promise<DomainSearchResult>;
  registerDomain(domain: string, years?: number): Promise<DomainRegistration>;
  listDomains(): Promise<DomainSearchResult[]>;
}

// ─── DNS Provider (Cloudflare) ─────────────────────────────────

export interface DnsProvider {
  listZones(): Promise<DnsZone[]>;
  listRecords(zoneId: string): Promise<DnsRecord[]>;
  addRecord(
    zoneId: string,
    type: string,
    name: string,
    content: string,
    ttl?: number,
    proxied?: boolean,
  ): Promise<DnsRecord>;
  deleteRecord(zoneId: string, recordId: string): Promise<void>;
}

export interface DnsZone {
  id: string;
  name: string;
  status: string;
}

export interface CloudflareCredentials {
  apiToken?: string;
  apiKey?: string;
  email?: string;
}

// ─── Payment Provider (USDC on Base) ───────────────────────────

export interface UsdcTransferResult {
  txHash: string;
  from: string;
  to: string;
  amountUsd: string;
  network: string;
}
