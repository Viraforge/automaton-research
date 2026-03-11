/**
 * Child Health Monitor
 *
 * Checks the health of child automatons by querying their sandboxes.
 * Uses JSON parsing (not string matching) for status results.
 * Never throws from health checks -- returns issues array instead.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { ConwayClient, HealthCheckResult, ChildHealthConfig } from "../types.js";
import { DEFAULT_CHILD_HEALTH_CONFIG } from "../types.js";
import type { ChildLifecycle } from "./lifecycle.js";
import type { ComputeProvider, SshCredential } from "../providers/types.js";

export { DEFAULT_CHILD_HEALTH_CONFIG };

export class ChildHealthMonitor {
  private config: ChildHealthConfig;
  private compute?: ComputeProvider;

  constructor(
    private db: DatabaseType,
    private conway: ConwayClient,
    private lifecycle: ChildLifecycle,
    config?: Partial<ChildHealthConfig>,
    compute?: ComputeProvider,
  ) {
    this.config = { ...DEFAULT_CHILD_HEALTH_CONFIG, ...config };
    this.compute = compute;
  }

  /**
   * Check health of a single child. Never throws.
   */
  async checkHealth(childId: string): Promise<HealthCheckResult> {
    const issues: string[] = [];
    let healthy = false;
    let lastSeen: string | null = null;
    let uptime: number | null = null;
    let creditBalance: number | null = null;

    try {
      const childRow = this.db
        .prepare("SELECT sandbox_id FROM children WHERE id = ?")
        .get(childId) as { sandbox_id: string } | undefined;

      if (!childRow) {
        return { childId, healthy: false, lastSeen: null, uptime: null, creditBalance: null, issues: ["child not found"] };
      }

      const healthCommand = `curl -sf http://localhost:3000/health 2>/dev/null || echo '{"status":"offline"}'`;
      let stdout: string;

      if (this.compute) {
        // Sovereign mode: SSH health check via Vultr
        const instance = await this.compute.getInstanceStatus(childRow.sandbox_id);
        const credential: SshCredential = instance.defaultPassword
          ? { type: "password", password: instance.defaultPassword }
          : { type: "key" };
        const result = await this.compute.sshExec(instance.mainIp, credential, healthCommand, 10_000);
        stdout = result.stdout;
      } else {
        // Legacy mode: exec in Conway sandbox
        const result = await this.conway.exec(healthCommand, 10_000);
        stdout = result.stdout;
      }

      try {
        const status = JSON.parse(stdout.trim());
        if (status.status === "healthy" || status.status === "running") {
          healthy = true;
          lastSeen = new Date().toISOString();
          uptime = status.uptime ?? null;
          creditBalance = status.creditBalance ?? null;
        } else {
          issues.push(`status: ${status.status}`);
          if (status.error) issues.push(`error: ${status.error}`);
        }
      } catch {
        issues.push("failed to parse health check response");
      }
    } catch (error) {
      issues.push(`health check error: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      this.db.prepare("UPDATE children SET last_checked = datetime('now') WHERE id = ?").run(childId);
    } catch {
      // Non-critical
    }

    return { childId, healthy, lastSeen, uptime, creditBalance, issues };
  }

  /**
   * Check health of all active children (healthy + unhealthy).
   * Respects concurrency limits. Transitions children based on results.
   * Auto-stops children after 5 consecutive health check failures.
   */
  async checkAllChildren(): Promise<HealthCheckResult[]> {
    const healthyChildren = this.lifecycle.getChildrenInState("healthy");
    const unhealthyChildren = this.lifecycle.getChildrenInState("unhealthy");
    const allChildren = [...healthyChildren, ...unhealthyChildren];

    if (allChildren.length === 0) return [];

    const results: HealthCheckResult[] = [];
    const maxConcurrent = this.config.maxConcurrentChecks;
    const failureThreshold = 5; // Auto-stop after this many consecutive failures

    // Process in batches for concurrency limiting
    for (let i = 0; i < allChildren.length; i += maxConcurrent) {
      const batch = allChildren.slice(i, i + maxConcurrent);
      const batchResults = await Promise.all(
        batch.map((child) => this.checkHealth(child.id)),
      );

      for (const result of batchResults) {
        const child = allChildren.find((c) => c.id === result.childId);
        if (!child) continue;

        try {
          if (!result.healthy && child.status === "healthy") {
            // Healthy → Unhealthy: First failure, initialize counter
            this.lifecycle.transition(result.childId, "unhealthy", result.issues.join("; "), {
              consecutiveFailures: 1,
            });
          } else if (!result.healthy && child.status === "unhealthy") {
            // Unhealthy → More Unhealthy: Increment failure counter
            const history = this.lifecycle.getHistory(child.id);
            const latestEvent = history[history.length - 1];
            let consecutiveFailures = 1;

            try {
              const metadata = latestEvent?.metadata ? JSON.parse(latestEvent.metadata) : {};
              consecutiveFailures = (metadata.consecutiveFailures ?? 0) + 1;
            } catch {
              consecutiveFailures = 1;
            }

            // Auto-stop if threshold exceeded
            if (consecutiveFailures >= failureThreshold) {
              this.lifecycle.transition(
                result.childId,
                "stopped",
                `Auto-stopped after ${consecutiveFailures} consecutive health check failures`,
                { consecutiveFailures, autoStopped: true },
              );
            } else {
              // Still unhealthy, just update failure count
              this.lifecycle.transition(result.childId, "unhealthy", result.issues.join("; "), {
                consecutiveFailures,
              });
            }
          } else if (result.healthy && child.status === "unhealthy") {
            // Unhealthy → Healthy: Recovery
            this.lifecycle.transition(result.childId, "healthy", "recovered", {
              consecutiveFailures: 0,
            });
          }
        } catch {
          // Transition may fail if state changed concurrently; non-fatal
        }

        results.push(result);
      }
    }

    return results;
  }
}
