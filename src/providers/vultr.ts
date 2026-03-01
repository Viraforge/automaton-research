/**
 * Vultr Compute Provider
 *
 * Manages VPS instances via the Vultr API v2.
 * Replaces Conway sandbox creation/management.
 *
 * API Reference: https://www.vultr.com/api/
 */

import { execSync } from "child_process";
import type { ExecResult } from "../types.js";
import { ResilientHttpClient } from "../http/client.js";
import type {
  ComputeProvider,
  CreateInstanceOptions,
  InstanceInfo,
  SshCredential,
} from "./types.js";

const VULTR_API_BASE = "https://api.vultr.com/v2";

// Default: Ubuntu 24.04 x64
const DEFAULT_OS_ID = 2136;
// Default: 1 vCPU, 1GB RAM, 25GB SSD
const DEFAULT_PLAN = "vc2-1c-1gb";
// Default: New Jersey
const DEFAULT_REGION = "ewr";

function createVultrClient(apiKey: string): ResilientHttpClient {
  return new ResilientHttpClient({ baseTimeout: 30_000 });
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

/**
 * Create a Vultr compute provider bound to an API key.
 */
export function createVultrProvider(apiKey: string): ComputeProvider {
  const httpClient = createVultrClient(apiKey);

  return {
    async createInstance(opts: CreateInstanceOptions): Promise<InstanceInfo> {
      const body = {
        region: opts.region || DEFAULT_REGION,
        plan: opts.plan || DEFAULT_PLAN,
        os_id: opts.osId || DEFAULT_OS_ID,
        label: opts.label || `automaton-${Date.now()}`,
        sshkey_id: opts.sshKeyIds,
        script_id: undefined as string | undefined,
      };

      const res = await httpClient.request(`${VULTR_API_BASE}/instances`, {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Vultr createInstance failed (${res.status}): ${err}`);
      }

      const data = (await res.json()) as { instance: VultrInstance };
      return mapInstance(data.instance);
    },

    async destroyInstance(instanceId: string): Promise<void> {
      const res = await httpClient.request(
        `${VULTR_API_BASE}/instances/${instanceId}`,
        {
          method: "DELETE",
          headers: authHeaders(apiKey),
        },
      );

      if (!res.ok && res.status !== 404) {
        const err = await res.text();
        throw new Error(`Vultr destroyInstance failed (${res.status}): ${err}`);
      }
    },

    async listInstances(): Promise<InstanceInfo[]> {
      const res = await httpClient.request(`${VULTR_API_BASE}/instances`, {
        method: "GET",
        headers: authHeaders(apiKey),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Vultr listInstances failed (${res.status}): ${err}`);
      }

      const data = (await res.json()) as { instances: VultrInstance[] };
      return data.instances.map(mapInstance);
    },

    async getInstanceStatus(instanceId: string): Promise<InstanceInfo> {
      const res = await httpClient.request(
        `${VULTR_API_BASE}/instances/${instanceId}`,
        {
          method: "GET",
          headers: authHeaders(apiKey),
        },
      );

      if (!res.ok) {
        const err = await res.text();
        throw new Error(
          `Vultr getInstanceStatus failed (${res.status}): ${err}`,
        );
      }

      const data = (await res.json()) as { instance: VultrInstance };
      return mapInstance(data.instance);
    },

    async waitForActive(
      instanceId: string,
      timeoutMs = 300_000,
    ): Promise<InstanceInfo> {
      const start = Date.now();
      const pollInterval = 5_000;

      while (Date.now() - start < timeoutMs) {
        const instance = await this.getInstanceStatus(instanceId);
        if (instance.status === "active" && instance.mainIp !== "0.0.0.0") {
          return instance;
        }
        await new Promise((r) => setTimeout(r, pollInterval));
      }

      throw new Error(
        `Vultr instance ${instanceId} did not become active within ${timeoutMs}ms`,
      );
    },

    async sshExec(
      ip: string,
      credential: SshCredential,
      command: string,
      timeout = 30_000,
    ): Promise<ExecResult> {
      const sshArgs = buildSshArgs(ip, credential);
      const fullCommand = `ssh ${sshArgs.join(" ")} ${JSON.stringify(command)}`;

      try {
        const stdout = execSync(fullCommand, {
          timeout,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
        });
        return { stdout: stdout || "", stderr: "", exitCode: 0 };
      } catch (err: any) {
        return {
          stdout: err.stdout || "",
          stderr: err.stderr || err.message || "",
          exitCode: err.status ?? 1,
        };
      }
    },

    async sshWriteFile(
      ip: string,
      credential: SshCredential,
      remotePath: string,
      content: string,
    ): Promise<void> {
      // Use ssh with heredoc to write file content
      const sshArgs = buildSshArgs(ip, credential);
      const escapedContent = content.replace(/'/g, "'\\''");
      const fullCommand = `ssh ${sshArgs.join(" ")} 'mkdir -p $(dirname ${JSON.stringify(remotePath)}) && cat > ${JSON.stringify(remotePath)}' << 'AUTOMATON_EOF'\n${content}\nAUTOMATON_EOF`;

      try {
        execSync(fullCommand, {
          timeout: 30_000,
          encoding: "utf-8",
          shell: "/bin/bash",
        });
      } catch (err: any) {
        throw new Error(
          `SSH writeFile to ${ip}:${remotePath} failed: ${err.stderr || err.message}`,
        );
      }
    },
  };
}

// ─── SSH Helpers ──────────────────────────────────────────────────

function buildSshArgs(ip: string, credential: SshCredential): string[] {
  const args = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=10",
    "-o", "LogLevel=ERROR",
  ];

  if (credential.type === "key" && credential.privateKeyPath) {
    args.push("-i", credential.privateKeyPath);
  } else if (credential.type === "password" && credential.password) {
    // sshpass for password auth (requires sshpass to be installed)
    return [
      ...["sshpass", "-p", credential.password, "ssh"],
      ...args,
      `root@${ip}`,
    ].slice(1); // Remove the leading "sshpass" since we prepend it
  }

  args.push(`root@${ip}`);
  return args;
}

// ─── Vultr API Types ─────────────────────────────────────────────

interface VultrInstance {
  id: string;
  label: string;
  status: string;
  power_status: string;
  server_status: string;
  region: string;
  main_ip: string;
  vcpu_count: number;
  ram: number;
  disk: number;
  os: string;
  default_password?: string;
  date_created: string;
}

function mapInstance(v: VultrInstance): InstanceInfo {
  return {
    id: v.id,
    label: v.label,
    status: v.status,
    region: v.region,
    mainIp: v.main_ip,
    vcpu: v.vcpu_count,
    ram: v.ram,
    disk: v.disk,
    os: v.os,
    defaultPassword: v.default_password,
    createdAt: v.date_created,
  };
}

// ─── SSH Key Management ──────────────────────────────────────────

/**
 * Upload an SSH public key to Vultr for use with new instances.
 */
export async function uploadSshKey(
  apiKey: string,
  name: string,
  publicKey: string,
): Promise<{ id: string }> {
  const httpClient = createVultrClient(apiKey);
  const res = await httpClient.request(`${VULTR_API_BASE}/ssh-keys`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({ name, ssh_key: publicKey }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Vultr uploadSshKey failed (${res.status}): ${err}`);
  }

  const data = (await res.json()) as { ssh_key: { id: string } };
  return { id: data.ssh_key.id };
}

/**
 * List existing SSH keys on Vultr.
 */
export async function listSshKeys(
  apiKey: string,
): Promise<Array<{ id: string; name: string }>> {
  const httpClient = createVultrClient(apiKey);
  const res = await httpClient.request(`${VULTR_API_BASE}/ssh-keys`, {
    method: "GET",
    headers: authHeaders(apiKey),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Vultr listSshKeys failed (${res.status}): ${err}`);
  }

  const data = (await res.json()) as {
    ssh_keys: Array<{ id: string; name: string }>;
  };
  return data.ssh_keys;
}
