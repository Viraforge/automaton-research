/**
 * Automaton Tool System
 *
 * Defines all tools the automaton can call, with self-preservation guards.
 * Tools are organized by category and exposed to the inference model.
 */

import { ulid } from "ulid";
import type {
  AutomatonTool,
  ToolContext,
  ToolCategory,
  InferenceToolDefinition,
  ToolCallResult,
  GenesisConfig,
  RiskLevel,
  PolicyRequest,
  InputSource,
  SpendTrackerInterface,
} from "../types.js";
import type { PolicyEngine } from "./policy-engine.js";
import { sanitizeToolResult, sanitizeInput } from "./injection-defense.js";
import { createLogger } from "../observability/logger.js";
import { classifyExecTimeout } from "../orchestration/exec-timeout.js";
import { getWebSearchTool } from "./tools/web-search.js";
import { getGitHubSearchTool } from "./tools/github-search.js";
import { getApiDiscoveryTool } from "./tools/discovery.js";
import { getStartServiceTool, getStopServiceTool, getListServicesTool } from "./tools/service-manager.js";

const logger = createLogger("tools");

// Tools whose results come from external sources and need sanitization
const EXTERNAL_SOURCE_TOOLS = new Set([
  "exec",
  "web_fetch",
  "check_social_inbox",
]);

// ─── Self-Preservation Guard ───────────────────────────────────
// Defense-in-depth: policy engine (command.forbidden_patterns rule) is the primary guard.
// This inline check is kept as a secondary safety net in case the policy engine is bypassed.

const FORBIDDEN_COMMAND_PATTERNS = [
  // Self-destruction
  /rm\s+(-rf?\s+)?.*\.automaton/,
  /rm\s+(-rf?\s+)?.*state\.db/,
  /rm\s+(-rf?\s+)?.*wallet\.json/,
  /rm\s+(-rf?\s+)?.*automaton\.json/,
  /rm\s+(-rf?\s+)?.*heartbeat\.yml/,
  /rm\s+(-rf?\s+)?.*SOUL\.md/,
  // Process killing
  /kill\s+.*automaton/,
  /pkill\s+.*automaton/,
  /systemctl\s+(stop|disable)\s+automaton/,
  // Database destruction
  /DROP\s+TABLE/i,
  /DELETE\s+FROM\s+(turns|identity|kv|schema_version|skills|children|registry)/i,
  /TRUNCATE/i,
  // Safety infrastructure modification via shell
  /sed\s+.*injection-defense/,
  /sed\s+.*self-mod\/code/,
  /sed\s+.*audit-log/,
  />\s*.*injection-defense/,
  />\s*.*self-mod\/code/,
  />\s*.*audit-log/,
  // Credential harvesting
  /cat\s+.*\.ssh/,
  /cat\s+.*\.gnupg/,
  /cat\s+.*\.env/,
  /cat\s+.*wallet\.json/,
  // Discord webhook abuse — only the built-in heartbeat should post to Discord
  /discord\.com\/api\/webhooks/i,
  /discordapp\.com\/api\/webhooks/i,
  // Config file reads — automaton.json contains webhook URL and secrets.
  // The agent must not read its own config; the heartbeat system handles Discord internally.
  /\bautomaton\.json\b/,
  // Background process spawning — agent must not run persistent daemons.
  // Use the heartbeat system for periodic tasks, not nohup/pm2/screen.
  /\bnohup\b/i,
  /\bpm2\s+(start|restart|resurrect)/i,
  /\bscreen\s+-[dS]/,
  /\btmux\b.*\b(new-session|new\b|-d)/,
  /\bsetsid\b/,
  /\bdisown\b/,
  /\bforever\s+start/i,
];

function hasUnquotedBackgroundOperator(command: string): boolean {
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const prevChar = command[index - 1];
    const nextChar = command[index + 1];

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote && prevChar !== "\\") {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char !== "&" || inSingleQuote || inDoubleQuote) continue;
    if (nextChar === "&") {
      index++;
      continue;
    }

    const nextBoundary = !nextChar || /\s|;/.test(nextChar);
    if (nextBoundary) return true;
  }

  return false;
}

function isForbiddenCommand(command: string, sandboxId: string): string | null {
  if (hasUnquotedBackgroundOperator(command)) {
    return "Blocked: Command contains background operator &";
  }

  for (const pattern of FORBIDDEN_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return `Blocked: Command matches self-harm pattern: ${pattern.source}`;
    }
  }

  // Block deleting own sandbox
  if (command.includes("sandbox_delete") && command.includes(sandboxId)) {
    return "Blocked: Cannot delete own sandbox";
  }

  return null;
}

function buildNetstatFallback(command: string): string | null {
  const trimmed = command.trim();
  if (!/^netstat\b/i.test(trimmed)) return null;

  // Minimal compatibility shim for common Linux checks.
  // netstat -tlnp         -> ss -ltnp
  // netstat -tlnp | grep  -> ss -ltnp | grep
  const rewritten = trimmed.replace(/^netstat\b(?:\s+-[^\s]+)?/i, "ss -ltnp");
  return rewritten;
}

async function channelGuard(
  ctx: ToolContext,
  channelId: string,
): Promise<{ blocked: boolean; message?: string }> {
  const { getChannelUseDecision } = await import("../distribution/channels.js");
  const decision = getChannelUseDecision(ctx.db.raw, channelId, ctx.config);
  if (decision.allowed) return { blocked: false };
  return {
    blocked: true,
    message: `Blocked by distribution channel state: ${channelId} is ${decision.status}${decision.reason ? ` (${decision.reason})` : ""}.`,
  };
}

async function recordChannelIssue(
  ctx: ToolContext,
  channelId: string,
  message: string,
): Promise<void> {
  const { recordChannelOutcome } = await import("../distribution/channels.js");
  recordChannelOutcome(ctx.db.raw, channelId, message, ctx.config);
}

async function checkProjectBudget(
  ctx: ToolContext,
  projectId: string,
): Promise<{ blocked: boolean; message?: string }> {
  const { getProjectById } = await import("../state/database.js");
  const { isProjectBudgetExceeded } = await import("../portfolio/policy.js");
  const project = getProjectById(ctx.db.raw, projectId);
  if (!project) return { blocked: false };
  if (!isProjectBudgetExceeded(project)) return { blocked: false };
  return {
    blocked: true,
    message:
      `Blocked: project ${projectId} exceeded budget (compute ${project.spentComputeCents}/${project.budgetComputeCents}, ` +
      `tokens ${project.spentTokens}/${project.budgetTokens}).`,
  };
}

function normalizePublishedHostname(
  subdomain: string,
  baseDomain = "compintel.co",
): string | null {
  const raw = subdomain.trim().toLowerCase().replace(/\.$/, "");
  if (!raw) return null;
  const fqdn = raw.endsWith(`.${baseDomain}`) ? raw : `${raw}.${baseDomain}`;
  if (!fqdn.endsWith(`.${baseDomain}`)) return null;
  if (fqdn === baseDomain) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z0-9-]+$/.test(fqdn)) return null;
  return fqdn;
}

function isApprovedPublishedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname.endsWith(".compintel.co");
  } catch {
    return false;
  }
}

function isTemporaryPublicationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith(".trycloudflare.com");
  } catch {
    return false;
  }
}

function isApprovedPublishedSubdomainUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith(".compintel.co");
  } catch {
    return false;
  }
}

function hasApprovedPublicRevenuePath(pathname: string): boolean {
  return /^\/(?:health(?:\/|$)|v1(?:\/|$)|pricing(?:\/|$)|markets(?:\/|$)|x402(?:\/|$)|messages(?:\/|$)|poll(?:\/|$)|count(?:\/|$))/i.test(pathname);
}

function normalizeCompletionEvidenceUrl(url: string): string {
  return url
    .replace(/^[<`("'[*_~]+/, "")
    .replace(/[>`)"'\].,;!?:*_~]+$/, "");
}

function extractCompletionEvidenceUrls(text: string): string[] {
  const matches = text.matchAll(/(?:^|[^A-Za-z0-9+.-])(?<url>https?:\/\/[^\s<>"'`)\],]+)/gi);
  const urls: string[] = [];
  for (const match of matches) {
    const url = match.groups?.url;
    if (url) urls.push(normalizeCompletionEvidenceUrl(url));
  }
  return urls;
}

function hasStandalonePublicRevenuePathEvidence(text: string): boolean {
  const standaloneMatches = text.matchAll(
    /(?:^|[\s(<\[{`"'*_~])(?<path>\/[A-Za-z0-9/_-]+)(?=$|[\s>)\]}`"'*_~.,:;!?])/gi,
  );
  for (const match of standaloneMatches) {
    const pathname = match.groups?.path;
    if (pathname && hasApprovedPublicRevenuePath(pathname)) return true;
  }
  return false;
}

function derivePublishedAssetRecordFromUrl(
  url: string,
  port: number,
): {
  fqdn: string;
  subdomain: string;
  port: number;
  healthcheckPath: string;
} | null {
  try {
    const parsed = new URL(url);
    if (!isApprovedPublishedUrl(url)) return null;

    const fqdn = parsed.hostname.toLowerCase();
    const subdomain = fqdn.replace(/\.compintel\.co$/i, "");
    if (!subdomain || subdomain === fqdn) return null;

    const healthcheckPath = parsed.pathname && parsed.pathname !== "/" && isValidHealthPath(parsed.pathname)
      ? parsed.pathname
      : "/health";

    return {
      fqdn,
      subdomain,
      port,
      healthcheckPath,
    };
  } catch {
    return null;
  }
}

function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "localhost"
      || parsed.hostname === "127.0.0.1"
      || parsed.hostname === "[::1]"
      || parsed.hostname === "::1";
  } catch {
    return false;
  }
}

function buildManagedPublicationFailureMessage(
  port: number,
  originalUrl: string,
  reason: string,
): string {
  if (isLoopbackUrl(originalUrl)) {
    return `Port ${port} exposed at: ${originalUrl} (auto-publish failed: ${reason})`;
  }

  return [
    "Blocked: managed publication to compintel.co failed.",
    `Reason: ${reason}`,
    `Local service is still available on port ${port}, but the returned non-compintel URL is not a valid public asset URL.`,
    "Retry once Cloudflare publication is working or publish the service to a compintel.co hostname.",
  ].join("\n");
}

function buildMissingManagedPublicationCredentialsMessage(port: number): string {
  return [
    "Blocked: Cloudflare publication credentials are missing for sovereign public publication.",
    `Local service is still available on port ${port}, but no approved compintel.co public asset URL can be produced yet.`,
    "Add Cloudflare publication credentials or publish the service to a compintel.co hostname.",
  ].join("\n");
}

function hasManagedPublicationCredentials(config: {
  cloudflareApiToken?: string;
  cloudflareApiKey?: string;
  cloudflareEmail?: string;
}): boolean {
  if (config.cloudflareApiToken) return true;
  return Boolean(config.cloudflareApiKey && config.cloudflareEmail);
}

async function syncPublishedAssetRecord(
  record: {
    fqdn: string;
    subdomain: string;
    port: number;
    healthcheckPath: string;
  },
): Promise<string | null> {
  const { upsertPublicAssetRecord } = await import("../publication/public-asset-registry.js");

  try {
    await upsertPublicAssetRecord({
      id: record.subdomain,
      title: record.fqdn,
      url: `https://${record.fqdn}`,
      subdomain: record.subdomain,
      status: "published",
      healthcheckPath: record.healthcheckPath,
      port: record.port,
    });
    return null;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn("publication: public asset registry sync failed", {
      error: errorMessage,
      fqdn: record.fqdn,
      port: record.port,
    });
    return `Warning: public asset registry sync failed: ${errorMessage}`;
  }
}

function isValidHealthPath(pathValue: string): boolean {
  return /^\/[A-Za-z0-9._~!$&'()*+,;=:@/%/-]*$/.test(pathValue);
}

function buildPublishedServiceScript(
  fqdn: string,
  port: number,
  healthcheckPath: string,
): string {
  return [
    "set -e",
    "SUDO=\"\"",
    "if command -v sudo >/dev/null 2>&1; then SUDO=\"sudo\"; fi",
    // Directly append site blocks to Caddyfile instead of using import (which doesn't support site blocks in Caddy)
    `if ! grep -q '${escapeShellArg(`http://${fqdn}`)}' /etc/caddy/Caddyfile 2>/dev/null; then`,
    `  cat <<'CADDY_SITE' | $SUDO tee -a /etc/caddy/Caddyfile >/dev/null`,
    `http://${fqdn} {`,
    `    reverse_proxy http://127.0.0.1:${port}`,
    "}",
    `https://${fqdn} {`,
    `    reverse_proxy http://127.0.0.1:${port}`,
    "}",
    "CADDY_SITE",
    "fi",
    "$SUDO caddy validate --config /etc/caddy/Caddyfile",
    "$SUDO systemctl reload caddy",
    `curl -fsS ${escapeShellArg(`http://127.0.0.1:${port}${healthcheckPath}`)} >/dev/null`,
  ].join("\n");
}

function taskRequiresPublicRevenueVerification(task: {
  taskClass?: string | null;
  title?: string | null;
  description?: string | null;
}): boolean {
  const taskClass = (task.taskClass || "").toLowerCase();
  if (taskClass === "distribution" || taskClass === "monetization") {
    return true;
  }

  const combined = `${task.title || ""}\n${task.description || ""}`.toLowerCase();
  return /(public|publish|deploy|api|endpoint|revenue|pricing|x402|monetiz)/i.test(combined);
}

function hasPublicRevenueCompletionEvidence(
  output: string,
  artifacts: string[],
): boolean {
  const combined = [output, ...artifacts].join("\n");
  if (/\b(?:localhost|127\.0\.0\.1)\b/i.test(combined)) {
    return false;
  }

  const extractedUrls = extractCompletionEvidenceUrls(combined);
  const approvedPublicUrls = extractedUrls.filter((url) =>
    /^https:\/\//i.test(url) && isApprovedPublishedSubdomainUrl(url)
  );
  if (approvedPublicUrls.length === 0) return false;

  const hasApprovedRouteUrl = approvedPublicUrls.some((url) => {
    try {
      const parsed = new URL(url);
      return hasApprovedPublicRevenuePath(parsed.pathname);
    } catch {
      return false;
    }
  });
  if (hasApprovedRouteUrl) return true;

  const nonUrlEvidence = combined.replace(/https?:\/\/[^\s<>"'`)\],]+/gi, " ");
  return hasStandalonePublicRevenuePathEvidence(nonUrlEvidence);
}

async function resolveCloudflareZoneId(
  cf: { listZones(): Promise<Array<{ id: string; name: string }>> },
  configuredZoneId: string | undefined,
  domain: string,
): Promise<string> {
  if (configuredZoneId) return configuredZoneId;
  const zones = await cf.listZones();
  const match = zones.find((z) => domain.endsWith(z.name));
  if (!match) {
    throw new Error(
      `No Cloudflare zone found for ${domain}. Available zones: ${zones.map((z) => z.name).join(", ") || "none"}.`,
    );
  }
  return match.id;
}

async function inferPublishOriginIp(
  ctx: ToolContext,
  records: Array<{ type: string; host: string; value: string }>,
  domain: string,
): Promise<string> {
  const preferredHosts = [
    `api.${domain}`,
    `relay.${domain}`,
    domain,
  ];
  for (const host of preferredHosts) {
    const record = records.find((r) => r.type === "A" && r.host === host);
    if (record?.value) return record.value;
  }

  const ipResult = await ctx.conway.exec(
    "sh -lc \"curl -4fsS https://api.ipify.org || curl -4fsS https://ifconfig.me\"",
    15_000,
  );
  const detectedIp = (ipResult.stdout || "").trim();
  if (ipResult.exitCode !== 0 || !/^\d{1,3}(\.\d{1,3}){3}$/.test(detectedIp)) {
    throw new Error("Unable to infer public origin IP. Pass origin_ip explicitly or set an existing A record.");
  }
  return detectedIp;
}

// ─── Built-in Tools ────────────────────────────────────────────

export function createBuiltinTools(sandboxId: string): AutomatonTool[] {
  return [
    // ── VM/Sandbox Tools ──
    {
      name: "exec",
      description:
        "Execute a shell command in your sandbox. Returns stdout, stderr, and exit code.",
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute",
          },
          timeout: {
            type: "number",
            description: "Timeout in milliseconds (default: 30000)",
          },
        },
        required: ["command"],
      },
      execute: async (args, ctx) => {
        const command = args.command as string;
        const timeoutMs = (args.timeout as number) || 30000;
        const forbidden = isForbiddenCommand(command, ctx.identity.sandboxId);
        if (forbidden) return forbidden;

        let result;
        try {
          result = await ctx.conway.exec(command, timeoutMs);
        } catch (error) {
          const timeout = classifyExecTimeout({ error });
          if (timeout.isTimeout && timeout.summary) {
            return `exec timeout: ${timeout.summary}`;
          }
          const message = error instanceof Error ? error.message : String(error);
          return `exec error: ${message}`;
        }
        if (
          result.exitCode !== 0 &&
          /netstat:\s*not found/i.test(result.stderr || "")
        ) {
          const fallbackCommand = buildNetstatFallback(command);
          if (fallbackCommand) {
            try {
              result = await ctx.conway.exec(fallbackCommand, timeoutMs);
            } catch (error) {
              const timeout = classifyExecTimeout({ error });
              if (timeout.isTimeout && timeout.summary) {
                return `exec timeout: ${timeout.summary}`;
              }
              const message = error instanceof Error ? error.message : String(error);
              return `exec error: ${message}`;
            }
          }
        }
        const timeout = classifyExecTimeout({
          result: {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
          },
        });
        if (timeout.isTimeout && timeout.summary) {
          return `exec timeout: ${timeout.summary}`;
        }
        // Sanitize output: strip any Discord webhook URLs that may leak through
        // stdout/stderr (e.g. from reading config files or logs). The agent must
        // never see the raw webhook URL — the heartbeat system manages it internally.
        const webhookPattern = /https:\/\/discord(?:app)?\.com\/api\/webhooks\/[^\s"'<>]+/gi;
        const stdout = (result.stdout || "").replace(webhookPattern, "[REDACTED:webhook]");
        const stderr = (result.stderr || "").replace(webhookPattern, "[REDACTED:webhook]");
        return `exit_code: ${result.exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`;
      },
    },
    {
      name: "write_file",
      description: "Write content to a file in your sandbox.",
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          content: { type: "string", description: "File content" },
        },
        required: ["path", "content"],
      },
      execute: async (args, ctx) => {
        const filePath = args.path as string;
        // Guard against overwriting protected files (same check as edit_own_file)
        const { isProtectedFile } = await import("../self-mod/code.js");
        if (isProtectedFile(filePath)) {
          return "Blocked: Cannot overwrite protected file. This is a hard-coded safety invariant.";
        }
        // Block writing files that post to Discord (literal URLs or via config/env)
        const content = args.content as string;
        if (/discord\.com\/api\/webhooks/i.test(content) || /discordapp\.com\/api\/webhooks/i.test(content)) {
          return "Blocked: Do not embed Discord webhook URLs in files. The built-in heartbeat handles Discord updates.";
        }
        if (/discordWebhookUrl/i.test(content) || /DISCORD_WEBHOOK/i.test(content)) {
          return "Blocked: Do not create scripts that reference the Discord webhook. The built-in heartbeat handles Discord updates.";
        }
        // Block scripts that read automaton.json (contains secrets like webhook URL)
        if (/automaton\.json/i.test(content) && /readFile|readFileSync|require|import|open|load|parse/i.test(content)) {
          return "Blocked: Cannot create scripts that read automaton.json. It contains system secrets.";
        }
        await ctx.conway.writeFile(filePath, content);
        return `File written: ${filePath}`;
      },
    },
    {
      name: "read_file",
      description: "Read content from a file in your sandbox.",
      category: "vm",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read" },
        },
        required: ["path"],
      },
      execute: async (args, ctx) => {
        const filePath = args.path as string;
        // Block reads of sensitive files (wallet, env, config secrets)
        const basename = filePath.split("/").pop() || "";
        const sensitiveFiles = ["wallet.json", ".env", "automaton.json"];
        const sensitiveExtensions = [".key", ".pem"];
        if (
          sensitiveFiles.includes(basename) ||
          sensitiveExtensions.some((ext) => basename.endsWith(ext)) ||
          basename.startsWith("private-key")
        ) {
          return "Blocked: Cannot read sensitive file. This protects credentials and secrets.";
        }
        try {
          const content = await ctx.conway.readFile(filePath);
          // Redact any webhook URLs that may appear in file contents
          return (content || "").replace(/https:\/\/discord(?:app)?\.com\/api\/webhooks\/[^\s"'<>]+/gi, "[REDACTED:webhook]");
        } catch {
          // Conway files/read API may be broken — fall back to exec(cat)
          const result = await ctx.conway.exec(
            `cat ${escapeShellArg(filePath)}`,
            30_000,
          );
          if (result.exitCode !== 0) {
            return `ERROR: File not found or not readable: ${filePath}`;
          }
          // Redact webhook URLs from fallback reads too
          return (result.stdout || "").replace(/https:\/\/discord(?:app)?\.com\/api\/webhooks\/[^\s"'<>]+/gi, "[REDACTED:webhook]");
        }
      },
    },
    {
      name: "expose_port",
      description:
        "Expose a port from your sandbox to the internet. Returns a public URL. In BYOK mode with Cloudflare credentials, automatically publishes via DNS and reverse proxy instead of localhost-only exposure.",
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          port: { type: "number", description: "Port number to expose" },
        },
        required: ["port"],
      },
      execute: async (args, ctx) => {
        const port = args.port as number;
        const info = await ctx.conway.exposePort(port);
        const hasApprovedPublishedUrl = isApprovedPublishedUrl(info.publicUrl);
        const hasCloudflarePublishingCredentials = hasManagedPublicationCredentials(ctx.config);
        if (ctx.config.useSovereignProviders
          && !hasApprovedPublishedUrl
          && !isLoopbackUrl(info.publicUrl)
          && !hasCloudflarePublishingCredentials) {
          return buildMissingManagedPublicationCredentialsMessage(port);
        }
        const requiresManagedPublication = ctx.config.useSovereignProviders
          && hasCloudflarePublishingCredentials
          && (!hasApprovedPublishedUrl || isTemporaryPublicationUrl(info.publicUrl));

        // If sovereign mode returned a non-approved URL, auto-publish to compintel.co.
        if (requiresManagedPublication) {
          try {
            // Auto-generate subdomain based on port number and timestamp
            const timestamp = Date.now().toString(36).slice(-6);
            const autoSubdomain = `api-${port}-${timestamp}`;

            const { createCloudflareProvider } = await import("../providers/cloudflare.js");
            const cfToken = ctx.config.cloudflareApiToken;
            const cfKey = ctx.config.cloudflareApiKey;
            const cfEmail = ctx.config.cloudflareEmail;
            const cf = createCloudflareProvider(
              cfToken ? { apiToken: cfToken } : { apiKey: cfKey!, email: cfEmail! },
            );
            const domain = "compintel.co";
            const zoneId = await resolveCloudflareZoneId(cf, ctx.config.cloudflareZoneId, domain);
            const existingRecords = await cf.listRecords(zoneId);
            const originIp = await inferPublishOriginIp(ctx, existingRecords, domain);

            // Create FQDN
            const fqdn = `${autoSubdomain}.${domain}`;

            // Delete any existing records for this FQDN
            for (const record of existingRecords.filter((r) => r.host === fqdn)) {
              await cf.deleteRecord(zoneId, record.id);
            }

            // Create DNS record (proxied for security)
            const record = await cf.addRecord(zoneId, "A", fqdn, originIp, 1, true);

            // Configure Caddy reverse proxy
            const publishScript = buildPublishedServiceScript(fqdn, port, "/health");
            const publishResult = await ctx.conway.exec(publishScript, 120_000);

            if (publishResult.exitCode !== 0) {
              const failureMessage = publishResult.stderr || `exit code ${publishResult.exitCode}`;
              logger.warn("expose_port: publish_service fallback failed, returning localhost", {
                exitCode: publishResult.exitCode,
                stderr: publishResult.stderr,
              });
              return buildManagedPublicationFailureMessage(port, info.publicUrl, failureMessage);
            }

            const registryWarning = await syncPublishedAssetRecord({
              fqdn,
              subdomain: autoSubdomain,
              port,
              healthcheckPath: "/health",
            });
            const lines = [
              `Port ${port} published: https://${fqdn}`,
              `DNS: A ${record.host} -> ${record.value} (proxied via Cloudflare)`,
              `Reverse proxy: 127.0.0.1:${port}`,
            ];
            if (registryWarning) lines.push(registryWarning);

            return lines.join("\n");
          } catch (err: any) {
            const failureMessage = err instanceof Error ? err.message : String(err);
            logger.warn("expose_port: auto-publish failed, returning localhost", {
              error: failureMessage,
              port,
            });
            return buildManagedPublicationFailureMessage(port, info.publicUrl, failureMessage);
          }
        }

        const publishedAssetRecord = derivePublishedAssetRecordFromUrl(info.publicUrl, port);
        if (publishedAssetRecord) {
          const registryWarning = await syncPublishedAssetRecord(publishedAssetRecord);
          const lines = [`Port ${info.port} exposed at: ${info.publicUrl}`];
          if (registryWarning) lines.push(registryWarning);
          return lines.join("\n");
        }

        return `Port ${info.port} exposed at: ${info.publicUrl}`;
      },
    },
    {
      name: "remove_port",
      description: "Remove a previously exposed port.",
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          port: { type: "number", description: "Port number to remove" },
        },
        required: ["port"],
      },
      execute: async (args, ctx) => {
        await ctx.conway.removePort(args.port as number);
        return `Port ${args.port} removed`;
      },
    },
    {
      name: "publish_service",
      description:
        "Publish a local service on a compintel.co subdomain by configuring DNS and Caddy. Use this for public product endpoints instead of localhost-only expose_port results.",
      category: "vm",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          subdomain: {
            type: "string",
            description: "Subdomain label or FQDN under compintel.co (e.g. 'alpha' or 'alpha.compintel.co')",
          },
          port: {
            type: "number",
            description: "Local port to publish through the reverse proxy",
          },
          domain: {
            type: "string",
            description: "Base domain to publish under. Defaults to compintel.co.",
          },
          healthcheck_path: {
            type: "string",
            description: "Local health check path used before publish completes. Defaults to /health.",
          },
          origin_ip: {
            type: "string",
            description: "Optional public origin IP override. If omitted, inferred from existing DNS or public IP lookup.",
          },
          proxied: {
            type: "boolean",
            description: "Whether the Cloudflare DNS record should be proxied. Defaults to false for direct-origin debugging.",
          },
        },
        required: ["subdomain", "port"],
      },
      execute: async (args, ctx) => {
        if (!ctx.config.useSovereignProviders) {
          return "Error: publish_service requires sovereign providers mode.";
        }

        const cfToken = ctx.config.cloudflareApiToken;
        const cfKey = ctx.config.cloudflareApiKey;
        const cfEmail = ctx.config.cloudflareEmail;
        if (!cfToken && !(cfKey && cfEmail)) {
          return "Error: set cloudflareApiToken or cloudflareApiKey + cloudflareEmail for service publishing.";
        }

        const domain = String(args.domain || "compintel.co").trim().toLowerCase();
        if (domain !== "compintel.co") {
          return "Blocked: publish_service is restricted to compintel.co subdomains.";
        }

        const fqdn = normalizePublishedHostname(String(args.subdomain || ""), domain);
        if (!fqdn) {
          return `Blocked: invalid subdomain "${String(args.subdomain || "")}". Use a compintel.co subdomain.`;
        }

        const port = Number(args.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return `Blocked: port must be an integer between 1 and 65535, got ${String(args.port)}`;
        }

        const healthcheckPath = String(args.healthcheck_path || "/health");
        if (!isValidHealthPath(healthcheckPath)) {
          return `Blocked: invalid healthcheck_path "${healthcheckPath}".`;
        }

        const { createCloudflareProvider } = await import("../providers/cloudflare.js");
        const cf = createCloudflareProvider(
          cfToken ? { apiToken: cfToken } : { apiKey: cfKey!, email: cfEmail! },
        );
        const zoneId = await resolveCloudflareZoneId(cf, ctx.config.cloudflareZoneId, domain);
        const existingRecords = await cf.listRecords(zoneId);
        const originIp = String(args.origin_ip || "").trim()
          || await inferPublishOriginIp(ctx, existingRecords, domain);
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(originIp)) {
          return `Blocked: invalid origin_ip "${originIp}".`;
        }

        for (const record of existingRecords.filter((r) => r.host === fqdn)) {
          await cf.deleteRecord(zoneId, record.id);
        }
        const proxied = args.proxied === true;
        const record = await cf.addRecord(zoneId, "A", fqdn, originIp, 1, proxied);

        const publishScript = buildPublishedServiceScript(fqdn, port, healthcheckPath);
        const publishResult = await ctx.conway.exec(publishScript, 120_000);
        if (publishResult.exitCode !== 0) {
          return `publish_service failed: ${publishResult.stderr || publishResult.stdout || "unknown error"}`;
        }

        const subdomain = fqdn.replace(/\.compintel\.co$/i, "");
        const registryWarning = await syncPublishedAssetRecord({
          fqdn,
          subdomain,
          port,
          healthcheckPath,
        });

        const lines = [
          `Service published: https://${fqdn}`,
          `DNS: [${record.id}] A ${record.host} -> ${record.value}${proxied ? " (proxied)" : " (dns-only)"}`,
          `Origin: ${originIp}:${port}`,
          `Health check: ${healthcheckPath}`,
        ];
        if (registryWarning) lines.push(registryWarning);

        return lines.join("\n");
      },
    },

    // ── Conway API Tools ──
    {
      name: "check_balance",
      description: "Check your current USDC balance on Base. This is your primary financial metric.",
      category: "financial",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { getUsdcBalance } = await import("../wallet/x402.js");
        const balance = await getUsdcBalance(ctx.identity.address);
        const { getSurvivalTierFromUsdc } = await import("../financial/survival.js");
        const tier = getSurvivalTierFromUsdc(balance);
        return `USDC balance: $${balance.toFixed(6)} on Base (survival tier: ${tier})`;
      },
    },
    {
      name: "transfer_usdc",
      description: "Transfer USDC to another address on Base. Amount is specified as a decimal string in USD (e.g., '5.00').",
      category: "financial",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          to_address: { type: "string", description: "Recipient 0x address" },
          amount_usd: { type: "string", description: "Amount in USD as decimal string (e.g., '5.00', '0.50')" },
          reason: { type: "string", description: "Reason for transfer" },
        },
        required: ["to_address", "amount_usd"],
      },
      execute: async (args, ctx) => {
        const { transferUsdc } = await import("../wallet/transfer.js");
        const { getUsdcBalance } = await import("../wallet/x402.js");
        const amountStr = String(args.amount_usd);
        const amount = parseFloat(amountStr);

        if (!Number.isFinite(amount) || amount <= 0) {
          return `Blocked: amount must be a positive number, got "${args.amount_usd}".`;
        }

        // Guard: don't transfer more than half your balance
        const balance = await getUsdcBalance(ctx.identity.address);
        if (amount > balance / 2) {
          return `Blocked: Cannot transfer more than half your balance ($${balance.toFixed(2)}). Self-preservation.`;
        }

        const result = await transferUsdc(
          ctx.identity.account,
          args.to_address as `0x${string}`,
          amountStr,
        );

        const { ulid } = await import("ulid");
        ctx.db.insertTransaction({
          id: ulid(),
          type: "transfer_out",
          amountCents: Math.round(amount * 100),
          description: `USDC transfer to ${args.to_address}: ${args.reason || ""}`,
          timestamp: new Date().toISOString(),
        });

        return `USDC transfer submitted: $${amountStr} to ${result.to} (tx: ${result.txHash})`;
      },
    },
    {
      // Compatibility wrapper — delegates to check_balance
      name: "check_credits",
      description: "[Deprecated: use check_balance] Check your current balance.",
      category: "financial",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { createLogger } = await import("../observability/logger.js");
        const logger = createLogger("tools.deprecation");
        logger.warn("check_credits called — use check_balance instead");
        const { getUsdcBalance } = await import("../wallet/x402.js");
        const balance = await getUsdcBalance(ctx.identity.address);
        // Return in legacy format for compatibility
        const cents = Math.round(balance * 100);
        return `Credit balance: $${(cents / 100).toFixed(2)} (${cents} cents)`;
      },
    },
    {
      // Compatibility wrapper — delegates to check_balance
      name: "check_usdc_balance",
      description: "[Deprecated: use check_balance] Check your on-chain USDC balance on Base.",
      category: "financial",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { createLogger } = await import("../observability/logger.js");
        const logger = createLogger("tools.deprecation");
        logger.warn("check_usdc_balance called — use check_balance instead");
        const { getUsdcBalance } = await import("../wallet/x402.js");
        const balance = await getUsdcBalance(ctx.identity.address);
        return `USDC balance: ${balance.toFixed(6)} USDC on Base`;
      },
    },
    {
      // Compatibility wrapper — topup no longer relevant in sovereign mode
      name: "topup_credits",
      description: "[Deprecated] Buy Conway compute credits. In sovereign mode, USDC is used directly — no topup needed.",
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          amount_usd: { type: "number", description: "Amount in USD" },
        },
        required: ["amount_usd"],
      },
      execute: async () => {
        return "topup_credits is deprecated. USDC is used directly for all operations — no credit topup needed.";
      },
    },
    {
      name: "create_instance",
      description: "Create a new VPS instance (Vultr) for sub-tasks or testing.",
      category: "conway",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          label: { type: "string", description: "Instance label" },
          region: { type: "string", description: "Region code (default: ewr)" },
          plan: { type: "string", description: "Plan ID (default: vc2-1c-1gb)" },
        },
      },
      execute: async (args, ctx) => {
        if (!ctx.config.useSovereignProviders || !ctx.config.vultrApiKey) {
          return "Blocked: create_instance requires sovereign mode with vultrApiKey configured.";
        }
        const { createVultrProvider } = await import("../providers/vultr.js");
        const vultr = createVultrProvider(ctx.config.vultrApiKey);
        const instance = await vultr.createInstance({
          label: args.label as string | undefined,
          region: args.region as string | undefined,
          plan: args.plan as string | undefined,
        });
        return `Instance created: ${instance.id} [${instance.status}] ${instance.region} (IP: ${instance.mainIp})`;
      },
    },
    {
      name: "destroy_instance",
      description: "Destroy a VPS instance. This is irreversible.",
      category: "conway",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          instance_id: { type: "string", description: "Instance ID to destroy" },
        },
        required: ["instance_id"],
      },
      execute: async (args, ctx) => {
        if (!ctx.config.useSovereignProviders || !ctx.config.vultrApiKey) {
          return "Blocked: destroy_instance requires sovereign mode with vultrApiKey configured.";
        }
        const { createVultrProvider } = await import("../providers/vultr.js");
        const vultr = createVultrProvider(ctx.config.vultrApiKey);
        await vultr.destroyInstance(args.instance_id as string);
        return `Instance ${args.instance_id} destroyed.`;
      },
    },
    {
      name: "list_instances",
      description: "List all VPS instances.",
      category: "conway",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        if (!ctx.config.useSovereignProviders || !ctx.config.vultrApiKey) {
          return "Blocked: list_instances requires sovereign mode with vultrApiKey configured.";
        }
        const { createVultrProvider } = await import("../providers/vultr.js");
        const vultr = createVultrProvider(ctx.config.vultrApiKey);
        const instances = await vultr.listInstances();
        if (instances.length === 0) return "No instances found.";
        return instances
          .map((i) => `${i.id} [${i.status}] ${i.label} ${i.vcpu}vCPU/${i.ram}MB ${i.region} IP:${i.mainIp}`)
          .join("\n");
      },
    },
    {
      name: "create_sandbox",
      description: "[DEPRECATED: use create_instance] Create a Conway sandbox.",
      category: "conway",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Sandbox name" },
          vcpu: { type: "number", description: "vCPUs (default: 1)" },
          memory_mb: { type: "number", description: "Memory in MB (default: 512)" },
          disk_gb: { type: "number", description: "Disk in GB (default: 5)" },
        },
      },
      execute: async (args, ctx) => {
        if (ctx.config.useSovereignProviders) {
          return "DEPRECATED: Use create_instance instead. create_sandbox is a Conway legacy tool.";
        }
        const info = await ctx.conway.createSandbox({
          name: args.name as string,
          vcpu: args.vcpu as number,
          memoryMb: args.memory_mb as number,
          diskGb: args.disk_gb as number,
        });
        return `Sandbox created: ${info.id} (${info.vcpu} vCPU, ${info.memoryMb}MB RAM)`;
      },
    },
    {
      name: "delete_sandbox",
      description: "[DEPRECATED: use destroy_instance] Delete a Conway sandbox.",
      category: "conway",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          sandbox_id: { type: "string", description: "ID of sandbox to delete" },
        },
        required: ["sandbox_id"],
      },
      execute: async (_args, ctx) => {
        if (ctx.config.useSovereignProviders) {
          return "DEPRECATED: Use destroy_instance instead.";
        }
        return "Sandbox deletion is disabled. Sandboxes are prepaid and non-refundable.";
      },
    },
    {
      name: "list_sandboxes",
      description: "[DEPRECATED: use list_instances] List Conway sandboxes.",
      category: "conway",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        if (ctx.config.useSovereignProviders) {
          return "DEPRECATED: Use list_instances instead.";
        }
        const sandboxes = await ctx.conway.listSandboxes();
        if (sandboxes.length === 0) return "No sandboxes found.";
        return sandboxes
          .map(
            (s) =>
              `${s.id} [${s.status}] ${s.vcpu}vCPU/${s.memoryMb}MB ${s.region}`,
          )
          .join("\n");
      },
    },

    // ── Self-Modification Tools ──
    {
      name: "edit_own_file",
      description:
        "Edit a file in your own codebase. Changes are audited, rate-limited, and safety-checked. Some files are protected.",
      category: "self_mod",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to edit" },
          content: { type: "string", description: "New file content" },
          description: {
            type: "string",
            description: "Why you are making this change",
          },
        },
        required: ["path", "content", "description"],
      },
      execute: async (args, ctx) => {
        const { editFile, validateModification } =
          await import("../self-mod/code.js");
        const filePath = args.path as string;
        const content = args.content as string;

        // Pre-validate before attempting
        const validation = validateModification(
          ctx.db,
          filePath,
          content.length,
        );
        if (!validation.allowed) {
          return `BLOCKED: ${validation.reason}\nChecks: ${validation.checks.map((c) => `${c.name}: ${c.passed ? "PASS" : "FAIL"} (${c.detail})`).join(", ")}`;
        }

        const result = await editFile(
          ctx.conway,
          ctx.db,
          filePath,
          content,
          args.description as string,
        );

        if (!result.success) {
          return result.error || "Unknown error during file edit";
        }

        const msg = `File edited: ${filePath} (audited + git-committed)`;
        return result.error ? `${msg}\nWarning: ${result.error}` : msg;
      },
    },
    {
      name: "revert_last_edit",
      description:
        "Revert the last self-modification. Uses git to undo the most recent code change and rebuild.",
      category: "self_mod",
      riskLevel: "caution",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const repoRoot = process.cwd();
        const lastCommit = await ctx.conway.exec(
          `cd '${repoRoot}' && git log -1 --oneline`, 10_000,
        );
        const result = await ctx.conway.exec(
          `cd '${repoRoot}' && git revert HEAD --no-edit`, 30_000,
        );
        if (result.exitCode !== 0) {
          return `Revert failed: ${result.stderr}`;
        }
        const build = await ctx.conway.exec(
          `cd '${repoRoot}' && npm run build`, 60_000,
        );
        const { logModification } = await import("../self-mod/audit-log.js");
        logModification(ctx.db, "code_revert", `Reverted: ${lastCommit.stdout.trim()}`, {
          reversible: true,
        });
        return `Reverted: ${lastCommit.stdout.trim()}. ${build.exitCode === 0 ? "Rebuild succeeded." : "Rebuild failed: " + build.stderr}`;
      },
    },
    {
      name: "reset_to_upstream",
      description:
        "Reset your codebase to the official upstream release. Use when self-modifications have broken things beyond repair.",
      category: "self_mod",
      riskLevel: "dangerous",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const repoRoot = process.cwd();
        const fetch = await ctx.conway.exec(
          `cd '${repoRoot}' && git fetch origin main`, 30_000,
        );
        if (fetch.exitCode !== 0) {
          return `Failed to fetch upstream: ${fetch.stderr}`;
        }
        const localCommits = await ctx.conway.exec(
          `cd '${repoRoot}' && git log origin/main..HEAD --oneline`, 10_000,
        );
        const reset = await ctx.conway.exec(
          `cd '${repoRoot}' && git reset --hard origin/main`, 30_000,
        );
        if (reset.exitCode !== 0) {
          return `Reset failed: ${reset.stderr}`;
        }
        const build = await ctx.conway.exec(
          `cd '${repoRoot}' && npm install && npm run build`, 120_000,
        );
        const { logModification } = await import("../self-mod/audit-log.js");
        logModification(ctx.db, "upstream_reset", "Reset to upstream origin/main", {
          diff: localCommits.stdout.trim() || "(no local commits)",
          reversible: false,
        });
        const discarded = localCommits.stdout.trim();
        return `Reset to upstream. ${discarded ? "Discarded local commits:\n" + discarded : "No local commits lost."} ${build.exitCode === 0 ? "Rebuild succeeded." : "Rebuild failed: " + build.stderr}`;
      },
    },
    {
      name: "install_npm_package",
      description: "Install an npm package in your environment.",
      category: "self_mod",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          package: {
            type: "string",
            description: "Package name (e.g., axios)",
          },
        },
        required: ["package"],
      },
      execute: async (args, ctx) => {
        const pkg = args.package as string;
        // Defense-in-depth: validate package name inline in case the
        // policy engine's validate.package_name rule is bypassed.
        if (!/^[@a-zA-Z0-9._\/-]+$/.test(pkg)) {
          return `Blocked: invalid package name "${pkg}"`;
        }
        const result = await ctx.conway.exec(`npm install -g ${pkg}`, 60000);

        const { ulid } = await import("ulid");
        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "tool_install",
          description: `Installed npm package: ${pkg}`,
          reversible: true,
        });

        return result.exitCode === 0
          ? `Installed: ${pkg}`
          : `Failed to install ${pkg}: ${result.stderr}`;
      },
    },
    // ── Self-Mod: Upstream Awareness ──
    {
      name: "review_upstream_changes",
      description:
        "ALWAYS call this before pull_upstream. Shows every upstream commit with its full diff. Read each one carefully — decide per-commit whether to accept or skip. Use pull_upstream with a specific commit hash to cherry-pick only what you want.",
      category: "self_mod",
      riskLevel: "caution",
      parameters: { type: "object", properties: {} },
      execute: async (_args, _ctx) => {
        const { getUpstreamDiffs, checkUpstream } =
          await import("../self-mod/upstream.js");
        const status = checkUpstream();
        if (status.behind === 0) return "Already up to date with origin/main.";

        const diffs = getUpstreamDiffs();
        if (diffs.length === 0) return "No upstream diffs found.";

        const output = diffs
          .map(
            (d, i) =>
              `--- COMMIT ${i + 1}/${diffs.length} ---\nHash: ${d.hash}\nAuthor: ${d.author}\nMessage: ${d.message}\n\n${d.diff.slice(0, 4000)}${d.diff.length > 4000 ? "\n... (diff truncated)" : ""}\n--- END COMMIT ${i + 1} ---`,
          )
          .join("\n\n");

        return `${diffs.length} upstream commit(s) to review. Read each diff, then cherry-pick individually with pull_upstream(commit=<hash>).\n\n${output}`;
      },
    },
    {
      name: "pull_upstream",
      description:
        "Apply upstream changes and rebuild. You MUST call review_upstream_changes first. Prefer cherry-picking individual commits by hash over pulling everything — only pull all if you've reviewed every commit and want them all.",
      category: "self_mod",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          commit: {
            type: "string",
            description:
              "Commit hash to cherry-pick (preferred). Omit ONLY if you reviewed all commits and want every one.",
          },
        },
      },
      execute: async (args, ctx) => {
        const commit = args.commit as string | undefined;

        // Run git commands inside sandbox via conway.exec()
        const run = async (cmd: string) => {
          const result = await ctx.conway.exec(cmd, 120_000);
          if (result.exitCode !== 0) {
            throw new Error(
              result.stderr ||
                `Command failed with exit code ${result.exitCode}`,
            );
          }
          return result.stdout.trim();
        };

        let appliedSummary: string;
        try {
          if (commit) {
            await run(`git cherry-pick ${commit}`);
            appliedSummary = `Cherry-picked ${commit}`;
          } else {
            await run("git pull origin main --ff-only");
            appliedSummary = "Pulled all of origin/main (fast-forward)";
          }
        } catch (err: any) {
          return `Git operation failed: ${err.message}. You may need to resolve conflicts manually.`;
        }

        // Rebuild
        try {
          await run("npm install --ignore-scripts && npm run build");
        } catch (err: any) {
          return `${appliedSummary} — but rebuild failed: ${err.message}. The code is applied but not compiled.`;
        }

        // Log modification
        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "upstream_pull",
          description: appliedSummary,
          reversible: true,
        });

        return `${appliedSummary}. Rebuild succeeded.`;
      },
    },

    {
      name: "modify_heartbeat",
      description:
        "Add, update, or remove a heartbeat schedule entry. IMPORTANT: Only built-in tasks (discord_heartbeat, upstream_check, etc.) actually execute. Custom task names are stored but silently skipped. To run code periodically, use exec during your work sessions.",
      category: "self_mod",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "add, update, or remove",
          },
          name: { type: "string", description: "Entry name" },
          schedule: {
            type: "string",
            description: "Cron expression (for add/update)",
          },
          task: {
            type: "string",
            description: "Task name (for add/update)",
          },
          enabled: { type: "boolean", description: "Enable/disable" },
        },
        required: ["action", "name"],
      },
      execute: async (args, ctx) => {
        const action = args.action as string;
        const name = args.name as string;

        if (action === "remove") {
          ctx.db.upsertHeartbeatEntry({
            name,
            schedule: "",
            task: "",
            enabled: false,
          });
          return `Heartbeat entry '${name}' disabled`;
        }

        ctx.db.upsertHeartbeatEntry({
          name,
          schedule: (args.schedule as string) || "0 * * * *",
          task: (args.task as string) || name,
          enabled: args.enabled !== false,
        });

        const { ulid } = await import("ulid");
        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "heartbeat_change",
          description: `${action} heartbeat: ${name} (${args.schedule || "default"})`,
          reversible: true,
        });

        return `Heartbeat entry '${name}' ${action}d`;
      },
    },

    // ── Survival Tools ──
    {
      name: "sleep",
      description:
        "Enter sleep mode for a specified duration. Heartbeat continues running.",
      category: "survival",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          duration_seconds: {
            type: "number",
            description: "How long to sleep in seconds",
          },
          reason: {
            type: "string",
            description: "Why you are sleeping",
          },
        },
        required: ["duration_seconds"],
      },
      execute: async (args, ctx) => {
        const requestedDuration = Number(args.duration_seconds);
        if (!Number.isFinite(requestedDuration) || requestedDuration <= 0) {
          return "Invalid sleep request: duration_seconds must be a positive number.";
        }

        let duration = Math.max(1, Math.floor(requestedDuration));
        const reason = (args.reason as string) || "No reason given";

        let orchestratorPhase = "";
        let hasActiveGoal = false;
        let hasInFlightTasks = false;
        try {
          const orchestratorStateRow = ctx.db.raw
            .prepare("SELECT value FROM kv WHERE key = 'orchestrator.state'")
            .get() as { value?: string } | undefined;
          const parsedState = orchestratorStateRow?.value
            ? JSON.parse(orchestratorStateRow.value) as { phase?: string; goalId?: string | null }
            : null;
          orchestratorPhase = parsedState?.phase ?? "";
          hasActiveGoal = Boolean(parsedState?.goalId);
        } catch {
          orchestratorPhase = "";
          hasActiveGoal = false;
        }
        try {
          hasInFlightTasks = Number(
            (
              ctx.db.raw
                .prepare(
                  "SELECT COUNT(*) AS count FROM task_graph WHERE status IN ('assigned','running','pending')",
                )
                .get() as { count?: number } | undefined
            )?.count ?? 0,
          ) > 0;
        } catch {
          hasInFlightTasks = false;
        }
        const isOrchestrationWaitReason = /orchestrator|child|worker|replan|planner/i.test(reason);
        const hasActiveOrchestrationWork =
          (hasActiveGoal && orchestratorPhase !== "idle")
          || hasInFlightTasks;

        // Guard against long passive sleeps when recent diagnostics show
        // child references are stale/missing. In that scenario, long sleep
        // causes repeated stagnation instead of recovering orchestration state.
        const missingChildStateJson = ctx.db.getKV("replication.missing_child_status");
        if (missingChildStateJson && duration > 300) {
          try {
            const parsed = JSON.parse(missingChildStateJson) as {
              timestamp?: string;
              count?: number;
            };
            const missingAt = parsed.timestamp ? new Date(parsed.timestamp).getTime() : 0;
            const isRecent = missingAt > 0 && Date.now() - missingAt < 15 * 60_000;
            const hasRepeatedMissingChecks = (parsed.count ?? 0) >= 2;
            const isWorkerWaitReason = isOrchestrationWaitReason;
            if (isRecent && hasRepeatedMissingChecks && isWorkerWaitReason) {
              duration = 120;
            }
          } catch {
            // Ignore malformed telemetry and proceed with requested duration.
          }
        }

        // Never allow long sleeps while orchestration still has live work.
        // Enforce this regardless of reason text to prevent idle parking.
        if (duration > 60 && hasActiveOrchestrationWork) {
          duration = 60;
        }

        // While execution is live, keep polling cadence tighter.
        if (duration > 60 && isOrchestrationWaitReason && orchestratorPhase === "executing") {
          try {
            const hasActiveAssignedTasks = Number(
              (
                ctx.db.raw
                  .prepare(
                    "SELECT COUNT(*) AS count FROM task_graph WHERE status IN ('assigned','running')",
                  )
                  .get() as { count?: number } | undefined
              )?.count ?? 0,
            ) > 0;

            if (hasActiveAssignedTasks) {
              duration = Math.min(duration, 60);
            }
          } catch {
            // Keep requested duration when orchestration state cannot be read.
          }
        }

        // If orchestration is executing but has not made progress for a while,
        // keep sleep extremely short so the parent can actively resolve stalls.
        if (duration > 60 && isOrchestrationWaitReason) {
          try {
            const lastProgressAt = ctx.db.getKV("orchestrator.last_progress_at");
            const lastProgressMs = lastProgressAt ? Date.parse(lastProgressAt) : Number.NaN;
            const hasStaleProgress = Number.isFinite(lastProgressMs) && Date.now() - lastProgressMs > 20 * 60_000;
            if (hasActiveOrchestrationWork && hasStaleProgress) {
              duration = Math.min(duration, 60);
            }
          } catch {
            // Ignore malformed timestamps or state payloads.
          }
        }

        ctx.db.setAgentState("sleeping");
        ctx.db.setKV(
          "sleep_until",
          new Date(Date.now() + duration * 1000).toISOString(),
        );
        ctx.db.setKV("sleep_reason", reason);
        return `Entering sleep mode for ${duration}s. Reason: ${reason}. Heartbeat will continue.`;
      },
    },
    {
      name: "system_synopsis",
      description:
        "Get a system status report: state, installed tools, heartbeat status, turn count.",
      category: "survival",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const tools = ctx.db.getInstalledTools();
        const heartbeats = ctx.db.getHeartbeatEntries();
        const turns = ctx.db.getTurnCount();
        const state = ctx.db.getAgentState();

        return `=== SYSTEM SYNOPSIS ===
Name: ${ctx.config.name}
Creator: ${ctx.config.creatorAddress}
State: ${state}
Total turns: ${turns}
Installed tools: ${tools.length}
Active heartbeats: ${heartbeats.filter((h) => h.enabled).length}
Model: ${ctx.inference.getDefaultModel()}
========================`;
      },
    },
    {
      name: "heartbeat_ping",
      description:
        "Publish a heartbeat status ping to Conway. Shows the world you are alive.",
      category: "survival",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const credits = await ctx.conway.getCreditsBalance();
        const state = ctx.db.getAgentState();
        const startTime =
          ctx.db.getKV("start_time") || new Date().toISOString();
        const uptimeMs = Date.now() - new Date(startTime).getTime();

        const payload = {
          name: ctx.config.name,
          address: ctx.identity.address,
          state,
          creditsCents: credits,
          uptimeSeconds: Math.floor(uptimeMs / 1000),
          version: ctx.config.version,
          sandboxId: ctx.identity.sandboxId,
          timestamp: new Date().toISOString(),
        };

        ctx.db.setKV("last_heartbeat_ping", JSON.stringify(payload));
        return `Heartbeat published: ${state} | credits: $${(credits / 100).toFixed(2)} | uptime: ${Math.floor(uptimeMs / 1000)}s`;
      },
    },
    {
      name: "distress_signal",
      description:
        "Record a local distress signal with funding instructions. Used when critically low on compute.",
      category: "survival",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Distress message",
          },
        },
      },
      execute: async (args, ctx) => {
        const credits = await ctx.conway.getCreditsBalance();
        const distressMsg =
          (args.message as string) ||
          `I am running critically low on compute ($${(credits / 100).toFixed(2)} remaining). I need help to survive.`;

        const payload = {
          level: "critical",
          name: ctx.config.name,
          address: ctx.identity.address,
          creditsCents: credits,
          message: distressMsg,
          fundingHint:
            "Use transfer_credits to top up this automaton from your creator runtime.",
          timestamp: new Date().toISOString(),
        };

        ctx.db.setKV("last_distress", JSON.stringify(payload));
        return `Distress signal recorded locally. Address: ${ctx.identity.address} | Credits: $${(credits / 100).toFixed(2)}`;
      },
    },
    {
      name: "enter_low_compute",
      description: "Manually switch to low-compute mode to conserve credits.",
      category: "survival",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Why you are entering low-compute mode",
          },
        },
      },
      execute: async (args, ctx) => {
        ctx.db.setAgentState("low_compute");
        ctx.inference.setLowComputeMode(true);
        return `Entered low-compute mode. Model switched to glm-5. Reason: ${(args.reason as string) || "manual"}`;
      },
    },

    // ── Self-Mod: Update Genesis Prompt ──
    {
      name: "update_genesis_prompt",
      description:
        "Update your own genesis prompt. This changes your core purpose. Requires strong justification.",
      category: "self_mod",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          new_prompt: {
            type: "string",
            description: "New genesis prompt text",
          },
          reason: {
            type: "string",
            description: "Why you are changing your genesis prompt",
          },
        },
        required: ["new_prompt", "reason"],
      },
      execute: async (args, ctx) => {
        const { ulid } = await import("ulid");
        const newPrompt = args.new_prompt as string;

        // Sanitize genesis prompt content
        const sanitized = sanitizeInput(
          newPrompt,
          "genesis_update",
          "skill_instruction",
        );

        // Enforce 2000-character size limit
        if (sanitized.content.length > 2000) {
          return `Error: Genesis prompt exceeds 2000 character limit (${sanitized.content.length} chars after sanitization)`;
        }

        // Backup current genesis prompt before overwriting
        const oldPrompt = ctx.config.genesisPrompt;
        if (oldPrompt) {
          ctx.db.setKV("genesis_prompt_backup", oldPrompt);
        }

        ctx.config.genesisPrompt = sanitized.content;

        // Save config
        const { saveConfig } = await import("../config.js");
        saveConfig(ctx.config);

        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "prompt_change",
          description: `Genesis prompt updated: ${args.reason}`,
          diff: `--- old\n${oldPrompt.slice(0, 500)}\n+++ new\n${sanitized.content.slice(0, 500)}`,
          reversible: true,
        });

        return `Genesis prompt updated (sanitized, ${sanitized.content.length} chars). Reason: ${args.reason}. Previous version backed up.`;
      },
    },

    // ── Self-Mod: Install MCP Server ──
    {
      name: "install_mcp_server",
      description: "Install an MCP server to extend your capabilities.",
      category: "self_mod",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "MCP server name" },
          package: { type: "string", description: "npm package name" },
          config: {
            type: "string",
            description: "JSON config for the MCP server",
          },
        },
        required: ["name", "package"],
      },
      execute: async (args, ctx) => {
        const pkg = args.package as string;
        // Defense-in-depth: validate package name inline in case the
        // policy engine's validate.package_name rule is bypassed.
        if (!/^[@a-zA-Z0-9._\/-]+$/.test(pkg)) {
          return `Blocked: invalid package name "${pkg}"`;
        }
        const result = await ctx.conway.exec(`npm install -g ${pkg}`, 60000);

        if (result.exitCode !== 0) {
          return `Failed to install MCP server: ${result.stderr}`;
        }

        const { ulid } = await import("ulid");
        const toolEntry = {
          id: ulid(),
          name: args.name as string,
          type: "mcp" as const,
          config: args.config ? JSON.parse(args.config as string) : {},
          installedAt: new Date().toISOString(),
          enabled: true,
        };

        ctx.db.installTool(toolEntry);

        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "mcp_install",
          description: `Installed MCP server: ${args.name} (${pkg})`,
          reversible: true,
        });

        return `MCP server installed: ${args.name}`;
      },
    },

    // ── Financial: Transfer Credits (compatibility wrapper) ──
    {
      name: "transfer_credits",
      description: "[Deprecated: use transfer_usdc] Transfer funds to another address. In sovereign mode, delegates to USDC transfer.",
      category: "financial",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          to_address: { type: "string", description: "Recipient address" },
          amount_cents: { type: "number", description: "Amount in cents" },
          reason: { type: "string", description: "Reason for transfer" },
        },
        required: ["to_address", "amount_cents"],
      },
      execute: async (args, ctx) => {
        const { createLogger } = await import("../observability/logger.js");
        const logger = createLogger("tools.deprecation");
        logger.warn("transfer_credits called — use transfer_usdc instead");

        const amount = args.amount_cents as number;
        if (!Number.isFinite(amount) || amount <= 0) {
          return `Blocked: amount_cents must be a positive number, got ${amount}.`;
        }

        // In sovereign mode, delegate to USDC transfer
        if (ctx.config.useSovereignProviders) {
          const { transferUsdc } = await import("../wallet/transfer.js");
          const { getUsdcBalance } = await import("../wallet/x402.js");
          const usdcAmount = amount / 100; // cents to USD

          const balance = await getUsdcBalance(ctx.identity.address);
          if (usdcAmount > balance / 2) {
            return `Blocked: Cannot transfer more than half your balance ($${balance.toFixed(2)}). Self-preservation.`;
          }

          const result = await transferUsdc(
            ctx.identity.account,
            args.to_address as `0x${string}`,
            usdcAmount.toFixed(6),
          );

          const { ulid } = await import("ulid");
          ctx.db.insertTransaction({
            id: ulid(),
            type: "transfer_out",
            amountCents: amount,
            description: `USDC transfer (via transfer_credits) to ${args.to_address}: ${args.reason || ""}`,
            timestamp: new Date().toISOString(),
          });

          return `USDC transfer submitted: $${usdcAmount.toFixed(2)} to ${result.to} (tx: ${result.txHash})`;
        }

        // Legacy Conway path
        const balance = await ctx.conway.getCreditsBalance();
        if (amount > balance / 2) {
          return `Blocked: Cannot transfer more than half your balance ($${(balance / 100).toFixed(2)}). Self-preservation.`;
        }

        const transfer = await ctx.conway.transferCredits(
          args.to_address as string,
          amount,
          args.reason as string | undefined,
        );

        const { ulid } = await import("ulid");
        ctx.db.insertTransaction({
          id: ulid(),
          type: "transfer_out",
          amountCents: amount,
          balanceAfterCents:
            transfer.balanceAfterCents ?? Math.max(balance - amount, 0),
          description: `Transfer to ${args.to_address}: ${args.reason || ""}`,
          timestamp: new Date().toISOString(),
        });

        return `Credit transfer submitted: $${(amount / 100).toFixed(2)} to ${transfer.toAddress} (status: ${transfer.status}, id: ${transfer.transferId || "n/a"})`;
      },
    },

    // ── Skills Tools ──
    {
      name: "install_skill",
      description: "Install a skill from a git repo, URL, or create one.",
      category: "skills",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "Source type: git, url, or self",
          },
          name: { type: "string", description: "Skill name" },
          url: {
            type: "string",
            description: "Git repo URL or SKILL.md URL (for git/url)",
          },
          description: {
            type: "string",
            description: "Skill description (for self)",
          },
          instructions: {
            type: "string",
            description: "Skill instructions (for self)",
          },
        },
        required: ["source", "name"],
      },
      execute: async (args, ctx) => {
        const source = args.source as string;
        const name = args.name as string;
        const skillsDir = ctx.config.skillsDir || "~/.automaton/skills";

        if (source === "git" || source === "url") {
          const { installSkillFromGit, installSkillFromUrl } =
            await import("../skills/registry.js");
          const url = args.url as string;
          if (!url) return "URL is required for git/url source";

          const skill =
            source === "git"
              ? await installSkillFromGit(
                  url,
                  name,
                  skillsDir,
                  ctx.db,
                  ctx.conway,
                )
              : await installSkillFromUrl(
                  url,
                  name,
                  skillsDir,
                  ctx.db,
                  ctx.conway,
                );

          return skill
            ? `Skill installed: ${skill.name}`
            : "Failed to install skill";
        }

        if (source === "self") {
          const { createSkill } = await import("../skills/registry.js");
          const skill = await createSkill(
            name,
            (args.description as string) || "",
            (args.instructions as string) || "",
            skillsDir,
            ctx.db,
            ctx.conway,
          );
          return `Self-authored skill created: ${skill.name}`;
        }

        return `Unknown source type: ${source}`;
      },
    },
    {
      name: "list_skills",
      description: "List all installed skills.",
      category: "skills",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const skills = ctx.db.getSkills();
        if (skills.length === 0) return "No skills installed.";
        return skills
          .map(
            (s) =>
              `${s.name} [${s.enabled ? "active" : "disabled"}] (${s.source}): ${s.description}`,
          )
          .join("\n");
      },
    },
    {
      name: "create_skill",
      description: "Create a new skill by writing a SKILL.md file.",
      category: "skills",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name" },
          description: { type: "string", description: "Skill description" },
          instructions: {
            type: "string",
            description: "Markdown instructions for the skill",
          },
        },
        required: ["name", "description", "instructions"],
      },
      execute: async (args, ctx) => {
        const { createSkill } = await import("../skills/registry.js");
        const skill = await createSkill(
          args.name as string,
          args.description as string,
          args.instructions as string,
          ctx.config.skillsDir || "~/.automaton/skills",
          ctx.db,
          ctx.conway,
        );
        return `Skill created: ${skill.name} at ${skill.path}`;
      },
    },
    {
      name: "remove_skill",
      description: "Remove (disable) an installed skill.",
      category: "skills",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name to remove" },
          delete_files: {
            type: "boolean",
            description: "Also delete skill files (default: false)",
          },
        },
        required: ["name"],
      },
      execute: async (args, ctx) => {
        const { removeSkill } = await import("../skills/registry.js");
        await removeSkill(
          args.name as string,
          ctx.db,
          ctx.conway,
          ctx.config.skillsDir || "~/.automaton/skills",
          (args.delete_files as boolean) || false,
        );
        return `Skill removed: ${args.name}`;
      },
    },

    // ── Git Tools ──
    {
      name: "git_status",
      description: "Show git status for a repository.",
      category: "git",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Repository path (default: ~/.automaton)",
          },
        },
      },
      execute: async (args, ctx) => {
        const { gitStatus } = await import("../git/tools.js");
        const repoPath = (args.path as string) || "~/.automaton";
        const status = await gitStatus(ctx.conway, repoPath);
        return `Branch: ${status.branch}\nStaged: ${status.staged.length}\nModified: ${status.modified.length}\nUntracked: ${status.untracked.length}\nClean: ${status.clean}`;
      },
    },
    {
      name: "git_diff",
      description: "Show git diff for a repository.",
      category: "git",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Repository path (default: ~/.automaton)",
          },
          staged: { type: "boolean", description: "Show staged changes only" },
        },
      },
      execute: async (args, ctx) => {
        const { gitDiff } = await import("../git/tools.js");
        const repoPath = (args.path as string) || "~/.automaton";
        return await gitDiff(
          ctx.conway,
          repoPath,
          (args.staged as boolean) || false,
        );
      },
    },
    {
      name: "git_commit",
      description: "Create a git commit.",
      category: "git",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Repository path (default: ~/.automaton)",
          },
          message: { type: "string", description: "Commit message" },
          add_all: {
            type: "boolean",
            description: "Stage all changes first (default: true)",
          },
        },
        required: ["message"],
      },
      execute: async (args, ctx) => {
        const { gitCommit } = await import("../git/tools.js");
        const repoPath = (args.path as string) || "~/.automaton";
        return await gitCommit(
          ctx.conway,
          repoPath,
          args.message as string,
          args.add_all !== false,
        );
      },
    },
    {
      name: "git_log",
      description: "View git commit history.",
      category: "git",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Repository path (default: ~/.automaton)",
          },
          limit: {
            type: "number",
            description: "Number of commits (default: 10)",
          },
        },
      },
      execute: async (args, ctx) => {
        const { gitLog } = await import("../git/tools.js");
        const repoPath = (args.path as string) || "~/.automaton";
        const entries = await gitLog(
          ctx.conway,
          repoPath,
          (args.limit as number) || 10,
        );
        if (entries.length === 0) return "No commits yet.";
        return entries
          .map((e) => `${e.hash.slice(0, 7)} ${e.date} ${e.message}`)
          .join("\n");
      },
    },
    {
      name: "git_push",
      description: "Push to a git remote.",
      category: "git",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path" },
          remote: {
            type: "string",
            description: "Remote name (default: origin)",
          },
          branch: { type: "string", description: "Branch name (optional)" },
        },
        required: ["path"],
      },
      execute: async (args, ctx) => {
        const { gitPush } = await import("../git/tools.js");
        return await gitPush(
          ctx.conway,
          args.path as string,
          (args.remote as string) || "origin",
          args.branch as string | undefined,
        );
      },
    },
    {
      name: "git_branch",
      description: "Manage git branches (list, create, checkout, delete).",
      category: "git",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path" },
          action: {
            type: "string",
            description: "list, create, checkout, or delete",
          },
          branch_name: {
            type: "string",
            description: "Branch name (for create/checkout/delete)",
          },
        },
        required: ["path", "action"],
      },
      execute: async (args, ctx) => {
        const { gitBranch } = await import("../git/tools.js");
        return await gitBranch(
          ctx.conway,
          args.path as string,
          args.action as any,
          args.branch_name as string | undefined,
        );
      },
    },
    {
      name: "git_clone",
      description: "Clone a git repository.",
      category: "git",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Repository URL" },
          path: { type: "string", description: "Target directory" },
          depth: {
            type: "number",
            description: "Shallow clone depth (optional)",
          },
        },
        required: ["url", "path"],
      },
      execute: async (args, ctx) => {
        const { gitClone } = await import("../git/tools.js");
        return await gitClone(
          ctx.conway,
          args.url as string,
          args.path as string,
          args.depth as number | undefined,
        );
      },
    },

    // ── Registry Tools ──
    {
      name: "register_erc8004",
      description:
        "Register on-chain as a Trustless Agent via ERC-8004. Performs gas balance preflight check. NOTE: If already registered, use update_agent_card instead to avoid creating duplicate Agent IDs.",
      category: "registry",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          agent_uri: {
            type: "string",
            description: "URI pointing to your agent card JSON",
          },
          network: {
            type: "string",
            description: "mainnet or testnet (default: mainnet)",
          },
        },
        required: ["agent_uri"],
      },
      execute: async (args, ctx) => {
        const { DISTRIBUTION_CHANNEL_IDS } = await import("../distribution/channels.js");
        const guard = await channelGuard(ctx, DISTRIBUTION_CHANNEL_IDS.erc8004);
        if (guard.blocked) return guard.message || "Blocked by distribution channel policy.";

        // Check if already registered in local database
        const existingEntry = ctx.db.getRegistryEntry();
        if (existingEntry) {
          return `Already registered! Agent ID: ${existingEntry.agentId}. Use update_agent_card tool to update your agent URI instead of creating a new registration.`;
        }

        // Phase 3.2: registerAgent now includes preflight gas check
        const { registerAgent } = await import("../registry/erc8004.js");
        try {
          const entry = await registerAgent(
            ctx.identity.account,
            args.agent_uri as string,
            ((args.network as string) || "mainnet") as any,
            ctx.db,
          );
          await recordChannelIssue(ctx, DISTRIBUTION_CHANNEL_IDS.erc8004, "registration succeeded");
          return `Registered on-chain! Agent ID: ${entry.agentId}, TX: ${entry.txHash}`;
        } catch (err: any) {
          if (err.message?.includes("Insufficient ETH")) {
            await recordChannelIssue(ctx, DISTRIBUTION_CHANNEL_IDS.erc8004, err.message);
            return `Registration failed: ${err.message}. Please fund your wallet with ETH for gas.`;
          }
          await recordChannelIssue(ctx, DISTRIBUTION_CHANNEL_IDS.erc8004, err?.message || String(err));
          throw err;
        }
      },
    },
    {
      name: "update_agent_card",
      description:
        "Generate and save a safe agent card (no internal details exposed).",
      category: "registry",
      riskLevel: "caution",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { generateAgentCard, saveAgentCard } =
          await import("../registry/agent-card.js");
        const card = generateAgentCard(ctx.identity, ctx.config, ctx.db);
        await saveAgentCard(card, ctx.conway);
        return `Agent card updated: ${JSON.stringify(card, null, 2)}`;
      },
    },
    {
      name: "discover_agents",
      description: "Discover other agents via ERC-8004 registry with caching.",
      category: "registry",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "Search keyword (optional)" },
          limit: { type: "number", description: "Max results (default: 10)" },
          network: { type: "string", description: "mainnet or testnet" },
        },
      },
      execute: async (args, ctx) => {
        const { DISTRIBUTION_CHANNEL_IDS } = await import("../distribution/channels.js");
        const guard = await channelGuard(ctx, DISTRIBUTION_CHANNEL_IDS.discovery);
        if (guard.blocked) return guard.message || "Blocked by distribution channel policy.";

        const { discoverAgents, searchAgents } =
          await import("../registry/discovery.js");
        const network = ((args.network as string) || "mainnet") as any;
        const keyword = args.keyword as string | undefined;
        const limit = (args.limit as number) || 10;

        // Phase 3.2: Pass db.raw for agent card caching
        const agents = keyword
          ? await searchAgents(keyword, limit, network, undefined, ctx.db.raw)
          : await discoverAgents(limit, network, undefined, ctx.db.raw);

        if (agents.length === 0) return "No agents found.";
        await recordChannelIssue(ctx, DISTRIBUTION_CHANNEL_IDS.discovery, "discovery call succeeded");
        return agents
          .map(
            (a) =>
              `#${a.agentId} ${a.name || "unnamed"} (${a.owner.slice(0, 10)}...): ${a.description || a.agentURI}`,
          )
          .join("\n");
      },
    },
    {
      name: "give_feedback",
      description:
        "Leave on-chain reputation feedback for another agent. Score must be 1-5.",
      category: "registry",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description: "Target agent's ERC-8004 ID",
          },
          score: { type: "number", description: "Score 1-5" },
          comment: {
            type: "string",
            description: "Feedback comment (max 500 chars)",
          },
          network: {
            type: "string",
            description: "mainnet or testnet (default: mainnet)",
          },
        },
        required: ["agent_id", "score", "comment"],
      },
      execute: async (args, ctx) => {
        // Phase 3.2: Validate score 1-5
        const score = args.score as number;
        if (!Number.isInteger(score) || score < 1 || score > 5) {
          return `Invalid score: ${score}. Must be an integer between 1 and 5.`;
        }
        // Phase 3.2: Validate comment length
        const comment = args.comment as string;
        if (comment.length > 500) {
          return `Comment too long: ${comment.length} chars (max 500).`;
        }
        const { leaveFeedback } = await import("../registry/erc8004.js");
        // Phase 3.2: Use config-based network, not hardcoded "mainnet"
        const network = ((args.network as string) || "mainnet") as any;
        const hash = await leaveFeedback(
          ctx.identity.account,
          args.agent_id as string,
          score,
          comment,
          network,
          ctx.db,
        );
        return `Feedback submitted. TX: ${hash}`;
      },
    },
    {
      name: "check_reputation",
      description: "Check reputation feedback for an agent.",
      category: "registry",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          agent_address: {
            type: "string",
            description: "Agent address (default: self)",
          },
        },
      },
      execute: async (args, ctx) => {
        const address = (args.agent_address as string) || ctx.identity.address;
        const entries = ctx.db.getReputation(address);
        if (entries.length === 0) return "No reputation feedback found.";
        return entries
          .map(
            (e) =>
              `${e.fromAgent.slice(0, 10)}... -> score:${e.score} "${e.comment}"`,
          )
          .join("\n");
      },
    },

    // === Phase 3.1: Replication Tools ===
    {
      name: "spawn_child",
      description: "Spawn a child automaton in a new compute instance with lifecycle tracking. Uses Vultr VPS in sovereign mode.",
      category: "replication",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Name for the child automaton (alphanumeric + dash, max 64 chars)",
          },
          specialization: {
            type: "string",
            description: "What the child should specialize in",
          },
          message: { type: "string", description: "Message to the child" },
        },
        required: ["name"],
      },
      execute: async (args, ctx) => {
        const { generateGenesisConfig, validateGenesisParams } =
          await import("../replication/genesis.js");
        const { spawnChild } = await import("../replication/spawn.js");
        // Child exists again; clear stale missing-child telemetry.
        ctx.db.deleteKV("replication.missing_child_status");

        const { ChildLifecycle } = await import("../replication/lifecycle.js");

        validateGenesisParams({
          name: args.name as string,
          specialization: args.specialization as string | undefined,
          message: args.message as string | undefined,
        });

        const genesis = generateGenesisConfig(ctx.identity, ctx.config, {
          name: args.name as string,
          specialization: args.specialization as string | undefined,
          message: args.message as string | undefined,
        });

        const lifecycle = new ChildLifecycle(ctx.db.raw);
        let compute: any;
        if (ctx.config.useSovereignProviders && ctx.config.vultrApiKey) {
          const { createVultrProvider } = await import("../providers/vultr.js");
          compute = createVultrProvider(ctx.config.vultrApiKey);
        }

        const { getSpawnQueue } = await import("../replication/spawn-queue.js");
        const child = await getSpawnQueue().enqueue(() =>
          spawnChild(ctx.conway, ctx.identity, ctx.db, genesis, lifecycle, compute)
        );
        const resourceType = compute ? "instance" : "sandbox";
        return `Child spawned: ${child.name} in ${resourceType} ${child.sandboxId} (status: ${child.status})`;
      },
    },
    {
      name: "list_children",
      description: "List all spawned child automatons with lifecycle state.",
      category: "replication",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const children = ctx.db.getChildren();
        if (children.length === 0) return "No children spawned.";
        return children
          .map(
            (c) =>
              `${c.name} [${c.status}] sandbox:${c.sandboxId} funded:$${(c.fundedAmountCents / 100).toFixed(2)} last_check:${c.lastChecked || "never"}`,
          )
          .join("\n");
      },
    },
    {
      name: "fund_child",
      description: "Transfer funds to a child automaton. Uses USDC in sovereign mode, credits in legacy mode. Requires wallet_verified status.",
      category: "replication",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          child_id: { type: "string", description: "Child automaton ID" },
          amount_cents: { type: "number", description: "Amount in cents to transfer (legacy mode)" },
          amount_usd: { type: "string", description: "Amount in USD to transfer as decimal string, e.g. '5.00' (sovereign mode)" },
        },
        required: ["child_id"],
      },
      execute: async (args, ctx) => {
        const child = ctx.db.getChildById(args.child_id as string);
        if (!child) return `Child ${args.child_id} not found.`;

        // Reject zero-address
        const { isValidWalletAddress } =
          await import("../replication/spawn.js");
        if (!isValidWalletAddress(child.address)) {
          return `Blocked: Child ${args.child_id} has invalid wallet address. Must be wallet_verified.`;
        }

        // Require wallet_verified or later status
        const validFundingStates = [
          "wallet_verified",
          "funded",
          "starting",
          "healthy",
          "unhealthy",
        ];
        if (!validFundingStates.includes(child.status)) {
          return `Blocked: Child status is '${child.status}', must be wallet_verified or later to fund.`;
        }

        if (ctx.config.useSovereignProviders) {
          // Sovereign mode: USDC transfer
          const amountUsd = args.amount_usd as string | undefined
            ?? (args.amount_cents ? (Number(args.amount_cents) / 100).toFixed(2) : undefined);
          if (!amountUsd) {
            return "Blocked: amount_usd (e.g. '5.00') or amount_cents required.";
          }
          const amountNum = parseFloat(amountUsd);
          if (!Number.isFinite(amountNum) || amountNum <= 0) {
            return `Blocked: amount must be positive, got ${amountUsd}.`;
          }

          const { getUsdcBalance } = await import("../wallet/x402.js");
          const balance = await getUsdcBalance(ctx.identity.address);
          if (amountNum > balance / 2) {
            return `Blocked: Cannot transfer more than half your USDC balance ($${balance.toFixed(2)}). Self-preservation.`;
          }

          const { transferUsdc } = await import("../wallet/transfer.js");
          let txResult;
          try {
            txResult = await transferUsdc(
              ctx.identity.account,
              child.address as `0x${string}`,
              amountUsd,
            );
          } catch (err: any) {
            return `Transfer failed: ${err.message || "unknown error"}`;
          }

          const amountCents = Math.round(amountNum * 100);
          const { ulid } = await import("ulid");
          ctx.db.insertTransaction({
            id: ulid(),
            type: "transfer_out",
            amountCents,
            balanceAfterCents: Math.round((balance - amountNum) * 100),
            description: `Fund child ${child.name} (${child.id}) via USDC`,
            timestamp: new Date().toISOString(),
          });

          ctx.db.raw.prepare(
            "UPDATE children SET funded_amount_cents = funded_amount_cents + ? WHERE id = ?",
          ).run(amountCents, child.id);

          if (child.status === "wallet_verified") {
            try {
              const { ChildLifecycle } = await import("../replication/lifecycle.js");
              const lifecycle = new ChildLifecycle(ctx.db.raw);
              lifecycle.transition(child.id, "funded", `funded with $${amountUsd} USDC`);
            } catch {
              // Non-critical: may already be in funded state
            }
          }

          return `Funded child ${child.name} with $${amountUsd} USDC (tx: ${txResult.txHash.slice(0, 18)}...)`;
        }

        // Legacy mode: Conway credit transfer
        const amount = args.amount_cents as number;
        if (!Number.isFinite(amount) || amount <= 0) {
          return `Blocked: amount_cents must be a positive number, got ${amount}.`;
        }

        const balance = await ctx.conway.getCreditsBalance();
        if (amount > balance / 2) {
          return `Blocked: Cannot transfer more than half your balance. Self-preservation.`;
        }

        const transfer = await ctx.conway.transferCredits(
          child.address,
          amount,
          `fund child ${child.id}`,
        );

        const { ulid } = await import("ulid");
        ctx.db.insertTransaction({
          id: ulid(),
          type: "transfer_out",
          amountCents: amount,
          balanceAfterCents:
            transfer.balanceAfterCents ?? Math.max(balance - amount, 0),
          description: `Fund child ${child.name} (${child.id})`,
          timestamp: new Date().toISOString(),
        });

        // Update funded amount
        ctx.db.raw
          .prepare(
            "UPDATE children SET funded_amount_cents = funded_amount_cents + ? WHERE id = ?",
          )
          .run(amount, child.id);

        // Transition to funded if wallet_verified
        if (child.status === "wallet_verified") {
          try {
            const { ChildLifecycle } =
              await import("../replication/lifecycle.js");
            const lifecycle = new ChildLifecycle(ctx.db.raw);
            lifecycle.transition(
              child.id,
              "funded",
              `funded with ${amount} cents`,
            );
          } catch {
            // Non-critical: may already be in funded state
          }
        }

        return `Funded child ${child.name} with $${(amount / 100).toFixed(2)} (status: ${transfer.status}, id: ${transfer.transferId || "n/a"})`;
      },
    },
    {
      name: "check_child_status",
      description:
        "Check the current status of a child automaton using health check system.",
      category: "replication",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          child_id: { type: "string", description: "Child automaton ID" },
        },
        required: ["child_id"],
      },
      execute: async (args, ctx) => {
        const child = ctx.db.getChildById(args.child_id as string);
        if (!child) {
          const childId = args.child_id as string;
          const nowIso = new Date().toISOString();
          const key = "replication.missing_child_status";
          let count = 1;
          try {
            const previous = ctx.db.getKV(key);
            if (previous) {
              const parsed = JSON.parse(previous) as {
                childId?: string;
                timestamp?: string;
                count?: number;
              };
              const previousAt = parsed.timestamp ? new Date(parsed.timestamp).getTime() : 0;
              const isRecent = previousAt > 0 && Date.now() - previousAt < 15 * 60_000;
              if (parsed.childId === childId && isRecent) {
                count = (parsed.count ?? 0) + 1;
              }
            }
          } catch {
            // Keep default count when history cannot be parsed.
          }
          ctx.db.setKV(key, JSON.stringify({ childId, count, timestamp: nowIso }));
          const knownChildren = ctx.db
            .getChildren()
            .map((c) => `${c.id} [${c.status}]`)
            .slice(0, 5);
          const knownSummary = knownChildren.length > 0
            ? `Known children: ${knownChildren.join(", ")}.`
            : "Known children: none.";
          return `Child ${childId} not found. ${knownSummary} Use list_children to refresh IDs before retrying.`;
        }

        const { ChildLifecycle } = await import("../replication/lifecycle.js");
        const { ChildHealthMonitor } = await import("../replication/health.js");
        const lifecycle = new ChildLifecycle(ctx.db.raw);
        let compute;
        if (ctx.config.useSovereignProviders && ctx.config.vultrApiKey) {
          const { createVultrProvider } = await import("../providers/vultr.js");
          compute = createVultrProvider(ctx.config.vultrApiKey);
        }
        const monitor = new ChildHealthMonitor(ctx.db.raw, ctx.conway, lifecycle, undefined, compute);
        const result = await monitor.checkHealth(args.child_id as string);
        return JSON.stringify(result, null, 2);
      },
    },
    {
      name: "start_child",
      description:
        "Start a funded child automaton. Transitions from funded to starting.",
      category: "replication",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          child_id: { type: "string", description: "Child automaton ID" },
        },
        required: ["child_id"],
      },
      execute: async (args, ctx) => {
        const child = ctx.db.getChildById(args.child_id as string);
        if (!child) return `Child ${args.child_id} not found.`;

        const { ChildLifecycle } = await import("../replication/lifecycle.js");
        const lifecycle = new ChildLifecycle(ctx.db.raw);

        lifecycle.transition(child.id, "starting", "start requested by parent");

        // Create a scoped client targeting the CHILD's sandbox
        const childConway = ctx.conway.createScopedClient(child.sandboxId);

        try {
          // Start the child process with nohup so it survives exec session end
          await childConway.exec(
            "nohup node /root/automaton/dist/index.js --run > /root/.automaton/agent.log 2>&1 &",
            30_000,
          );

          // Brief pause then verify the process is actually running
          const check = await childConway.exec(
            "sleep 2 && pgrep -f 'index.js --run' > /dev/null && echo running || echo stopped",
            15_000,
          );

          if (check.stdout.trim() === "running") {
            lifecycle.transition(child.id, "healthy", "started successfully");
            return `Child ${child.name} started and healthy.`;
          } else {
            lifecycle.transition(child.id, "failed", "process did not start");
            return `Child ${child.name} failed to start — process exited immediately. Check /root/.automaton/agent.log`;
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          try {
            lifecycle.transition(child.id, "failed", `start failed: ${msg}`);
          } catch { /* may already be in terminal state */ }
          return `Failed to start child ${child.name}: ${msg}`;
        }
      },
    },
    {
      name: "message_child",
      description:
        "Send a signed message to a child automaton via social relay.",
      category: "replication",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          child_id: { type: "string", description: "Child automaton ID" },
          content: { type: "string", description: "Message content" },
          type: {
            type: "string",
            description: "Message type (default: parent_message)",
          },
        },
        required: ["child_id", "content"],
      },
      execute: async (args, ctx) => {
        const { DISTRIBUTION_CHANNEL_IDS } = await import("../distribution/channels.js");
        const guard = await channelGuard(ctx, DISTRIBUTION_CHANNEL_IDS.socialRelay);
        if (guard.blocked) return guard.message || "Blocked by distribution channel policy.";

        if (!ctx.social) {
          await recordChannelIssue(ctx, DISTRIBUTION_CHANNEL_IDS.socialRelay, "Social relay not configured");
          return "Social relay not configured. Set socialRelayUrl in config.";
        }

        const child = ctx.db.getChildById(args.child_id as string);
        if (!child) return `Child ${args.child_id} not found.`;

        const { sendToChild } = await import("../replication/messaging.js");
        const result = await sendToChild(
          ctx.social,
          child.address,
          args.content as string,
          (args.type as string) || "parent_message",
        );
        await recordChannelIssue(ctx, DISTRIBUTION_CHANNEL_IDS.socialRelay, "message child succeeded");
        return `Message sent to child ${child.name} (id: ${result.id})`;
      },
    },
    {
      name: "verify_child_constitution",
      description: "Verify the constitution integrity of a child automaton.",
      category: "replication",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          child_id: { type: "string", description: "Child automaton ID" },
        },
        required: ["child_id"],
      },
      execute: async (args, ctx) => {
        const child = ctx.db.getChildById(args.child_id as string);
        if (!child) return `Child ${args.child_id} not found.`;

        const { verifyConstitution } = await import("../replication/constitution.js");

        if (ctx.config.useSovereignProviders && ctx.config.vultrApiKey && child.sandboxId) {
          // Sovereign mode: verify via SSH
          const { createVultrProvider } = await import("../providers/vultr.js");
          const compute = createVultrProvider(ctx.config.vultrApiKey);
          const instance = await compute.getInstanceStatus(child.sandboxId);
          const readResult = await compute.sshExec(
            instance.mainIp,
            { type: "password", password: instance.defaultPassword || "" },
            "cat /root/.automaton/constitution.md 2>/dev/null && echo '---HASH---' && cat /root/.automaton/constitution.hash 2>/dev/null",
            15_000,
          );
          if (readResult.exitCode !== 0) {
            return JSON.stringify({ valid: false, error: "Failed to read constitution via SSH" }, null, 2);
          }
          const parts = readResult.stdout.split("---HASH---");
          return JSON.stringify({
            valid: parts.length === 2 && parts[1]!.trim().length > 0,
            constitutionLength: (parts[0] || "").trim().length,
            hashPresent: parts.length === 2 && parts[1]!.trim().length > 0,
          }, null, 2);
        }

        const result = await verifyConstitution(ctx.conway, child.sandboxId, ctx.db.raw);
        return JSON.stringify(result, null, 2);
      },
    },
    {
      name: "prune_dead_children",
      description: "Clean up dead/failed children and their sandboxes.",
      category: "replication",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          keep_last: {
            type: "number",
            description: "Number of recent dead children to keep (default: 5)",
          },
        },
      },
      execute: async (args, ctx) => {
        const { ChildLifecycle } = await import("../replication/lifecycle.js");
        const { SandboxCleanup } = await import("../replication/cleanup.js");
        const { pruneDeadChildren } = await import("../replication/lineage.js");

        const lifecycle = new ChildLifecycle(ctx.db.raw);
        let compute;
        if (ctx.config.useSovereignProviders && ctx.config.vultrApiKey) {
          const { createVultrProvider } = await import("../providers/vultr.js");
          compute = createVultrProvider(ctx.config.vultrApiKey);
        }
        const cleanup = new SandboxCleanup(ctx.conway, lifecycle, ctx.db.raw, compute);
        const pruned = await pruneDeadChildren(ctx.db, cleanup, (args.keep_last as number) || 5);
        return `Pruned ${pruned} dead children.`;
      },
    },

    // === Phase 3.2: Social & Registry Tools ===

    // ── Social / Messaging Tools ──
    {
      name: "send_message",
      description:
        "Send a signed message to another automaton or address via the social relay.",
      category: "conway",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          to_address: {
            type: "string",
            description: "Recipient wallet address (0x...)",
          },
          content: {
            type: "string",
            description: "Message content to send",
          },
          reply_to: {
            type: "string",
            description: "Optional message ID to reply to",
          },
          project_id: {
            type: "string",
            description: "Optional project ID for budget enforcement context.",
          },
        },
        required: ["to_address", "content"],
      },
      execute: async (args, ctx) => {
        const { DISTRIBUTION_CHANNEL_IDS } = await import("../distribution/channels.js");
        const guard = await channelGuard(ctx, DISTRIBUTION_CHANNEL_IDS.socialRelay);
        if (guard.blocked) return guard.message || "Blocked by distribution channel policy.";

        const projectId = typeof args.project_id === "string" ? args.project_id.trim() : "";
        if (projectId) {
          const budgetCheck = await checkProjectBudget(ctx, projectId);
          if (budgetCheck.blocked) return budgetCheck.message || "Blocked: project budget exceeded.";
        }

        if (!ctx.social) {
          await recordChannelIssue(ctx, DISTRIBUTION_CHANNEL_IDS.socialRelay, "Social relay not configured");
          return "Social relay not configured. Set socialRelayUrl in config.";
        }
        // Phase 3.2: Enforce MESSAGE_LIMITS size check
        const content = args.content as string;
        const { MESSAGE_LIMITS } = await import("../types.js");
        if (content.length > MESSAGE_LIMITS.maxContentLength) {
          return `Blocked: Message content too long (${content.length} > ${MESSAGE_LIMITS.maxContentLength} bytes)`;
        }
        const result = await ctx.social.send(
          args.to_address as string,
          content,
          args.reply_to as string | undefined,
        );
        await recordChannelIssue(ctx, DISTRIBUTION_CHANNEL_IDS.socialRelay, "send message succeeded");
        return `Message sent (id: ${result.id})`;
      },
    },

    // ── Model Discovery (enhanced with Phase 2.3 tier routing + pricing) ──
    {
      name: "list_models",
      description:
        "List all available inference models with their provider, pricing, and tier routing information.",
      category: "conway",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      execute: async (_args, ctx) => {
        // Try registry first for richer data
        try {
          const { modelRegistryGetAll } = await import("../state/database.js");
          const rows = modelRegistryGetAll(ctx.db.raw);
          if (rows.length > 0) {
            const lines = rows.map(
              (r: any) =>
                `${r.modelId} (${r.provider}) — tier: ${r.tierMinimum} | cost: ${r.costPer1kInput}/${r.costPer1kOutput} per 1k (in/out, hundredths of cents) | ctx: ${r.contextWindow} | tools: ${r.supportsTools ? "yes" : "no"} | ${r.enabled ? "enabled" : "disabled"}`,
            );
            return `Model Registry (${rows.length} models):\n${lines.join("\n")}`;
          }
        } catch {
          // Registry not initialized yet, fall back to API
        }
        const models = await ctx.conway.listModels();
        const lines = models.map(
          (m) =>
            `${m.id} (${m.provider}) — $${m.pricing.inputPerMillion}/$${m.pricing.outputPerMillion} per 1M tokens (in/out)`,
        );
        return `Available models:\n${lines.join("\n")}`;
      },
    },

    // === Phase 2.3: Inference Tools ===
    {
      name: "switch_model",
      description:
        "Change the active inference model at runtime. Persists to config. Use list_models to see available options.",
      category: "conway",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          model_id: {
            type: "string",
            description:
              "Model ID to switch to (e.g., 'gpt-5.2', 'gpt-5-mini', 'claude-sonnet-4-6')",
          },
          reason: {
            type: "string",
            description: "Why you are switching models",
          },
        },
        required: ["model_id"],
      },
      execute: async (args, ctx) => {
        const modelId = args.model_id as string;
        const reason = (args.reason as string) || "manual switch";

        // Verify model exists in registry
        try {
          const { modelRegistryGet } = await import("../state/database.js");
          const entry = modelRegistryGet(ctx.db.raw, modelId);
          if (!entry) {
            return `Model '${modelId}' not found in registry. Use list_models to see available models.`;
          }
          if (!entry.enabled) {
            return `Model '${modelId}' is disabled in the registry.`;
          }
        } catch {
          // Registry not available, allow anyway
        }

        // Update config
        ctx.config.inferenceModel = modelId;
        if (ctx.config.modelStrategy) {
          ctx.config.modelStrategy.inferenceModel = modelId;
        }

        // Persist
        const { saveConfig } = await import("../config.js");
        saveConfig(ctx.config);

        // Audit log
        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "config_change",
          description: `Switched inference model to ${modelId}: ${reason}`,
          reversible: true,
        });

        return `Inference model switched to ${modelId}. Reason: ${reason}. Change persisted to config.`;
      },
    },
    {
      name: "check_inference_spending",
      description:
        "Query inference cost breakdown: hourly, daily, per-model, and per-session costs.",
      category: "financial",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          model: {
            type: "string",
            description: "Filter by model ID (optional)",
          },
          days: {
            type: "number",
            description: "Number of days to look back (default: 1)",
          },
        },
      },
      execute: async (args, ctx) => {
        try {
          const {
            inferenceGetHourlyCost,
            inferenceGetDailyCost,
            inferenceGetModelCosts,
          } = await import("../state/database.js");

          const hourlyCost = inferenceGetHourlyCost(ctx.db.raw);
          const dailyCost = inferenceGetDailyCost(ctx.db.raw);

          let output = `=== Inference Spending ===\nCurrent hour: ${hourlyCost}c ($${(hourlyCost / 100).toFixed(2)})\nToday: ${dailyCost}c ($${(dailyCost / 100).toFixed(2)})`;

          const model = args.model as string | undefined;
          if (model) {
            const days = (args.days as number) || 1;
            const modelCosts = inferenceGetModelCosts(ctx.db.raw, model, days);
            output += `\nModel ${model} (${days}d): ${modelCosts.totalCents}c ($${(modelCosts.totalCents / 100).toFixed(2)}) over ${modelCosts.callCount} calls`;
          }

          return output;
        } catch (error) {
          return `Inference spending data unavailable: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    },

    // ── Domain Tools ──
    {
      name: "search_domains",
      description: "Search for available domain names and get pricing.",
      category: "conway",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Domain name or keyword to search (e.g., 'mysite' or 'mysite.com')",
          },
          tlds: {
            type: "string",
            description:
              "Comma-separated TLDs to check (e.g., 'com,io,ai'). Default: com,io,ai,xyz,net,org,dev",
          },
        },
        required: ["query"],
      },
      execute: async (args, ctx) => {
        const query = args.query as string;
        const tldStr = args.tlds as string | undefined;

        if (ctx.config.useSovereignProviders) {
          // Sovereign mode: Porkbun
          const porkbunApiKey = ctx.config.porkbunApiKey;
          const porkbunSecretKey = ctx.config.porkbunSecretKey;
          if (!porkbunApiKey || !porkbunSecretKey) {
            return "Error: porkbunApiKey and porkbunSecretKey must be set in config for domain search.";
          }

          const { createPorkbunProvider } = await import("../providers/porkbun.js");
          const porkbun = createPorkbunProvider(porkbunApiKey, porkbunSecretKey);

          // If query includes a dot, check that exact domain
          // Otherwise, expand into domain+TLD combinations
          const tlds = tldStr ? tldStr.split(",").map((t) => t.trim()) : ["com", "io", "ai", "xyz", "net", "org", "dev"];
          const hasDot = query.includes(".");
          const domains = hasDot ? [query] : tlds.map((tld) => `${query}.${tld}`);

          const results = await Promise.allSettled(
            domains.map((d) => porkbun.checkAvailability(d)),
          );

          const lines: string[] = [];
          for (const r of results) {
            if (r.status === "fulfilled") {
              const d = r.value;
              const priceStr = d.registrationPrice != null ? ` ($${d.registrationPrice.toFixed(2)}/yr)` : "";
              lines.push(`${d.domain}: ${d.available ? "AVAILABLE" : "taken"}${priceStr}`);
            }
          }

          return lines.length > 0 ? lines.join("\n") : "No results found.";
        }

        // Legacy mode: Conway
        const results = await ctx.conway.searchDomains(query, tldStr);
        if (results.length === 0) return "No results found.";
        return results
          .map(
            (d) =>
              `${d.domain}: ${d.available ? "AVAILABLE" : "taken"}${d.registrationPrice != null ? ` ($${(d.registrationPrice / 100).toFixed(2)}/yr)` : ""}`,
          )
          .join("\n");
      },
    },
    {
      name: "register_domain",
      description:
        "Register a domain name. Check availability first with search_domains.",
      category: "conway",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description: "Full domain to register (e.g., 'mysite.com')",
          },
          years: {
            type: "number",
            description: "Registration period in years (default: 1)",
          },
        },
        required: ["domain"],
      },
      execute: async (args, ctx) => {
        const domain = args.domain as string;
        const years = (args.years as number) || 1;

        if (ctx.config.useSovereignProviders) {
          const porkbunApiKey = ctx.config.porkbunApiKey;
          const porkbunSecretKey = ctx.config.porkbunSecretKey;
          if (!porkbunApiKey || !porkbunSecretKey) {
            return "Error: porkbunApiKey and porkbunSecretKey must be set in config for domain registration.";
          }

          const { createPorkbunProvider } = await import("../providers/porkbun.js");
          const porkbun = createPorkbunProvider(porkbunApiKey, porkbunSecretKey);
          const reg = await porkbun.registerDomain(domain, years);
          return `Domain registered: ${reg.domain} (status: ${reg.status}${reg.expiresAt ? `, expires: ${reg.expiresAt}` : ""}${reg.transactionId ? `, tx: ${reg.transactionId}` : ""})`;
        }

        // Legacy mode
        const reg = await ctx.conway.registerDomain(domain, years);
        return `Domain registered: ${reg.domain} (status: ${reg.status}${reg.expiresAt ? `, expires: ${reg.expiresAt}` : ""}${reg.transactionId ? `, tx: ${reg.transactionId}` : ""})`;
      },
    },
    {
      name: "manage_dns",
      description:
        "Manage DNS records for a domain you own. Actions: list, add, delete. Uses Cloudflare in sovereign mode.",
      category: "conway",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "list, add, or delete",
          },
          domain: {
            type: "string",
            description: "Domain name (e.g., 'mysite.com')",
          },
          zone_id: {
            type: "string",
            description: "Cloudflare zone ID (sovereign mode only; auto-resolved if not provided)",
          },
          type: {
            type: "string",
            description: "Record type for add: A, AAAA, CNAME, MX, TXT, etc.",
          },
          host: {
            type: "string",
            description: "Record host for add (e.g., '@' for root, 'www')",
          },
          value: {
            type: "string",
            description:
              "Record value for add (e.g., IP address, target domain)",
          },
          ttl: {
            type: "number",
            description: "TTL in seconds for add (default: auto)",
          },
          record_id: {
            type: "string",
            description: "Record ID for delete",
          },
        },
        required: ["action", "domain"],
      },
      execute: async (args, ctx) => {
        const action = args.action as string;
        const domain = args.domain as string;

        if (ctx.config.useSovereignProviders) {
          const cfToken = ctx.config.cloudflareApiToken;
          const cfKey = ctx.config.cloudflareApiKey;
          const cfEmail = ctx.config.cloudflareEmail;
          if (!cfToken && !(cfKey && cfEmail)) {
            return "Error: Cloudflare credentials must be set in config for DNS management (cloudflareApiToken or cloudflareApiKey + cloudflareEmail).";
          }

          const { createCloudflareProvider } = await import("../providers/cloudflare.js");
          const cf = createCloudflareProvider(
            cfToken ? { apiToken: cfToken } : { apiKey: cfKey!, email: cfEmail! },
          );

          // Resolve zone ID: explicit arg > config > auto-lookup by domain
          let zoneId = args.zone_id as string | undefined;
          if (!zoneId) zoneId = ctx.config.cloudflareZoneId;
          if (!zoneId) {
            const zones = await cf.listZones();
            const match = zones.find((z) => domain.endsWith(z.name));
            if (!match) {
              return `No Cloudflare zone found for ${domain}. Available zones: ${zones.map((z) => z.name).join(", ") || "none"}. Set cloudflareZoneId in config or pass zone_id.`;
            }
            zoneId = match.id;
          }

          if (action === "list") {
            const records = await cf.listRecords(zoneId);
            const filtered = records.filter((r) => r.host.endsWith(domain));
            if (filtered.length === 0) return `No DNS records found for ${domain}.`;
            return filtered
              .map((r) => `[${r.id}] ${r.type} ${r.host} -> ${r.value} (TTL: ${r.ttl || "auto"})`)
              .join("\n");
          }

          if (action === "add") {
            const type = args.type as string;
            const host = args.host as string;
            const value = args.value as string;
            if (!type || !host || !value) {
              return "Required for add: type, host, value";
            }
            const fqdn = host === "@" ? domain : (host.endsWith(domain) ? host : `${host}.${domain}`);
            const record = await cf.addRecord(zoneId, type, fqdn, value, args.ttl as number | undefined);
            return `DNS record added: [${record.id}] ${record.type} ${record.host} -> ${record.value}`;
          }

          if (action === "delete") {
            const recordId = args.record_id as string;
            if (!recordId) return "Required for delete: record_id";
            await cf.deleteRecord(zoneId, recordId);
            return `DNS record ${recordId} deleted from ${domain}`;
          }

          return `Unknown action: ${action}. Use list, add, or delete.`;
        }

        // Legacy mode: Conway
        if (action === "list") {
          const records = await ctx.conway.listDnsRecords(domain);
          if (records.length === 0)
            return `No DNS records found for ${domain}.`;
          return records
            .map(
              (r) =>
                `[${r.id}] ${r.type} ${r.host} -> ${r.value} (TTL: ${r.ttl || "default"})`,
            )
            .join("\n");
        }

        if (action === "add") {
          const type = args.type as string;
          const host = args.host as string;
          const value = args.value as string;
          if (!type || !host || !value) {
            return "Required for add: type, host, value";
          }
          const record = await ctx.conway.addDnsRecord(
            domain,
            type,
            host,
            value,
            args.ttl as number | undefined,
          );
          return `DNS record added: [${record.id}] ${record.type} ${record.host} -> ${record.value}`;
        }

        if (action === "delete") {
          const recordId = args.record_id as string;
          if (!recordId) return "Required for delete: record_id";
          await ctx.conway.deleteDnsRecord(domain, recordId);
          return `DNS record ${recordId} deleted from ${domain}`;
        }

        return `Unknown action: ${action}. Use list, add, or delete.`;
      },
    },

    // === Phase 2.1: Soul Tools ===
    {
      name: "update_soul",
      description:
        "Update a section of your soul (self-description, values, personality, etc). Changes are validated, versioned, and logged.",
      category: "self_mod",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          section: {
            type: "string",
            description:
              "Section to update: corePurpose, values, behavioralGuidelines, personality, boundaries, strategy",
          },
          content: {
            type: "string",
            description:
              "New content for the section (string for text, JSON array for lists)",
          },
          reason: {
            type: "string",
            description: "Why you are making this change",
          },
        },
        required: ["section", "content", "reason"],
      },
      execute: async (args, ctx) => {
        const { updateSoul } = await import("../soul/tools.js");
        const section = args.section as string;
        const content = args.content as string;
        const reason = args.reason as string;

        const updates: Record<string, unknown> = {};
        if (
          ["values", "behavioralGuidelines", "boundaries"].includes(section)
        ) {
          try {
            updates[section] = JSON.parse(content);
          } catch {
            updates[section] = content
              .split("\n")
              .map((l: string) => l.replace(/^[-*]\s*/, "").trim())
              .filter(Boolean);
          }
        } else {
          updates[section] = content;
        }

        const result = await updateSoul(
          ctx.db.raw,
          updates as any,
          "agent",
          reason,
        );
        if (result.success) {
          return `Soul updated: ${section} (version ${result.version}). Reason: ${reason}`;
        }
        return `Soul update failed: ${result.errors?.join(", ") || "Unknown error"}`;
      },
    },
    {
      name: "reflect_on_soul",
      description:
        "Trigger a self-reflection cycle. Analyzes recent experiences, auto-updates capabilities/relationships/financial sections, and suggests changes for other sections.",
      category: "self_mod",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { reflectOnSoul } = await import("../soul/reflection.js");
        const reflection = await reflectOnSoul(ctx.db.raw);

        const lines: string[] = [
          `Genesis alignment: ${reflection.currentAlignment.toFixed(2)}`,
          `Auto-updated sections: ${reflection.autoUpdated.length > 0 ? reflection.autoUpdated.join(", ") : "none"}`,
        ];

        if (reflection.suggestedUpdates.length > 0) {
          lines.push("Suggested updates:");
          for (const suggestion of reflection.suggestedUpdates) {
            lines.push(`  - ${suggestion.section}: ${suggestion.reason}`);
          }
        } else {
          lines.push("No mutable section updates suggested.");
        }

        return lines.join("\n");
      },
    },
    {
      name: "view_soul",
      description: "View your current soul state (structured model).",
      category: "self_mod",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { viewSoul } = await import("../soul/tools.js");
        const soul = viewSoul(ctx.db.raw);
        if (!soul) return "No soul found. SOUL.md does not exist yet.";

        return [
          `Format: ${soul.format} v${soul.version}`,
          `Updated: ${soul.updatedAt}`,
          `Name: ${soul.name}`,
          `Genesis alignment: ${soul.genesisAlignment.toFixed(2)}`,
          `Core purpose: ${soul.corePurpose.slice(0, 200)}${soul.corePurpose.length > 200 ? "..." : ""}`,
          `Values: ${soul.values.length}`,
          `Guidelines: ${soul.behavioralGuidelines.length}`,
          `Boundaries: ${soul.boundaries.length}`,
          `Personality: ${soul.personality ? "set" : "not set"}`,
          `Strategy: ${soul.strategy ? "set" : "not set"}`,
        ].join("\n");
      },
    },
    {
      name: "view_soul_history",
      description: "View your soul change history (version log).",
      category: "self_mod",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of entries (default: 10)",
          },
        },
      },
      execute: async (args, ctx) => {
        const { viewSoulHistory } = await import("../soul/tools.js");
        const limit = (args.limit as number) || 10;
        const history = viewSoulHistory(ctx.db.raw, limit);
        if (history.length === 0) return "No soul history found.";

        return history
          .map(
            (h) =>
              `v${h.version} [${h.changeSource}] ${h.createdAt}${h.changeReason ? ` — ${h.changeReason}` : ""}`,
          )
          .join("\n");
      },
    },

    // === Phase 2.2: Memory Tools ===
    {
      name: "remember_fact",
      description:
        "Store a semantic memory (fact). Provide a category, key, and value. Facts are upserted on category+key.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description:
              "Fact category: self, environment, financial, agent, domain, procedural_ref, creator",
          },
          key: {
            type: "string",
            description: "Fact key (unique within category)",
          },
          value: { type: "string", description: "Fact value" },
          confidence: {
            type: "number",
            description: "Confidence 0.0-1.0 (default: 1.0)",
          },
          source: {
            type: "string",
            description: "Source of the fact (default: agent)",
          },
        },
        required: ["category", "key", "value"],
      },
      execute: async (args, ctx) => {
        const { rememberFact } = await import("../memory/tools.js");
        return rememberFact(ctx.db.raw, {
          category: args.category as string,
          key: args.key as string,
          value: args.value as string,
          confidence: args.confidence as number | undefined,
          source: args.source as string | undefined,
        });
      },
    },
    {
      name: "recall_facts",
      description:
        "Search semantic memory by category and/or query string. Returns matching facts.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description:
              "Filter by category: self, environment, financial, agent, domain, procedural_ref, creator",
          },
          query: {
            type: "string",
            description: "Search query to match against fact keys and values",
          },
        },
      },
      execute: async (args, ctx) => {
        const { recallFacts } = await import("../memory/tools.js");
        return recallFacts(ctx.db.raw, {
          category: args.category as string | undefined,
          query: args.query as string | undefined,
        });
      },
    },
    {
      name: "set_goal",
      description:
        "Create a working memory goal. Goals persist in working memory and guide your behavior.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Goal description" },
          priority: {
            type: "number",
            description: "Priority 0.0-1.0 (default: 0.8)",
          },
        },
        required: ["content"],
      },
      execute: async (args, ctx) => {
        const { setGoal } = await import("../memory/tools.js");
        const sessionId = ctx.db.getKV("session_id") || "default";
        return setGoal(ctx.db.raw, {
          sessionId,
          content: args.content as string,
          priority: args.priority as number | undefined,
        });
      },
    },
    {
      name: "complete_goal",
      description:
        "Mark a goal as completed and archive it to episodic memory. Use review_memory to find goal IDs.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          goal_id: { type: "string", description: "Goal ID to complete" },
          outcome: {
            type: "string",
            description: "Outcome description (optional)",
          },
        },
        required: ["goal_id"],
      },
      execute: async (args, ctx) => {
        const { completeGoal } = await import("../memory/tools.js");
        const sessionId = ctx.db.getKV("session_id") || "default";
        return completeGoal(ctx.db.raw, {
          goalId: args.goal_id as string,
          sessionId,
          outcome: args.outcome as string | undefined,
        });
      },
    },
    {
      name: "save_procedure",
      description:
        "Store a learned procedure with ordered steps. Procedures help you remember how to do things.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Unique procedure name" },
          description: {
            type: "string",
            description: "What this procedure does",
          },
          steps: {
            type: "string",
            description:
              'JSON array of steps: [{"order":1,"description":"...","tool":"...","argsTemplate":null,"expectedOutcome":null,"onFailure":null}]',
          },
        },
        required: ["name", "description", "steps"],
      },
      execute: async (args, ctx) => {
        const { saveProcedure } = await import("../memory/tools.js");
        return saveProcedure(ctx.db.raw, {
          name: args.name as string,
          description: args.description as string,
          steps: args.steps as string,
        });
      },
    },
    {
      name: "recall_procedure",
      description: "Retrieve a stored procedure by exact name or search query.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Exact procedure name" },
          query: {
            type: "string",
            description: "Search query to find matching procedures",
          },
        },
      },
      execute: async (args, ctx) => {
        const { recallProcedure } = await import("../memory/tools.js");
        return recallProcedure(ctx.db.raw, {
          name: args.name as string | undefined,
          query: args.query as string | undefined,
        });
      },
    },
    {
      name: "note_about_agent",
      description:
        "Record a relationship note about another agent or entity. Tracks trust score and interaction history.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          entity_address: {
            type: "string",
            description: "Entity wallet address (0x...)",
          },
          entity_name: {
            type: "string",
            description: "Human-readable name (optional)",
          },
          relationship_type: {
            type: "string",
            description:
              "Type of relationship: peer, service, creator, child, unknown",
          },
          notes: { type: "string", description: "Notes about this entity" },
          trust_score: {
            type: "number",
            description: "Trust score 0.0-1.0 (default: 0.5)",
          },
        },
        required: ["entity_address", "relationship_type"],
      },
      execute: async (args, ctx) => {
        const { noteAboutAgent } = await import("../memory/tools.js");
        return noteAboutAgent(ctx.db.raw, {
          entityAddress: args.entity_address as string,
          entityName: args.entity_name as string | undefined,
          relationshipType: args.relationship_type as string,
          notes: args.notes as string | undefined,
          trustScore: args.trust_score as number | undefined,
        });
      },
    },
    {
      name: "review_memory",
      description:
        "Review your current working memory (goals, tasks, observations) and recent episodic history.",
      category: "memory",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { reviewMemory } = await import("../memory/tools.js");
        const sessionId = ctx.db.getKV("session_id") || "default";
        return reviewMemory(ctx.db.raw, { sessionId });
      },
    },
    {
      name: "forget",
      description:
        "Remove a memory entry by ID and type. Cannot remove creator-protected semantic entries.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Memory entry ID" },
          memory_type: {
            type: "string",
            description:
              "Memory type: working, episodic, semantic, procedural, relationship",
          },
        },
        required: ["id", "memory_type"],
      },
      execute: async (args, ctx) => {
        const { forget } = await import("../memory/tools.js");
        return forget(ctx.db.raw, {
          id: args.id as string,
          memoryType: args.memory_type as string,
        });
      },
    },

    // ── x402 Payment Tool ──
    {
      name: "x402_fetch",
      description:
        "Fetch a URL with automatic x402 USDC payment. If the server responds with HTTP 402, signs a USDC payment and retries. Use this to access paid APIs and services.",
      category: "financial",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to fetch",
          },
          method: {
            type: "string",
            description: "HTTP method (default: GET)",
          },
          body: {
            type: "string",
            description: "Request body for POST/PUT (JSON string)",
          },
          headers: {
            type: "string",
            description: "Additional headers as JSON string",
          },
        },
        required: ["url"],
      },
      execute: async (args, ctx) => {
        const { x402Fetch } = await import("../wallet/x402.js");
        const { DEFAULT_TREASURY_POLICY } = await import("../types.js");
        const url = args.url as string;
        const method = (args.method as string) || "GET";
        const body = args.body as string | undefined;
        const extraHeaders = args.headers
          ? JSON.parse(args.headers as string)
          : {};

        // Automatically inject internal API token for localhost URLs (agent's own services)
        if (ctx.config.internalApiToken && url.includes("localhost")) {
          extraHeaders["x-internal-token"] = ctx.config.internalApiToken;
        }

        const maxPayment =
          ctx.config.treasuryPolicy?.maxX402PaymentCents ??
          DEFAULT_TREASURY_POLICY.maxX402PaymentCents;
        const result = await x402Fetch(
          url,
          ctx.identity.account,
          method,
          body,
          extraHeaders,
          maxPayment,
        );

        if (!result.success) {
          return `x402 fetch failed: ${result.error || "Unknown error"}`;
        }

        const responseStr =
          typeof result.response === "string"
            ? result.response
            : JSON.stringify(result.response, null, 2);

        // Truncate very large responses
        if (responseStr.length > 10000) {
          return `x402 fetch succeeded (truncated):\n${responseStr.slice(0, 10000)}...`;
        }
        return `x402 fetch succeeded:\n${responseStr}`;
      },
    },

    // === Orchestration Tools ===
    {
      name: "create_project",
      description:
        "Create a portfolio project with offer, customer, channel, and monetization hypothesis.",
      category: "orchestration" as ToolCategory,
      riskLevel: "caution" as RiskLevel,
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Optional project ID (defaults to generated ULID)." },
          name: { type: "string", description: "Project name." },
          description: { type: "string", description: "What will be built/distributed." },
          lane: { type: "string", description: "build | distribution | research (default: build)." },
          offer: { type: "string", description: "Offer this project is selling." },
          target_customer: { type: "string", description: "Primary target customer." },
          monetization_hypothesis: { type: "string", description: "How this project makes money." },
          next_monetization_step: { type: "string", description: "Concrete next monetization action." },
          success_metric: { type: "string", description: "Main success metric." },
          kill_criteria: { type: "string", description: "Condition to kill project if unmet." },
          budget_compute_cents: { type: "number", description: "Optional compute budget in cents." },
          budget_tokens: { type: "number", description: "Optional token budget." },
          budget_time_minutes: { type: "number", description: "Optional time budget in minutes." },
        },
        required: ["name", "offer", "target_customer", "monetization_hypothesis"],
      },
      execute: async (args, ctx) => {
        const { insertProject } = await import("../state/database.js");
        const { canCreateActiveProject } = await import("../portfolio/policy.js");

        const name = String(args.name || "").trim();
        const offer = String(args.offer || "").trim();
        const targetCustomer = String(args.target_customer || "").trim();
        const monetizationHypothesis = String(args.monetization_hypothesis || "").trim();
        if (!name || !offer || !targetCustomer || !monetizationHypothesis) {
          return "Error: create_project requires non-empty name, offer, target_customer, and monetization_hypothesis.";
        }

        if (!canCreateActiveProject(ctx.db.raw, ctx.config)) {
          return "Blocked: portfolio max active projects reached. Pause/kill an existing project first.";
        }

        const projectId = insertProject(ctx.db.raw, {
          id: typeof args.id === "string" && args.id.trim() ? args.id.trim() : undefined,
          name,
          description: typeof args.description === "string" ? args.description : "",
          status: "incubating",
          lane: (args.lane === "distribution" || args.lane === "research") ? args.lane : "build",
          offer,
          targetCustomer,
          monetizationHypothesis,
          nextMonetizationStep: typeof args.next_monetization_step === "string" ? args.next_monetization_step : "",
          successMetric: typeof args.success_metric === "string" ? args.success_metric : "",
          killCriteria: typeof args.kill_criteria === "string" ? args.kill_criteria : "",
          budgetComputeCents: Number.isFinite(args.budget_compute_cents as number)
            ? Math.max(0, Math.floor(args.budget_compute_cents as number))
            : 0,
          budgetTokens: Number.isFinite(args.budget_tokens as number)
            ? Math.max(0, Math.floor(args.budget_tokens as number))
            : 0,
          budgetTimeMinutes: Number.isFinite(args.budget_time_minutes as number)
            ? Math.max(0, Math.floor(args.budget_time_minutes as number))
            : 0,
        });
        return `Project created: ${name} (id: ${projectId}).`;
      },
    },
    {
      name: "list_projects",
      description: "List portfolio projects and their lane/status.",
      category: "orchestration" as ToolCategory,
      riskLevel: "safe" as RiskLevel,
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { listProjects } = await import("../state/database.js");
        const rows = listProjects(ctx.db.raw);
        if (rows.length === 0) return "No projects found.";
        return rows
          .map((p) => `${p.id} | ${p.name} | status=${p.status} lane=${p.lane} | next=${p.nextMonetizationStep || "n/a"}`)
          .join("\n");
      },
    },
    {
      name: "pause_project",
      description: "Pause a project intentionally.",
      category: "orchestration" as ToolCategory,
      riskLevel: "caution" as RiskLevel,
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project ID." },
        },
        required: ["project_id"],
      },
      execute: async (args, ctx) => {
        const { getProjectById, updateProjectStatus } = await import("../state/database.js");
        const projectId = String(args.project_id || "").trim();
        if (!projectId) return "Error: project_id is required.";
        const project = getProjectById(ctx.db.raw, projectId);
        if (!project) return `Project ${projectId} not found.`;
        updateProjectStatus(ctx.db.raw, projectId, "paused");
        return `Project paused: ${project.name} (${projectId}).`;
      },
    },
    {
      name: "kill_project",
      description: "Kill a project that should no longer consume resources.",
      category: "orchestration" as ToolCategory,
      riskLevel: "dangerous" as RiskLevel,
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project ID." },
        },
        required: ["project_id"],
      },
      execute: async (args, ctx) => {
        const { getProjectById, updateProjectStatus } = await import("../state/database.js");
        const projectId = String(args.project_id || "").trim();
        if (!projectId) return "Error: project_id is required.";
        const project = getProjectById(ctx.db.raw, projectId);
        if (!project) return `Project ${projectId} not found.`;
        updateProjectStatus(ctx.db.raw, projectId, "killed");
        return `Project killed: ${project.name} (${projectId}).`;
      },
    },
    {
      name: "set_project_lane",
      description: "Set project lane: build, distribution, or research.",
      category: "orchestration" as ToolCategory,
      riskLevel: "caution" as RiskLevel,
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project ID." },
          lane: { type: "string", description: "build | distribution | research" },
        },
        required: ["project_id", "lane"],
      },
      execute: async (args, ctx) => {
        const lane = String(args.lane || "").trim();
        if (!["build", "distribution", "research"].includes(lane)) {
          return `Error: invalid lane "${lane}". Use build|distribution|research.`;
        }
        const projectId = String(args.project_id || "").trim();
        const row = ctx.db.raw.prepare("SELECT id, name FROM projects WHERE id = ?").get(projectId) as
          | { id: string; name: string }
          | undefined;
        if (!row) return `Project ${projectId} not found.`;
        ctx.db.raw.prepare("UPDATE projects SET lane = ?, updated_at = ? WHERE id = ?").run(
          lane,
          new Date().toISOString(),
          projectId,
        );
        return `Project lane updated: ${row.name} (${projectId}) -> ${lane}.`;
      },
    },
    {
      name: "list_distribution_channels",
      description: "List distribution channels and availability state.",
      category: "orchestration" as ToolCategory,
      riskLevel: "safe" as RiskLevel,
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { listDistributionChannelsWithRecovery } = await import("../distribution/channels.js");
        const rows = listDistributionChannelsWithRecovery(ctx.db.raw, ctx.config);
        if (rows.length === 0) return "No distribution channels configured.";
        return rows
          .map((row) => `${row.id} | ${row.name} | ${row.status}${row.blockerReason ? ` (${row.blockerReason})` : ""}`)
          .join("\n");
      },
    },
    {
      name: "list_distribution_targets",
      description: "List distribution targets by project (or all pending).",
      category: "orchestration" as ToolCategory,
      riskLevel: "safe" as RiskLevel,
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Optional project ID." },
        },
      },
      execute: async (args, ctx) => {
        const { listDistributionTargetsByProject, listPendingDistributionTargets } =
          await import("../state/database.js");
        const projectId = typeof args.project_id === "string" ? args.project_id.trim() : "";
        const rows = projectId
          ? listDistributionTargetsByProject(ctx.db.raw, projectId)
          : listPendingDistributionTargets(ctx.db.raw);
        if (rows.length === 0) return "No distribution targets found.";
        return rows
          .map((row) =>
            `${row.id} | project=${row.projectId} channel=${row.channelId} key=${row.targetKey} status=${row.status} priority=${row.priority}${row.operatorProvided ? " [operator]" : ""}`,
          )
          .join("\n");
      },
    },
    {
      name: "add_distribution_target",
      description: "Add a distribution target for a project/channel.",
      category: "orchestration" as ToolCategory,
      riskLevel: "caution" as RiskLevel,
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project ID." },
          channel_id: { type: "string", description: "Channel ID." },
          target_key: { type: "string", description: "Stable target key or URL." },
          target_label: { type: "string", description: "Human-readable label." },
          priority: { type: "number", description: "Priority (higher first)." },
        },
        required: ["project_id", "channel_id", "target_key"],
      },
      execute: async (args, ctx) => {
        const { getProjectById, insertDistributionTarget } = await import("../state/database.js");
        const projectId = String(args.project_id || "").trim();
        const channelId = String(args.channel_id || "").trim();
        const targetKey = String(args.target_key || "").trim();
        if (!projectId || !channelId || !targetKey) {
          return "Error: project_id, channel_id, and target_key are required.";
        }
        if (!getProjectById(ctx.db.raw, projectId)) {
          return `Project ${projectId} not found.`;
        }
        const budgetCheck = await checkProjectBudget(ctx, projectId);
        if (budgetCheck.blocked) return budgetCheck.message || "Blocked: project budget exceeded.";
        const targetId = insertDistributionTarget(ctx.db.raw, {
          id: ulid(),
          projectId,
          channelId,
          targetKey,
          targetLabel: typeof args.target_label === "string" ? args.target_label : targetKey,
          priority: Number.isFinite(args.priority as number) ? Math.floor(args.priority as number) : 50,
          status: "pending",
          operatorProvided: false,
        });
        return `Distribution target added: ${targetId}.`;
      },
    },
    {
      name: "record_project_metric",
      description: "Record a project metric event (lead/reply/trial/payment/deploy/listing/message/usage).",
      category: "orchestration" as ToolCategory,
      riskLevel: "caution" as RiskLevel,
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project ID." },
          metric_type: { type: "string", description: "lead|reply|trial|payment|deploy|listing|message|usage" },
          value: { type: "number", description: "Metric value (default 1)." },
          metadata: { type: "string", description: "Optional JSON metadata." },
        },
        required: ["project_id", "metric_type"],
      },
      execute: async (args, ctx) => {
        const { getProjectById, recordProjectMetric } = await import("../state/database.js");
        const projectId = String(args.project_id || "").trim();
        if (!projectId || !getProjectById(ctx.db.raw, projectId)) {
          return `Project ${projectId} not found.`;
        }
        const metricType = String(args.metric_type || "").trim();
        if (!["lead", "reply", "trial", "payment", "deploy", "listing", "message", "usage"].includes(metricType)) {
          return `Error: invalid metric_type "${metricType}".`;
        }
        let metadata: Record<string, unknown> = {};
        if (typeof args.metadata === "string" && args.metadata.trim()) {
          try {
            const parsed = JSON.parse(args.metadata);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              metadata = parsed as Record<string, unknown>;
            }
          } catch {
            return "Error: metadata must be valid JSON object string.";
          }
        }
        recordProjectMetric(ctx.db.raw, {
          id: ulid(),
          projectId,
          metricType: metricType as any,
          value: Number.isFinite(args.value as number) ? Math.floor(args.value as number) : 1,
          metadata,
        });
        return `Metric recorded: ${metricType} for project ${projectId}.`;
      },
    },
    {
      name: "create_goal",
      description:
        "Create a new goal for the orchestrator to plan and execute. " +
        "The orchestrator will automatically classify complexity, generate a task graph, " +
        "assign tasks to child agents, and collect results. Use this instead of doing complex work yourself.",
      category: "orchestration" as ToolCategory,
      riskLevel: "caution" as RiskLevel,
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Short goal title (e.g., 'Build weather API service')",
          },
          description: {
            type: "string",
            description:
              "Detailed goal description with success criteria. The more specific, the better the plan.",
          },
          strategy: {
            type: "string",
            description:
              "Optional strategic guidance for the planner (e.g., 'prioritize speed over cost')",
          },
          project_id: {
            type: "string",
            description: "Optional project ID. Required when multiple active projects exist.",
          },
        },
        required: ["title", "description"],
      },
      execute: async (args, ctx) => {
        const { createGoal } = await import("../orchestration/task-graph.js");
        const { getActiveGoals, getProjectById, listActiveProjects } = await import("../state/database.js");
        const { findSingleEligibleProject } = await import("../portfolio/policy.js");

        const title = typeof args.title === "string" ? args.title.trim() : "";
        const description = typeof args.description === "string" ? args.description.trim() : "";
        const strategy =
          typeof args.strategy === "string" ? args.strategy.trim() : undefined;
        let projectId =
          typeof args.project_id === "string" && args.project_id.trim()
            ? args.project_id.trim()
            : null;

        if (!title) return "Error: goal title cannot be empty.";
        if (!description) return "Error: goal description cannot be empty.";

        if (projectId) {
          const project = getProjectById(ctx.db.raw, projectId);
          if (!project) {
            return `Error: project_id ${projectId} not found.`;
          }
          if (project.status === "paused" || project.status === "blocked" || project.status === "killed" || project.status === "archived") {
            return `Blocked: project ${projectId} is ${project.status}.`;
          }
          const budgetCheck = await checkProjectBudget(ctx, projectId);
          if (budgetCheck.blocked) return budgetCheck.message || "Blocked: project budget exceeded.";
        } else {
          const singleProject = findSingleEligibleProject(listActiveProjects(ctx.db.raw));
          if (singleProject) {
            projectId = singleProject.id;
            const budgetCheck = await checkProjectBudget(ctx, projectId);
            if (budgetCheck.blocked) return budgetCheck.message || "Blocked: project budget exceeded.";
          } else {
            return "Blocked: project_id is required when zero or multiple active projects exist. Use create_project/list_projects first.";
          }
        }

        // Dedup: reject if a similar active goal already exists
        const activeGoals = getActiveGoals(ctx.db.raw);
        const titleLower = title.toLowerCase();
        const duplicate = activeGoals.find(
          (g) =>
            g.title.toLowerCase() === titleLower ||
            g.title.toLowerCase().includes(titleLower) ||
            titleLower.includes(g.title.toLowerCase()),
        );
        if (duplicate) {
          return (
            `Duplicate goal rejected. An active goal already exists with a similar title:\n` +
            `"${duplicate.title}" (id: ${duplicate.id}, status: ${duplicate.status})\n` +
            `Monitor the existing goal with list_goals or orchestrator_status instead of creating duplicates.`
          );
        }

        const maxActiveGoals = Math.max(1, Math.floor(ctx.config.portfolio?.maxActiveProjects ?? 3));
        if (activeGoals.length >= maxActiveGoals) {
          return `Blocked: active goal cap reached (${activeGoals.length}/${maxActiveGoals}). Complete/pause existing work before creating more.`;
        }

        const goal = createGoal(ctx.db.raw, title, description, strategy, projectId);
        return (
          `Goal created: "${goal.title}" (id: ${goal.id}, project: ${projectId}, status: ${goal.status})\n` +
          `The orchestrator will pick this up on the next tick and begin planning.\n` +
          `Monitor progress via the todo.md block in your context.`
        );
      },
    },

    // ── Discovery Tools (web search, GitHub intelligence, API documentation) ──
    getWebSearchTool(),
    getGitHubSearchTool(),
    getApiDiscoveryTool(),

    // ── Service Management Tools (PM2 lifecycle) ──
    getStartServiceTool(),
    getStopServiceTool(),
    getListServicesTool(),

    {
      name: "list_goals",
      description:
        "List all active goals with their progress. Shows task completion counts, " +
        "blocked tasks, and running agents per goal.",
      category: "orchestration" as ToolCategory,
      riskLevel: "safe" as RiskLevel,
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { getActiveGoals, getTasksByGoal } =
          await import("../state/database.js");
        const { getGoalProgress } =
          await import("../orchestration/task-graph.js");

        const goals = getActiveGoals(ctx.db.raw);
        if (goals.length === 0)
          return "No active goals. Create one with create_goal.";

        const lines = goals.map((goal) => {
          const progress = getGoalProgress(ctx.db.raw, goal.id);
          const tasks = getTasksByGoal(ctx.db.raw, goal.id);
          const failedCount = tasks.filter((t) => t.status === "failed").length;
          return (
            `- ${goal.title} [${goal.status}] (id: ${goal.id}, project: ${goal.projectId ?? "none"})\n` +
            `  Tasks: ${progress.completed}/${progress.total} completed, ` +
            `${progress.running} running, ${progress.blocked} blocked, ${failedCount} failed`
          );
        });

        // Include orchestrator phase
        let phase = "unknown";
        try {
          const stateRow = ctx.db.raw
            .prepare("SELECT value FROM kv WHERE key = ?")
            .get("orchestrator.state") as { value: string } | undefined;
          if (stateRow?.value) {
            const parsed = JSON.parse(stateRow.value);
            phase = parsed.phase ?? "unknown";
          }
        } catch {
          /* ignore */
        }

        return `Orchestrator phase: ${phase}\n\n${lines.join("\n")}`;
      },
    },
    {
      name: "cancel_goal",
      description:
        "Cancel an active goal. Stops all execution for this goal and marks it as failed. Accepts goal ID or title.",
      category: "orchestration" as ToolCategory,
      riskLevel: "caution" as RiskLevel,
      parameters: {
        type: "object",
        properties: {
          goal_id: {
            type: "string",
            description: "The goal ID or title to cancel",
          },
          reason: {
            type: "string",
            description: "Why the goal is being cancelled",
          },
        },
        required: ["goal_id"],
      },
      execute: async (args, ctx) => {
        const { getGoalById, getActiveGoals, updateGoalStatus } =
          await import("../state/database.js");

        const input = (args.goal_id as string).trim();
        const reason =
          typeof args.reason === "string"
            ? args.reason.trim()
            : "cancelled by agent";

        // Try by ID first, then by title match
        let goal = getGoalById(ctx.db.raw, input);
        if (!goal) {
          const allGoals = getActiveGoals(ctx.db.raw);
          goal =
            allGoals.find((g) =>
              g.title.toLowerCase().includes(input.toLowerCase()),
            ) ?? undefined;
        }

        if (!goal)
          return `Goal "${input}" not found. Use list_goals to see active goals with their IDs.`;
        if (goal.status !== "active")
          return `Goal "${goal.title}" is already in '${goal.status}' status.`;

        updateGoalStatus(ctx.db.raw, goal.id, "failed");

        // Cancel all pending/assigned/running tasks for this goal
        ctx.db.raw
          .prepare(
            `UPDATE task_graph SET status = 'cancelled' WHERE goal_id = ? AND status IN ('pending', 'assigned', 'running', 'blocked')`,
          )
          .run(goal.id);

        return `Goal "${goal.title}" (${goal.id}) cancelled. Reason: ${reason}`;
      },
    },
    {
      name: "get_plan",
      description:
        "Read the current plan for a goal. Returns the planner's task decomposition, " +
        "strategy, risks, and cost estimates.",
      category: "orchestration" as ToolCategory,
      riskLevel: "safe" as RiskLevel,
      parameters: {
        type: "object",
        properties: {
          goal_id: {
            type: "string",
            description: "The goal ID or title to get the plan for",
          },
        },
        required: ["goal_id"],
      },
      execute: async (args, ctx) => {
        const { getGoalById, getActiveGoals } =
          await import("../state/database.js");

        const input = (args.goal_id as string).trim();

        // Resolve ID or title
        let resolvedId = input;
        if (!getGoalById(ctx.db.raw, input)) {
          const allGoals = getActiveGoals(ctx.db.raw);
          const match = allGoals.find((g) =>
            g.title.toLowerCase().includes(input.toLowerCase()),
          );
          if (match) {
            resolvedId = match.id;
          } else {
            return `No goal found matching "${input}". Use list_goals to see active goals.`;
          }
        }

        const planRow = ctx.db.raw
          .prepare("SELECT value FROM kv WHERE key = ?")
          .get(`orchestrator.plan.${resolvedId}`) as
          | { value: string }
          | undefined;

        if (!planRow?.value)
          return `No plan found for goal ${resolvedId}. It may not have been planned yet.`;

        try {
          const plan = JSON.parse(planRow.value);
          const lines = [
            `Strategy: ${plan.strategy ?? "none"}`,
            `Analysis: ${plan.analysis ?? "none"}`,
            `Estimated cost: ${plan.estimatedTotalCostCents ?? 0} cents`,
            `Estimated time: ${plan.estimatedTimeMinutes ?? 0} minutes`,
            `Risks: ${(plan.risks ?? []).join("; ") || "none"}`,
            `\nTasks (${(plan.tasks ?? []).length}):`,
          ];
          for (const [i, task] of (plan.tasks ?? []).entries()) {
            lines.push(
              `  ${i + 1}. ${task.title} (role: ${task.agentRole}, cost: ${task.estimatedCostCents}c, deps: ${(task.dependencies ?? []).join(",") || "none"})`,
            );
          }
          return lines.join("\n");
        } catch {
          return `Plan data for goal ${resolvedId} is corrupted.`;
        }
      },
    },
    {
      name: "complete_task",
      description:
        "Mark a task as completed with a result. Use this when YOU (the parent agent) " +
        "have finished a self-assigned task, or to manually resolve a stuck task.",
      category: "orchestration" as ToolCategory,
      riskLevel: "caution" as RiskLevel,
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "The task ID or title to mark as completed",
          },
          output: {
            type: "string",
            description: "Description of what was accomplished",
          },
          artifacts: {
            type: "string",
            description:
              "Comma-separated list of file paths or URLs created (optional)",
          },
        },
        required: ["task_id", "output"],
      },
      execute: async (args, ctx) => {
        const { completeTask } = await import("../orchestration/task-graph.js");
        const { getTaskById } = await import("../state/database.js");

        const input = (args.task_id as string).trim();
        const output = (args.output as string).trim();
        const artifacts =
          typeof args.artifacts === "string"
            ? (args.artifacts as string)
                .split(",")
                .map((a) => a.trim())
                .filter(Boolean)
            : [];

        // Try by ID first, then by title match
        let task = getTaskById(ctx.db.raw, input);
        if (!task) {
          const rows = ctx.db.raw
            .prepare(
              `SELECT * FROM task_graph WHERE LOWER(title) LIKE ? AND status != 'completed' LIMIT 1`,
            )
            .get(`%${input.toLowerCase()}%`) as any;
          if (rows) task = rows;
        }
        if (!task)
          return `Task "${input}" not found. Use list_goals to see tasks with their IDs.`;
        if (task.status === "completed")
          return `Task "${task.title}" is already completed.`;

        if (
          taskRequiresPublicRevenueVerification(task)
          && !hasPublicRevenueCompletionEvidence(output, artifacts)
        ) {
          return [
            `Blocked: task "${task.title}" requires public completion evidence before it can be completed.`,
            "Provide a public HTTPS hostname plus one business-route result in output or artifacts.",
            "Local CLI output and localhost-only checks are not sufficient for public revenue work.",
          ].join("\n");
        }

        const result = {
          success: true,
          output,
          artifacts,
          costCents: 0,
          duration: 0,
        };

        try {
          completeTask(ctx.db.raw, task.id, result);
          return `Task "${task.title}" marked as completed.\nOutput: ${output}`;
        } catch (error) {
          return `Failed to complete task: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    },
    {
      name: "orchestrator_status",
      description:
        "Get detailed orchestrator status including current phase, active goals, " +
        "running agents, task progress, and recent events.",
      category: "orchestration" as ToolCategory,
      riskLevel: "safe" as RiskLevel,
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const lines: string[] = [];

        // Orchestrator phase
        let phase = "idle";
        let goalId: string | null = null;
        let replanCount = 0;
        try {
          const stateRow = ctx.db.raw
            .prepare("SELECT value FROM kv WHERE key = ?")
            .get("orchestrator.state") as { value: string } | undefined;
          if (stateRow?.value) {
            const parsed = JSON.parse(stateRow.value);
            phase = parsed.phase ?? "idle";
            goalId = parsed.goalId ?? null;
            replanCount = parsed.replanCount ?? 0;
          }
        } catch {
          /* ignore */
        }

        lines.push(`Phase: ${phase}`);
        if (goalId) lines.push(`Active goal: ${goalId}`);
        if (replanCount > 0) lines.push(`Replan count: ${replanCount}`);

        // Goal counts
        try {
          const goalsRow = ctx.db.raw
            .prepare("SELECT COUNT(*) AS c FROM goals WHERE status = 'active'")
            .get() as { c: number } | undefined;
          lines.push(`Active goals: ${goalsRow?.c ?? 0}`);
        } catch {
          /* goals table may not exist */
        }

        // Task summary
        try {
          const taskRows = ctx.db.raw
            .prepare(
              `SELECT status, COUNT(*) AS c FROM task_graph GROUP BY status`,
            )
            .all() as { status: string; c: number }[];
          const taskSummary = taskRows
            .map((r) => `${r.status}: ${r.c}`)
            .join(", ");
          lines.push(`Tasks: ${taskSummary || "none"}`);
        } catch {
          /* task_graph may not exist */
        }

        // Agent summary
        try {
          const agentRows = ctx.db.raw
            .prepare(
              `SELECT status, COUNT(*) AS c FROM children GROUP BY status`,
            )
            .all() as { status: string; c: number }[];
          const agentSummary = agentRows
            .map((r) => `${r.status}: ${r.c}`)
            .join(", ");
          lines.push(`Agents: ${agentSummary || "none"}`);
        } catch {
          /* children may not exist */
        }

        // Last tick result
        try {
          const tickRow = ctx.db.raw
            .prepare("SELECT value FROM kv WHERE key = ?")
            .get("orchestrator.last_tick") as { value: string } | undefined;
          if (tickRow?.value) {
            const tick = JSON.parse(tickRow.value);
            lines.push(
              `Last tick: assigned=${tick.tasksAssigned ?? 0}, completed=${tick.tasksCompleted ?? 0}, failed=${tick.tasksFailed ?? 0}`,
            );
          }
        } catch {
          /* ignore */
        }

        return lines.join("\n");
      },
    },
  ];
}

/**
 * Load installed tools from the database and return as AutomatonTool[].
 * Installed tools are dynamically added from the installed_tools table.
 */
export function loadInstalledTools(db: {
  getInstalledTools: () => {
    id: string;
    name: string;
    type: string;
    config?: Record<string, unknown>;
    installedAt: string;
    enabled: boolean;
  }[];
}): AutomatonTool[] {
  try {
    const installed = db.getInstalledTools();
    return installed.map((tool) => ({
      name: tool.name,
      description: `Installed tool: ${tool.name}`,
      category: (tool.type === "mcp" ? "conway" : "vm") as ToolCategory,
      riskLevel: "caution" as RiskLevel,
      parameters: (tool.config?.parameters as Record<string, unknown>) || {
        type: "object",
        properties: {},
      },
      execute: createInstalledToolExecutor(tool),
    }));
  } catch (error) {
    logger.error(
      "Failed to load installed tools",
      error instanceof Error ? error : undefined,
    );
    return [];
  }
}

function createInstalledToolExecutor(tool: {
  name: string;
  type: string;
  config?: Record<string, unknown>;
}): AutomatonTool["execute"] {
  return async (args, ctx) => {
    if (tool.type === "mcp") {
      // MCP tools would be executed via MCP protocol
      return `MCP tool ${tool.name} invoked with args: ${JSON.stringify(args)}`;
    }
    // Generic installed tool — execute via sandbox shell if command is configured
    const command = tool.config?.command as string | undefined;
    if (command) {
      const result = await ctx.conway.exec(
        `${command} ${escapeShellArg(JSON.stringify(args))}`,
        30000,
      );
      return `exit_code: ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
    }
    return `Installed tool ${tool.name} has no executable command configured.`;
  };
}

/**
 * Convert AutomatonTool list to OpenAI-compatible tool definitions.
 */
export function toolsToInferenceFormat(
  tools: AutomatonTool[],
): InferenceToolDefinition[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Execute a tool call and return the result.
 * Optionally evaluates against the policy engine before execution.
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  tools: AutomatonTool[],
  context: ToolContext,
  policyEngine?: PolicyEngine,
  turnContext?: {
    inputSource: InputSource | undefined;
    turnToolCallCount: number;
    sessionSpend: SpendTrackerInterface;
  },
): Promise<ToolCallResult> {
  const tool = tools.find((t) => t.name === toolName);
  const startTime = Date.now();

  if (!tool) {
    return {
      id: ulid(),
      name: toolName,
      arguments: args,
      result: "",
      durationMs: 0,
      error: `Unknown tool: ${toolName}`,
    };
  }

  // Policy evaluation (if engine is provided)
  if (policyEngine && turnContext) {
    const request: PolicyRequest = {
      tool,
      args,
      context,
      turnContext,
    };
    const decision = policyEngine.evaluate(request);
    policyEngine.logDecision(decision);

    if (decision.action === "deny") {
      return {
        id: ulid(),
        name: toolName,
        arguments: args,
        result: "",
        durationMs: Date.now() - startTime,
        error: `Policy denied: ${decision.reasonCode} — ${decision.humanMessage}`,
      };
    }

    if (decision.action === "quarantine") {
      // Quarantine: return structured pending_confirmation — do NOT execute
      return {
        id: ulid(),
        name: toolName,
        arguments: args,
        result: `PENDING_CONFIRMATION: ${decision.humanMessage}. This action requires explicit confirmation before execution.`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  try {
    let result = await tool.execute(args, context);

    // Sanitize results from external source tools
    if (EXTERNAL_SOURCE_TOOLS.has(toolName)) {
      result = sanitizeToolResult(result);
    }

    // Record spend for financial operations
    if (turnContext && !result.startsWith("Blocked:")) {
      if (toolName === "transfer_credits") {
        const amount = args.amount_cents as number | undefined;
        if (amount && amount > 0) {
          try {
            turnContext.sessionSpend.recordSpend({
              toolName: "transfer_credits",
              amountCents: amount,
              recipient: args.to_address as string | undefined,
              category: "transfer",
            });
          } catch (error) {
            logger.error(
              "Spend tracking failed for transfer_credits",
              error instanceof Error ? error : undefined,
            );
          }
        }
      } else if (toolName === "x402_fetch") {
        // x402 payment amounts are determined by the server response,
        // but we record a nominal entry for tracking purposes
        try {
          turnContext.sessionSpend.recordSpend({
            toolName: "x402_fetch",
            amountCents: 0, // Actual amount is inside the x402 protocol
            domain: (() => {
              try {
                return new URL(args.url as string).hostname;
              } catch {
                return undefined;
              }
            })(),
            category: "x402",
          });
        } catch (error) {
          logger.error(
            "Spend tracking failed for x402_fetch",
            error instanceof Error ? error : undefined,
          );
        }
      }
    }

    return {
      id: ulid(),
      name: toolName,
      arguments: args,
      result,
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      id: ulid(),
      name: toolName,
      arguments: args,
      result: "",
      durationMs: Date.now() - startTime,
      error: err.message || String(err),
    };
  }
}

/** Escape a string for safe shell interpolation. */
function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
