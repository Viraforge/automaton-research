/**
 * Cloudflare DNS Provider
 *
 * Manages DNS records via the Cloudflare API v4.
 * Replaces Conway DNS management endpoints.
 *
 * API Reference: https://developers.cloudflare.com/api/
 */

import type { DnsRecord } from "../types.js";
import { ResilientHttpClient } from "../conway/http-client.js";
import type { DnsProvider, DnsZone } from "./types.js";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/**
 * Create a Cloudflare DNS provider bound to an API token.
 */
export function createCloudflareProvider(apiToken: string): DnsProvider {
  const httpClient = new ResilientHttpClient({ baseTimeout: 15_000 });

  return {
    async listZones(): Promise<DnsZone[]> {
      const res = await httpClient.request(`${CF_API_BASE}/zones`, {
        method: "GET",
        headers: authHeaders(apiToken),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Cloudflare listZones failed (${res.status}): ${err}`);
      }

      const data = (await res.json()) as CfResponse<CfZone[]>;
      if (!data.success) {
        throw new Error(`Cloudflare listZones error: ${JSON.stringify(data.errors)}`);
      }

      return data.result.map((z) => ({
        id: z.id,
        name: z.name,
        status: z.status,
      }));
    },

    async listRecords(zoneId: string): Promise<DnsRecord[]> {
      const res = await httpClient.request(
        `${CF_API_BASE}/zones/${zoneId}/dns_records?per_page=100`,
        {
          method: "GET",
          headers: authHeaders(apiToken),
        },
      );

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Cloudflare listRecords failed (${res.status}): ${err}`);
      }

      const data = (await res.json()) as CfResponse<CfDnsRecord[]>;
      if (!data.success) {
        throw new Error(`Cloudflare listRecords error: ${JSON.stringify(data.errors)}`);
      }

      return data.result.map(mapRecord);
    },

    async addRecord(
      zoneId: string,
      type: string,
      name: string,
      content: string,
      ttl = 1, // 1 = auto
    ): Promise<DnsRecord> {
      const res = await httpClient.request(
        `${CF_API_BASE}/zones/${zoneId}/dns_records`,
        {
          method: "POST",
          headers: authHeaders(apiToken),
          body: JSON.stringify({ type, name, content, ttl }),
        },
      );

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Cloudflare addRecord failed (${res.status}): ${err}`);
      }

      const data = (await res.json()) as CfResponse<CfDnsRecord>;
      if (!data.success) {
        throw new Error(`Cloudflare addRecord error: ${JSON.stringify(data.errors)}`);
      }

      return mapRecord(data.result);
    },

    async deleteRecord(zoneId: string, recordId: string): Promise<void> {
      const res = await httpClient.request(
        `${CF_API_BASE}/zones/${zoneId}/dns_records/${recordId}`,
        {
          method: "DELETE",
          headers: authHeaders(apiToken),
        },
      );

      if (!res.ok && res.status !== 404) {
        const err = await res.text();
        throw new Error(`Cloudflare deleteRecord failed (${res.status}): ${err}`);
      }
    },
  };
}

// ─── Cloudflare API Types ────────────────────────────────────────

interface CfResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

interface CfZone {
  id: string;
  name: string;
  status: string;
}

interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  created_on: string;
  modified_on: string;
}

function mapRecord(r: CfDnsRecord): DnsRecord {
  return {
    id: r.id,
    type: r.type,
    host: r.name,
    value: r.content,
    ttl: r.ttl,
  };
}
