/**
 * Porkbun Domain Provider
 *
 * Manages domain registration via the Porkbun API v3.
 * Replaces Conway domain search and registration endpoints.
 *
 * API Reference: https://porkbun.com/api/json/v3/documentation
 */

import type { DomainSearchResult, DomainRegistration } from "../types.js";
import { ResilientHttpClient } from "../http/client.js";
import type { DomainProvider } from "./types.js";

const PORKBUN_API_BASE = "https://api.porkbun.com/api/json/v3";

/**
 * Create a Porkbun domain provider bound to API credentials.
 */
export function createPorkbunProvider(
  apiKey: string,
  secretKey: string,
): DomainProvider {
  const httpClient = new ResilientHttpClient({ baseTimeout: 15_000 });

  function authBody(): { apikey: string; secretapikey: string } {
    return { apikey: apiKey, secretapikey: secretKey };
  }

  return {
    async checkAvailability(domain: string): Promise<DomainSearchResult> {
      // Porkbun's pricing endpoint serves as an availability check.
      // If the domain's TLD is in the pricing response, it's available for registration.
      // For a direct availability check, we use the domain/check endpoint.
      const res = await httpClient.request(
        `${PORKBUN_API_BASE}/domain/checkDomain/${domain}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(authBody()),
        },
      );

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Porkbun checkAvailability failed (${res.status}): ${err}`);
      }

      const data = (await res.json()) as PorkbunCheckResponse;

      if (data.status === "ERROR") {
        throw new Error(`Porkbun checkAvailability error: ${data.message}`);
      }

      return {
        domain,
        available: data.avail === "yes",
        registrationPrice: data.pricing?.registration
          ? parseFloat(data.pricing.registration)
          : undefined,
        renewalPrice: data.pricing?.renewal
          ? parseFloat(data.pricing.renewal)
          : undefined,
        currency: "USD",
      };
    },

    async registerDomain(
      domain: string,
      years = 1,
    ): Promise<DomainRegistration> {
      const res = await httpClient.request(
        `${PORKBUN_API_BASE}/domain/register/${domain}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...authBody(),
            years: years.toString(),
          }),
        },
      );

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Porkbun registerDomain failed (${res.status}): ${err}`);
      }

      const data = (await res.json()) as PorkbunRegisterResponse;

      if (data.status === "ERROR") {
        throw new Error(`Porkbun registerDomain error: ${data.message}`);
      }

      return {
        domain,
        transactionId: data.domain || domain,
        expiresAt: data.expireDate || "",
        status: "registered",
      };
    },

    async listDomains(): Promise<DomainSearchResult[]> {
      const res = await httpClient.request(
        `${PORKBUN_API_BASE}/domain/listAll`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(authBody()),
        },
      );

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Porkbun listDomains failed (${res.status}): ${err}`);
      }

      const data = (await res.json()) as PorkbunListResponse;

      if (data.status === "ERROR") {
        throw new Error(`Porkbun listDomains error: ${data.message}`);
      }

      return (data.domains || []).map((d) => ({
        domain: d.domain,
        available: false, // Already registered — we own it
        registrationPrice: undefined,
        renewalPrice: undefined,
        currency: "USD",
      }));
    },
  };
}

// ─── Porkbun API Types ───────────────────────────────────────────

interface PorkbunCheckResponse {
  status: "SUCCESS" | "ERROR";
  avail?: "yes" | "no";
  pricing?: {
    registration?: string;
    renewal?: string;
  };
  message?: string;
}

interface PorkbunRegisterResponse {
  status: "SUCCESS" | "ERROR";
  domain?: string;
  expireDate?: string;
  message?: string;
}

interface PorkbunListResponse {
  status: "SUCCESS" | "ERROR";
  domains?: Array<{
    domain: string;
    status: string;
    expireDate: string;
  }>;
  message?: string;
}
