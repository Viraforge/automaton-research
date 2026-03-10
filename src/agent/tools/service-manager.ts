import type { AutomatonTool, ToolContext, ToolCategory } from "../../types.js";
import { execFileSync } from "child_process";
import * as path from "path";
import { createLogger } from "../../observability/logger.js";

const logger = createLogger("service-manager");

// ── Constants ──
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/;
const ALLOWED_SCRIPT_EXT = /\.js$/;
const PORT_MIN = 3000;
const PORT_MAX = 9999;
const FORBIDDEN_PORTS = new Set([9615]); // pm2 bus
const SAFE_ENV_KEY_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const SERVICES_KV_KEY = "services.managed";

// ── Types ──
interface ManagedService {
  name: string;
  scriptPath: string;
  port: number | null;
  startedAt: string;
}

interface Pm2Process {
  name: string;
  pid: number;
  pm_id: number;
  pm2_env?: { status: string; pm_uptime?: number; restart_time?: number };
}

// ── Helpers ──
function getAllowedRoots(): string[] {
  const home = process.env.HOME ?? "/root";
  return [
    path.join(home, ".automaton", "services"),
    path.join(home, ".automaton-research-home"),
  ];
}

function readManagedServices(ctx: ToolContext): ManagedService[] {
  const raw = ctx.db.getKV(SERVICES_KV_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ManagedService[];
  } catch {
    return []; // corrupted state → treat as empty
  }
}

function writeManagedServices(ctx: ToolContext, services: ManagedService[]): void {
  ctx.db.setKV(SERVICES_KV_KEY, JSON.stringify(services));
}

function parsePm2List(output: string): Pm2Process[] {
  try {
    return JSON.parse(output) as Pm2Process[];
  } catch {
    return []; // bad output → treat as empty
  }
}

function isPathAllowed(scriptPath: string): boolean {
  const absolute = path.resolve(scriptPath);
  const allowedRoots = getAllowedRoots();
  return allowedRoots.some((root) => absolute.startsWith(root + path.sep) || absolute === root);
}

// ── Tool Factories ──

export function getStartServiceTool(): AutomatonTool {
  return {
    name: "start_service",
    description:
      "Start a persistent HTTP service via PM2. Provide script path, port, and optional environment variables. " +
      "Service runs in background and restarts automatically on crash. " +
      "Only manages services in ~/.automaton/services or ~/.automaton-research-home directories.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Service name (alphanumeric and hyphens, 1-64 chars). Must not already exist in PM2.",
        },
        scriptPath: {
          type: "string",
          description:
            "Absolute path to Node.js script (.js). Must be in ~/.automaton/services or ~/.automaton-research-home.",
        },
        port: {
          type: "number",
          description: "Port number (3000-9999). Cannot use 9615 (PM2 reserved).",
        },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Optional environment variables (uppercase keys only, max 63 chars).",
        },
      },
      required: ["name", "scriptPath", "port"],
    },
    riskLevel: "caution",
    category: "services" as ToolCategory,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      try {
        // ── Validate inputs ──
        const name = String(args.name);
        if (!SAFE_NAME_RE.test(name)) {
          return JSON.stringify({
            success: false,
            error: `Service name must be alphanumeric with hyphens, 1-64 chars. Got: "${name}"`,
          });
        }

        const scriptPath = String(args.scriptPath);
        if (!ALLOWED_SCRIPT_EXT.test(scriptPath)) {
          return JSON.stringify({
            success: false,
            error: `Script must end in .js. Got: "${scriptPath}"`,
          });
        }

        if (!isPathAllowed(scriptPath)) {
          const roots = getAllowedRoots();
          return JSON.stringify({
            success: false,
            error: `Script path must be in allowed directories: ${roots.join(", ")}. Got: "${scriptPath}"`,
          });
        }

        const port = Number(args.port);
        if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
          return JSON.stringify({
            success: false,
            error: `Port must be integer ${PORT_MIN}-${PORT_MAX}. Got: ${port}`,
          });
        }

        if (FORBIDDEN_PORTS.has(port)) {
          return JSON.stringify({
            success: false,
            error: `Port ${port} is reserved by PM2 and cannot be used.`,
          });
        }

        // ── Query PM2 for name collision and port collision checks ──
        let pm2List: Pm2Process[] = [];
        try {
          const pm2Output = execFileSync("pm2", ["jlist"], { encoding: "utf-8" });
          pm2List = parsePm2List(pm2Output);
        } catch (err) {
          logger.warn(`Failed to query pm2 jlist: ${err instanceof Error ? err.message : String(err)}`);
          // Continue anyway — if pm2 isn't available, the start will fail below
        }

        // ── Check port uniqueness against managed services and live PM2 ──
        const managedServices = readManagedServices(ctx);
        if (managedServices.some((s) => s.port === port)) {
          return JSON.stringify({
            success: false,
            error: `Port ${port} is already in use by another managed service. Choose a different port.`,
          });
        }

        // Also check against any running PM2 processes that might have the same port
        const managedNames = new Set(managedServices.map((s) => s.name));
        for (const proc of pm2List) {
          // Skip processes we're tracking (already checked above); only warn about divergence
          if (!managedNames.has(proc.name)) continue;
          const managedService = managedServices.find((s) => s.name === proc.name);
          if (managedService?.port === port) {
            return JSON.stringify({
              success: false,
              error: `Port ${port} is already allocated to service "${proc.name}". Choose a different port.`,
            });
          }
        }

        // ── Check PM2 name collision (HIGH priority) ──

        const existingProc = pm2List.find((p) => p.name === name);
        if (existingProc) {
          return JSON.stringify({
            success: false,
            error: `Name "${name}" already in use by an existing PM2 process (PID ${existingProc.pid}). Choose a different name.`,
          });
        }

        // ── Validate env vars ──
        const envInput = (args.env as Record<string, unknown>) || {};
        const customEnv: Record<string, string> = {};
        for (const [key, value] of Object.entries(envInput)) {
          if (!SAFE_ENV_KEY_RE.test(key)) {
            return JSON.stringify({
              success: false,
              error: `Environment key must be uppercase alphanumeric with underscores. Got: "${key}"`,
            });
          }
          customEnv[key] = String(value);
        }

        // Merge with current process env
        const mergedEnv = { ...process.env, ...customEnv };

        // ── Start service via PM2 ──
        // PM2 defaults to auto-restart enabled; only specify --no-autorestart if explicitly requested
        const pmStartArgs = ["start", scriptPath, "--name", name];
        execFileSync("pm2", pmStartArgs, { env: mergedEnv });

        // ── Save PM2 state ──
        try {
          execFileSync("pm2", ["save"]);
        } catch (err) {
          logger.warn(`Failed to save PM2 state: ${err instanceof Error ? err.message : String(err)}`);
          // Non-fatal
        }

        // ── Read back process info ──
        let pid: number | null = null;
        try {
          const pm2Output = execFileSync("pm2", ["jlist"], { encoding: "utf-8" });
          const updatedList = parsePm2List(pm2Output);
          const started = updatedList.find((p) => p.name === name);
          pid = started?.pid ?? null;
        } catch {
          // Best-effort — continue even if we can't read back the pid
        }

        // ── Store in KV ──
        const managed = readManagedServices(ctx);
        managed.push({
          name,
          scriptPath,
          port,
          startedAt: new Date().toISOString(),
        });
        writeManagedServices(ctx, managed);

        logger.info(`[START_SERVICE] Started "${name}" on port ${port}` + (pid ? ` (PID ${pid})` : ""));

        return JSON.stringify({
          success: true,
          name,
          scriptPath,
          port,
          pid,
          url: `http://127.0.0.1:${port}`,
          startedAt: new Date().toISOString(),
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error(`[START_SERVICE] Error: ${errorMsg}`);
        return JSON.stringify({
          success: false,
          error: `start_service failed: ${errorMsg}`,
        });
      }
    },
  };
}

export function getStopServiceTool(): AutomatonTool {
  return {
    name: "stop_service",
    description:
      "Stop a persistent service managed by start_service. Service must have been started via start_service tool. " +
      "Removes service from PM2 and internal registry.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Service name to stop (must be in managed services registry).",
        },
      },
      required: ["name"],
    },
    riskLevel: "caution",
    category: "services" as ToolCategory,

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      try {
        const name = String(args.name);

        // ── Validate name ──
        if (!SAFE_NAME_RE.test(name)) {
          return JSON.stringify({
            success: false,
            error: `Invalid service name: "${name}"`,
          });
        }

        // ── Check if managed ──
        const managed = readManagedServices(ctx);
        const service = managed.find((s) => s.name === name);
        if (!service) {
          return JSON.stringify({
            success: false,
            error: `Service "${name}" is not in managed services registry. Only services started via start_service can be stopped.`,
          });
        }

        // ── Delete via PM2 ──
        // First check if process exists in PM2
        let processExists = false;
        try {
          const pm2Output = execFileSync("pm2", ["jlist"], { encoding: "utf-8" });
          const pm2List = parsePm2List(pm2Output);
          processExists = pm2List.some((p) => p.name === name);
        } catch {
          // Can't check, proceed with delete attempt anyway
        }

        // Attempt to delete
        try {
          execFileSync("pm2", ["delete", name]);
        } catch (err) {
          // Only treat as success if process didn't exist; otherwise this is a real error
          if (processExists) {
            throw err;
          }
          logger.warn(`pm2 delete failed but process was not in PM2 (already gone): ${err instanceof Error ? err.message : String(err)}`);
        }

        // ── Save PM2 state ──
        try {
          execFileSync("pm2", ["save"]);
        } catch (err) {
          logger.warn(`Failed to save PM2 state: ${err instanceof Error ? err.message : String(err)}`);
          // Non-fatal
        }

        // ── Remove from KV ──
        const updated = managed.filter((s) => s.name !== name);
        writeManagedServices(ctx, updated);

        logger.info(`[STOP_SERVICE] Stopped "${name}"`);

        return JSON.stringify({
          success: true,
          name,
          message: `Service "${name}" stopped and removed from registry.`,
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error(`[STOP_SERVICE] Error: ${errorMsg}`);
        return JSON.stringify({
          success: false,
          error: `stop_service failed: ${errorMsg}`,
        });
      }
    },
  };
}

export function getListServicesTool(): AutomatonTool {
  return {
    name: "list_services",
    description:
      "List all running PM2 processes. Marks services as 'managed' if they were started via start_service tool, " +
      "with 'stoppable' flag for services that can be safely stopped. Unmanaged processes are marked read-only.",
    parameters: {
      type: "object",
      properties: {},
    },
    riskLevel: "safe",
    category: "services" as ToolCategory,

    async execute(_args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      try {
        // ── Read managed set ──
        const managed = readManagedServices(ctx);
        const managedNames = new Set(managed.map((s) => s.name));

        // ── Query PM2 ──
        let pm2List: Pm2Process[] = [];
        try {
          const pm2Output = execFileSync("pm2", ["jlist"], { encoding: "utf-8" });
          pm2List = parsePm2List(pm2Output);
        } catch (err) {
          logger.warn(`Failed to query pm2 jlist: ${err instanceof Error ? err.message : String(err)}`);
          // Continue with empty list
        }

        // ── Cross-reference ──
        const services = pm2List.map((proc) => {
          const isManagedByUs = managedNames.has(proc.name);
          const managedService = managed.find((s) => s.name === proc.name);
          return {
            name: proc.name,
            pid: proc.pid,
            pm_id: proc.pm_id,
            status: proc.pm2_env?.status || "unknown",
            managed: isManagedByUs,
            stoppable: isManagedByUs,
            port: managedService?.port || null,
            startedAt: managedService?.startedAt || null,
            uptime: proc.pm2_env?.pm_uptime ? `${Math.floor((Date.now() - proc.pm2_env.pm_uptime) / 1000)}s` : null,
          };
        });

        logger.info(
          `[LIST_SERVICES] Found ${services.length} processes (${services.filter((s) => s.managed).length} managed)`
        );

        return JSON.stringify({
          success: true,
          services,
          managed: services.filter((s) => s.managed),
          unmanaged: services.filter((s) => !s.managed),
          count: services.length,
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error(`[LIST_SERVICES] Error: ${errorMsg}`);
        return JSON.stringify({
          success: false,
          error: `list_services failed: ${errorMsg}`,
        });
      }
    },
  };
}
