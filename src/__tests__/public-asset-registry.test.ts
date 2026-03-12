import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];
const loadPublicAssetRegistry = (cacheBust = "") => {
  if (cacheBust === "reader") return import("../publication/public-asset-registry.js?reader");
  if (cacheBust === "alpha") return import("../publication/public-asset-registry.js?alpha");
  if (cacheBust === "stale") return import("../publication/public-asset-registry.js?stale");
  if (cacheBust === "timeout") return import("../publication/public-asset-registry.js?timeout");
  if (cacheBust === "zeta") return import("../publication/public-asset-registry.js?zeta");
  return import("../publication/public-asset-registry.js");
};

const createTempRegistryPath = async () => {
  const dirPath = await mkdtemp(join(tmpdir(), "public-asset-registry-"));
  tempDirs.push(dirPath);
  return join(dirPath, "public-assets.json");
};

const sleep = (delayMs: number) =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

const readRegistryRecords = async (registryPath: string) => {
  const registryContent = await readFile(registryPath, "utf8");
  const registry = JSON.parse(registryContent) as {
    assets: Array<{ id: string; title: string; url: string; subdomain: string; status: string }>;
  };

  return registry.assets;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dirPath) => rm(dirPath, { recursive: true, force: true })));
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
});

describe("public asset registry", () => {
  it("upserts an asset by stable key", async () => {
    const { upsertPublicAssetRecord } = await loadPublicAssetRegistry();
    const registryPath = await createTempRegistryPath();

    await upsertPublicAssetRecord(
      {
        id: "polymarket-api",
        title: "Polymarket API",
        url: "https://polymarket.compintel.co",
        subdomain: "polymarket",
        status: "published",
      },
      registryPath,
    );
    const firstRegistryContent = await readFile(registryPath, "utf8");

    await upsertPublicAssetRecord(
      {
        id: "polymarket-api",
        title: "Polymarket API",
        url: "https://polymarket.compintel.co",
        subdomain: "polymarket",
        status: "published",
      },
      registryPath,
    );

    const records = await readRegistryRecords(registryPath);
    const secondRegistryContent = await readFile(registryPath, "utf8");

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "polymarket-api",
      title: "Polymarket API",
      url: "https://polymarket.compintel.co",
      subdomain: "polymarket",
      status: "published",
    });
    expect(secondRegistryContent).toBe(firstRegistryContent);
  });

  it("writes assets in stable-key order for clean diffs", async () => {
    const { upsertPublicAssetRecord } = await loadPublicAssetRegistry();
    const registryPath = await createTempRegistryPath();

    await upsertPublicAssetRecord(
      {
        id: "zeta-api",
        title: "Zeta API",
        url: "https://zeta.compintel.co",
        subdomain: "zeta",
        status: "published",
      },
      registryPath,
    );

    await upsertPublicAssetRecord(
      {
        id: "alpha-api",
        title: "Alpha API",
        url: "https://alpha.compintel.co",
        subdomain: "alpha",
        status: "published",
      },
      registryPath,
    );

    const records = await readRegistryRecords(registryPath);

    expect(records.map((record) => record.id)).toEqual(["alpha-api", "zeta-api"]);
  });

  it("upserts published assets by canonical subdomain even when ids differ", async () => {
    const { upsertPublicAssetRecord } = await loadPublicAssetRegistry();
    const registryPath = await createTempRegistryPath();

    await upsertPublicAssetRecord(
      {
        id: "legacy-alpha-service",
        title: "Legacy Alpha",
        url: "https://alpha.compintel.co",
        subdomain: "alpha",
        status: "published",
      },
      registryPath,
    );

    await upsertPublicAssetRecord(
      {
        id: "alpha",
        title: "Alpha API",
        url: "https://alpha.compintel.co",
        subdomain: "alpha",
        status: "published",
      },
      registryPath,
    );

    const records = await readRegistryRecords(registryPath);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "alpha",
      title: "Alpha API",
      subdomain: "alpha",
      url: "https://alpha.compintel.co",
      status: "published",
    });
  });

  it("preserves concurrent upserts to the same registry path", async () => {
    vi.resetModules();

    const registryPath = "/virtual/public-assets.json";
    const lockPath = `${registryPath}.lock`;
    const fileContents = new Map<string, string>([
      [registryPath, '{\n  "assets": []\n}\n'],
    ]);
    const openLockPaths = new Set<string>();
    let finalizationCount = 0;
    const finalizeRegistryWrite = (content: string) => {
      finalizationCount += 1;
      const delayMs = finalizationCount === 1 ? 50 : 10;

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          fileContents.set(registryPath, content);
          resolve();
        }, delayMs);
      });
    };

    vi.doMock("node:fs/promises", () => ({
      mkdir: vi.fn(async () => undefined),
      open: vi.fn(async (path: string, flags: string) => {
        if (flags !== "wx") throw new Error(`Unexpected open flags: ${flags}`);
        if (openLockPaths.has(path)) {
          const error = new Error(`EEXIST: file already exists, open '${path}'`) as Error & { code: string };
          error.code = "EEXIST";
          throw error;
        }

        openLockPaths.add(path);
        return {
          close: vi.fn(async () => undefined),
          writeFile: vi.fn(async (content: string) => {
            fileContents.set(path, content);
          }),
        };
      }),
      readFile: vi.fn(async (path: string) => {
        const content = fileContents.get(path);
        if (content !== undefined) return content;

        const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as Error & { code: string };
        error.code = "ENOENT";
        throw error;
      }),
      writeFile: vi.fn(async (path: string, content: string) => {
        if (path === registryPath) {
          await finalizeRegistryWrite(content);
          return;
        }

        fileContents.set(path, content);
      }),
      rename: vi.fn(async (fromPath: string, toPath: string) => {
        const content = fileContents.get(fromPath);
        if (content === undefined) {
          const error = new Error(`ENOENT: no such file or directory, rename '${fromPath}'`) as Error & { code: string };
          error.code = "ENOENT";
          throw error;
        }

        if (toPath === registryPath) {
          await finalizeRegistryWrite(content);
        } else {
          fileContents.set(toPath, content);
        }

        fileContents.delete(fromPath);
      }),
      unlink: vi.fn(async (path: string) => {
        openLockPaths.delete(path);
        fileContents.delete(path);
      }),
    }));

    const [{ readPublicAssetRegistry }, { upsertPublicAssetRecord: upsertAlpha }, { upsertPublicAssetRecord: upsertZeta }] =
      await Promise.all([
        loadPublicAssetRegistry("reader"),
        loadPublicAssetRegistry("alpha"),
        loadPublicAssetRegistry("zeta"),
      ]);

    await Promise.all([
      upsertAlpha(
        {
          id: "alpha-api",
          title: "Alpha API",
          url: "https://alpha.compintel.co",
          subdomain: "alpha",
          status: "published",
        },
        registryPath,
      ),
      upsertZeta(
        {
          id: "zeta-api",
          title: "Zeta API",
          url: "https://zeta.compintel.co",
          subdomain: "zeta",
          status: "published",
        },
        registryPath,
      ),
    ]);

    const registry = await readPublicAssetRegistry(registryPath);

    expect(registry.assets.map((record) => record.id)).toEqual(["alpha-api", "zeta-api"]);
    expect(openLockPaths.has(lockPath)).toBe(false);
  });

  it("clears stale lock files and recovers the upsert", async () => {
    vi.resetModules();
    const registryPath = "/virtual/stale-public-assets.json";
    const lockPath = `${registryPath}.lock`;
    const fileContents = new Map<string, string>([
      [registryPath, '{\n  "assets": []\n}\n'],
      [lockPath, JSON.stringify({ pid: 999999, createdAt: "2000-01-01T00:00:00.000Z" })],
    ]);
    let shouldRejectLock = true;

    vi.doMock("node:fs/promises", () => ({
      mkdir: vi.fn(async () => undefined),
      open: vi.fn(async (path: string, flags: string) => {
        if (flags !== "wx") throw new Error(`Unexpected open flags: ${flags}`);
        if (shouldRejectLock) {
          const error = new Error(`EEXIST: file already exists, open '${path}'`) as Error & { code: string };
          error.code = "EEXIST";
          throw error;
        }

        return {
          close: vi.fn(async () => undefined),
          writeFile: vi.fn(async (content: string) => {
            fileContents.set(path, content);
          }),
        };
      }),
      readFile: vi.fn(async (path: string) => {
        const content = fileContents.get(path);
        if (content !== undefined) return content;

        const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as Error & { code: string };
        error.code = "ENOENT";
        throw error;
      }),
      stat: vi.fn(async (path: string) => {
        if (!fileContents.has(path)) {
          const error = new Error(`ENOENT: no such file or directory, stat '${path}'`) as Error & { code: string };
          error.code = "ENOENT";
          throw error;
        }

        return { mtimeMs: Date.parse("2000-01-01T00:00:00.000Z") };
      }),
      rename: vi.fn(async (fromPath: string, toPath: string) => {
        const content = fileContents.get(fromPath);
        if (content === undefined) return;
        fileContents.set(toPath, content);
        fileContents.delete(fromPath);
      }),
      unlink: vi.fn(async (path: string) => {
        fileContents.delete(path);
        if (path === lockPath) shouldRejectLock = false;
      }),
      writeFile: vi.fn(async (path: string, content: string) => {
        fileContents.set(path, content);
      }),
    }));

    const { readPublicAssetRegistry, upsertPublicAssetRecord } = await loadPublicAssetRegistry("stale");

    await upsertPublicAssetRecord(
      {
        id: "alpha-api",
        title: "Alpha API",
        url: "https://alpha.compintel.co",
        subdomain: "alpha",
        status: "published",
      },
      registryPath,
    );

    const registry = await readPublicAssetRegistry(registryPath);
    expect(registry.assets.map((record) => record.id)).toEqual(["alpha-api"]);
    expect(fileContents.has(lockPath)).toBe(false);
  });

  it("recovers later upserts after a lock acquisition failure", async () => {
    vi.resetModules();
    const registryPath = "/virtual/recover-after-lock-failure.json";
    const lockPath = `${registryPath}.lock`;
    const fileContents = new Map<string, string>([
      [registryPath, '{\n  "assets": []\n}\n'],
    ]);
    let openAttemptCount = 0;

    vi.doMock("node:fs/promises", () => ({
      mkdir: vi.fn(async () => undefined),
      open: vi.fn(async (path: string, flags: string) => {
        if (flags !== "wx") throw new Error(`Unexpected open flags: ${flags}`);
        openAttemptCount += 1;

        if (openAttemptCount === 1) {
          const error = new Error(`EACCES: permission denied, open '${path}'`) as Error & { code: string };
          error.code = "EACCES";
          throw error;
        }

        return {
          close: vi.fn(async () => undefined),
          writeFile: vi.fn(async (content: string) => {
            fileContents.set(path, content);
          }),
        };
      }),
      readFile: vi.fn(async (path: string) => {
        const content = fileContents.get(path);
        if (content !== undefined) return content;

        const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as Error & { code: string };
        error.code = "ENOENT";
        throw error;
      }),
      rename: vi.fn(async (fromPath: string, toPath: string) => {
        const content = fileContents.get(fromPath);
        if (content === undefined) return;
        fileContents.set(toPath, content);
        fileContents.delete(fromPath);
      }),
      stat: vi.fn(async () => ({ mtimeMs: Date.now() })),
      unlink: vi.fn(async (path: string) => {
        fileContents.delete(path);
      }),
      writeFile: vi.fn(async (path: string, content: string) => {
        fileContents.set(path, content);
      }),
    }));

    const { readPublicAssetRegistry, upsertPublicAssetRecord } = await loadPublicAssetRegistry("poison");

    await expect(upsertPublicAssetRecord(
      {
        id: "alpha-api",
        title: "Alpha API",
        url: "https://alpha.compintel.co",
        subdomain: "alpha",
        status: "published",
      },
      registryPath,
    )).rejects.toThrow(/EACCES|permission denied/);

    const secondAttemptOutcome = await Promise.race([
      upsertPublicAssetRecord(
        {
          id: "beta-api",
          title: "Beta API",
          url: "https://beta.compintel.co",
          subdomain: "beta",
          status: "published",
        },
        registryPath,
      ).then(() => "resolved"),
      sleep(100).then(() => "timed-out"),
    ]);

    expect(secondAttemptOutcome).toBe("resolved");

    const registry = await readPublicAssetRegistry(registryPath);
    expect(registry.assets.map((record) => record.id)).toEqual(["beta-api"]);
    expect(fileContents.has(lockPath)).toBe(false);
  });
});
