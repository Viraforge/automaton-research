import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock child_process BEFORE importing the tool
vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "child_process";
import { getStartServiceTool, getStopServiceTool, getListServicesTool } from "../../agent/tools/service-manager.js";
import type { AutomatonTool, ToolContext } from "../../types.js";

const mockExec = vi.mocked(execFileSync);

// Mock context
function createMockContext(): ToolContext {
  const kvStore = new Map<string, string>();
  return {
    identity: {} as any,
    config: {} as any,
    db: {
      getKV: (key: string) => kvStore.get(key),
      setKV: (key: string, value: string) => kvStore.set(key, value),
      deleteKV: (key: string) => kvStore.delete(key),
    } as any,
    conway: {} as any,
    inference: {} as any,
  };
}

describe("service_manager tools", () => {
  beforeEach(() => {
    mockExec.mockClear();
    vi.clearAllMocks();
  });

  describe("start_service", () => {
    let tool: AutomatonTool;

    beforeEach(() => {
      tool = getStartServiceTool();
    });

    it("should validate service name with shell metacharacters", async () => {
      const ctx = createMockContext();
      const result = await tool.execute(
        {
          name: "my; rm -rf /",
          scriptPath: "/root/.automaton/services/test.js",
          port: 3000,
        },
        ctx
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toMatch(/alphanumeric/i);
    });

    it("should reject non-.js script path", async () => {
      const ctx = createMockContext();
      const result = await tool.execute(
        {
          name: "test-service",
          scriptPath: "/root/.automaton/services/test.sh",
          port: 3000,
        },
        ctx
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toMatch(/\.js/);
    });

    it("should reject relative path", async () => {
      const ctx = createMockContext();
      const result = await tool.execute(
        {
          name: "test-service",
          scriptPath: "./test.js",
          port: 3000,
        },
        ctx
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toMatch(/allowed directories/i);
    });

    it("should reject path outside allowed roots", async () => {
      const ctx = createMockContext();
      const result = await tool.execute(
        {
          name: "test-service",
          scriptPath: "/tmp/evil.js",
          port: 3000,
        },
        ctx
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toMatch(/allowed directories/);
    });

    it("should reject port < 3000", async () => {
      const ctx = createMockContext();
      const home = process.env.HOME ?? "/root";
      const scriptPath = `${home}/.automaton/services/test.js`;
      const result = await tool.execute(
        {
          name: "test-service",
          scriptPath,
          port: 2999,
        },
        ctx
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toMatch(/3000-9999/);
    });

    it("should reject port > 9999", async () => {
      const ctx = createMockContext();
      const home = process.env.HOME ?? "/root";
      const scriptPath = `${home}/.automaton/services/test.js`;
      const result = await tool.execute(
        {
          name: "test-service",
          scriptPath,
          port: 10000,
        },
        ctx
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toMatch(/3000-9999/);
    });

    it("should reject forbidden port 9615", async () => {
      const ctx = createMockContext();
      const home = process.env.HOME ?? "/root";
      const scriptPath = `${home}/.automaton/services/test.js`;
      const result = await tool.execute(
        {
          name: "test-service",
          scriptPath,
          port: 9615,
        },
        ctx
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toMatch(/9615.*reserved/);
    });

    it("should reject invalid environment variable keys", async () => {
      const ctx = createMockContext();
      const home = process.env.HOME ?? "/root";
      const scriptPath = `${home}/.automaton/services/test.js`;
      const result = await tool.execute(
        {
          name: "test-service",
          scriptPath,
          port: 3000,
          env: { "invalid-key": "value" },
        },
        ctx
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toMatch(/uppercase alphanumeric/);
    });

    it("should reject name that already exists in PM2", async () => {
      const ctx = createMockContext();
      const home = process.env.HOME ?? "/root";
      const scriptPath = `${home}/.automaton/services/test.js`;

      // First call to pm2 jlist should show existing process
      mockExec.mockReturnValueOnce(
        JSON.stringify([
          {
            name: "my-api",
            pid: 12345,
            pm_id: 0,
            pm2_env: { status: "online" },
          },
        ]) as any
      );

      const result = await tool.execute(
        {
          name: "my-api",
          scriptPath,
          port: 3000,
        },
        ctx
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toMatch(/already in use/);
    });

    it("should successfully start a service", async () => {
      const ctx = createMockContext();
      const home = process.env.HOME ?? "/root";
      const scriptPath = `${home}/.automaton/services/test.js`;

      // Mock pm2 jlist calls
      mockExec
        .mockReturnValueOnce(JSON.stringify([]) as any) // First jlist (collision check)
        .mockReturnValueOnce("" as any) // pm2 start (no return)
        .mockReturnValueOnce("" as any) // pm2 save (no return)
        .mockReturnValueOnce(
          JSON.stringify([
            { name: "test-service", pid: 54321, pm_id: 0, pm2_env: { status: "online" } },
          ]) as any
        ); // Second jlist (read back pid)

      const result = await tool.execute(
        {
          name: "test-service",
          scriptPath,
          port: 3010,
        },
        ctx
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.name).toBe("test-service");
      expect(parsed.port).toBe(3010);
      expect(parsed.pid).toBe(54321);
      expect(parsed.url).toBe("http://127.0.0.1:3010");

      // Verify PM2 calls were made with correct arguments
      expect(mockExec).toHaveBeenCalledWith("pm2", ["jlist"], expect.any(Object)); // collision check
      expect(mockExec).toHaveBeenCalledWith("pm2", ["start", scriptPath, "--name", "test-service"], expect.any(Object));
      expect(mockExec).toHaveBeenCalledWith("pm2", ["save"]);

      // Verify it's stored in KV
      const managed = JSON.parse(ctx.db.getKV("services.managed")!);
      expect(managed).toHaveLength(1);
      expect(managed[0].name).toBe("test-service");
      expect(managed[0].port).toBe(3010);
    });
  });

  describe("stop_service", () => {
    let tool: AutomatonTool;

    beforeEach(() => {
      tool = getStopServiceTool();
    });

    it("should reject unmanaged service", async () => {
      const ctx = createMockContext();
      const result = await tool.execute({ name: "unknown-service" }, ctx);

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toMatch(/not in managed services registry/);
    });

    it("should successfully stop a managed service", async () => {
      const ctx = createMockContext();
      // Set up a managed service
      ctx.db.setKV(
        "services.managed",
        JSON.stringify([
          {
            name: "test-service",
            scriptPath: "/root/.automaton/services/test.js",
            port: 3010,
            startedAt: new Date().toISOString(),
          },
        ])
      );

      mockExec
        .mockReturnValueOnce(
          JSON.stringify([
            { name: "test-service", pid: 54321, pm_id: 0, pm2_env: { status: "online" } },
          ]) as any
        ) // pm2 jlist (check if process exists)
        .mockReturnValueOnce("" as any) // pm2 delete
        .mockReturnValueOnce("" as any); // pm2 save

      const result = await tool.execute({ name: "test-service" }, ctx);

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.name).toBe("test-service");

      // Verify it's removed from KV
      const managed = ctx.db.getKV("services.managed");
      expect(managed).toBe('[]');

      // Verify pm2 jlist was called before delete
      expect(mockExec).toHaveBeenCalledWith("pm2", ["jlist"], expect.any(Object));
      expect(mockExec).toHaveBeenCalledWith("pm2", ["delete", "test-service"]);
      expect(mockExec).toHaveBeenCalledWith("pm2", ["save"]);
    });
  });

  describe("list_services", () => {
    let tool: AutomatonTool;

    beforeEach(() => {
      tool = getListServicesTool();
    });

    it("should mark managed services correctly", async () => {
      const ctx = createMockContext();
      const home = process.env.HOME ?? "/root";
      const scriptPath = `${home}/.automaton/services/test.js`;

      // Set up managed service
      ctx.db.setKV(
        "services.managed",
        JSON.stringify([
          {
            name: "my-service",
            scriptPath,
            port: 3010,
            startedAt: new Date().toISOString(),
          },
        ])
      );

      mockExec.mockReturnValueOnce(
        JSON.stringify([
          {
            name: "my-service",
            pid: 54321,
            pm_id: 0,
            pm2_env: { status: "online", pm_uptime: 5000 },
          },
          {
            name: "other-service",
            pid: 54322,
            pm_id: 1,
            pm2_env: { status: "online", pm_uptime: 3000 },
          },
        ]) as any
      );

      const result = await tool.execute({}, ctx);

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.services).toHaveLength(2);

      const myService = parsed.services.find((s: any) => s.name === "my-service");
      expect(myService.managed).toBe(true);
      expect(myService.stoppable).toBe(true);

      const otherService = parsed.services.find((s: any) => s.name === "other-service");
      expect(otherService.managed).toBe(false);
      expect(otherService.stoppable).toBe(false);
    });

    it("should handle corrupted KV gracefully", async () => {
      const ctx = createMockContext();
      // Set corrupted KV data
      ctx.db.setKV("services.managed", "not json");

      mockExec.mockReturnValueOnce(
        JSON.stringify([
          {
            name: "service1",
            pid: 54321,
            pm_id: 0,
            pm2_env: { status: "online" },
          },
        ]) as any
      );

      const result = await tool.execute({}, ctx);

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      // Should treat corrupted KV as empty, so no managed services
      expect(parsed.services).toHaveLength(1);
      expect(parsed.services[0].managed).toBe(false);
    });

    it("should handle bad pm2 jlist output gracefully", async () => {
      const ctx = createMockContext();

      mockExec.mockReturnValueOnce("not json" as any);

      const result = await tool.execute({}, ctx);

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      // parsePm2List catches JSON.parse errors and returns empty array
      expect(parsed.services).toHaveLength(0);
    });
  });
});
