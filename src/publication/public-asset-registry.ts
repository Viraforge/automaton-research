import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type PublicAssetStatus = "published";

export type PublicAssetRecord = {
  id: string;
  title: string;
  url: string;
  subdomain: string;
  status: PublicAssetStatus;
  description?: string;
  category?: string;
  healthcheckPath?: string;
  port?: number;
  projectId?: string;
  publishedAt?: string;
  updatedAt?: string;
  tags?: string[];
};

export type PublicAssetRegistry = {
  assets: PublicAssetRecord[];
};

const defaultRegistryContent = {
  assets: [],
} satisfies PublicAssetRegistry;

const defaultRegistryPath = fileURLToPath(new URL("../../docs/public-assets.json", import.meta.url));
const registryWriteQueues = new Map<string, Promise<void>>();
const LOCK_RETRY_DELAY_MS = 10;
const STALE_LOCK_AGE_MS = 1_000;

const resolveRegistryPath = (registryPath?: string) => {
  if (registryPath) return registryPath;

  const overriddenRegistryPath = process.env.PUBLIC_ASSET_REGISTRY_PATH?.trim();
  if (overriddenRegistryPath) return overriddenRegistryPath;

  return defaultRegistryPath;
};

const normalizeStableKey = (record: Pick<PublicAssetRecord, "id" | "subdomain">) => {
  const normalizedSubdomain = record.subdomain.trim().toLowerCase();
  if (normalizedSubdomain) return normalizedSubdomain;

  const normalizedId = record.id.trim().toLowerCase();
  if (normalizedId) return normalizedId;

  throw new Error("Public asset record requires an id or subdomain.");
};

const assertRequiredString = (value: string, fieldName: string) => {
  if (value.trim()) return;
  throw new Error(`Public asset record requires ${fieldName}.`);
};

const ensurePublicAssetRecord = (record: PublicAssetRecord) => {
  assertRequiredString(record.id, "id");
  assertRequiredString(record.title, "title");
  assertRequiredString(record.url, "url");
  assertRequiredString(record.subdomain, "subdomain");
  assertRequiredString(record.status, "status");
};

const sortAssets = (assets: PublicAssetRecord[]) =>
  [...assets].sort((left, right) => normalizeStableKey(left).localeCompare(normalizeStableKey(right)));

const withSerializedRegistryPath = async <T>(
  registryPath: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const previousWrite = registryWriteQueues.get(registryPath) ?? Promise.resolve();
  let releaseWrite: (() => void) | undefined;
  const currentWrite = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const queuedWrite = previousWrite.catch(() => undefined).then(() => currentWrite);
  registryWriteQueues.set(registryPath, queuedWrite);

  let releaseLock: (() => Promise<void>) | undefined;

  try {
    await previousWrite.catch(() => undefined);
    releaseLock = await acquireRegistryLock(registryPath);
    return await operation();
  } finally {
    await releaseLock?.();
    releaseWrite?.();
    if (registryWriteQueues.get(registryPath) === queuedWrite) {
      registryWriteQueues.delete(registryPath);
    }
  }
};

const sleep = async (delayMs: number) =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

const acquireRegistryLock = async (registryPath: string) => {
  const lockPath = `${registryPath}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }));

      return async () => {
        await handle.close();
        try {
          await unlink(lockPath);
        } catch (error) {
          const isMissingFile = error instanceof Error && "code" in error && error.code === "ENOENT";
          if (!isMissingFile) throw error;
        }
      };
    } catch (error) {
      const isLocked = error instanceof Error && "code" in error && error.code === "EEXIST";
      if (!isLocked) throw error;
      const removedStaleLock = await clearStaleRegistryLock(lockPath);
      if (removedStaleLock) continue;
      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }
};

const clearStaleRegistryLock = async (lockPath: string) => {
  try {
    const lockStats = await stat(lockPath);
    if (Date.now() - lockStats.mtimeMs < STALE_LOCK_AGE_MS) return false;

    const lockContent = await readFile(lockPath, "utf8");
    const parsedLock = JSON.parse(lockContent) as { pid?: number };
    if (typeof parsedLock.pid === "number" && isProcessAlive(parsedLock.pid)) {
      return false;
    }

    await unlink(lockPath);
    return true;
  } catch (error) {
    const isMissingFile = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (isMissingFile) return true;

    try {
      const lockStats = await stat(lockPath);
      if (Date.now() - lockStats.mtimeMs < STALE_LOCK_AGE_MS) return false;
      await unlink(lockPath);
      return true;
    } catch (nestedError) {
      const isNestedMissingFile = nestedError instanceof Error && "code" in nestedError && nestedError.code === "ENOENT";
      if (isNestedMissingFile) return true;
      return false;
    }
  }
};

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const isMissingProcess = error instanceof Error && "code" in error && error.code === "ESRCH";
    return !isMissingProcess;
  }
};

const writeRegistryFileAtomically = async (registryPath: string, content: string) => {
  await mkdir(dirname(registryPath), { recursive: true });

  const tempPath = join(
    dirname(registryPath),
    `.${basename(registryPath)}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.tmp`,
  );

  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, registryPath);
};

const ensureRegistryFile = async (registryPath: string) => {
  try {
    await readFile(registryPath, "utf8");
  } catch (error) {
    const isMissingFile = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (!isMissingFile) throw error;

    await writeRegistryFileAtomically(registryPath, `${JSON.stringify(defaultRegistryContent, null, 2)}\n`);
  }
};

export const getDefaultPublicAssetRegistryPath = () => defaultRegistryPath;

export const readPublicAssetRegistry = async (
  registryPath?: string,
): Promise<PublicAssetRegistry> => {
  const resolvedRegistryPath = resolveRegistryPath(registryPath);
  await ensureRegistryFile(resolvedRegistryPath);

  const registryContent = await readFile(resolvedRegistryPath, "utf8");
  const parsedRegistry = JSON.parse(registryContent) as Partial<PublicAssetRegistry>;
  if (!Array.isArray(parsedRegistry.assets)) {
    throw new Error("Public asset registry must contain an assets array.");
  }

  return {
    assets: sortAssets(parsedRegistry.assets as PublicAssetRecord[]),
  };
};

export const writePublicAssetRegistry = async (
  registry: PublicAssetRegistry,
  registryPath?: string,
): Promise<void> => {
  const resolvedRegistryPath = resolveRegistryPath(registryPath);
  const sortedRegistry = {
    assets: sortAssets(registry.assets),
  } satisfies PublicAssetRegistry;

  await withSerializedRegistryPath(
    resolvedRegistryPath,
    async () => writeRegistryFileAtomically(
      resolvedRegistryPath,
      `${JSON.stringify(sortedRegistry, null, 2)}\n`,
    ),
  );
};

export const upsertPublicAssetRecord = async (
  record: PublicAssetRecord,
  registryPath?: string,
): Promise<PublicAssetRecord> => {
  ensurePublicAssetRecord(record);

  const resolvedRegistryPath = resolveRegistryPath(registryPath);
  return withSerializedRegistryPath(resolvedRegistryPath, async () => {
    const now = new Date().toISOString();
    const registry = await readPublicAssetRegistry(resolvedRegistryPath);
    const stableKey = normalizeStableKey(record);
    const existingRecord = registry.assets.find((asset) => normalizeStableKey(asset) === stableKey);

    const mergedRecord: PublicAssetRecord = existingRecord
      ? {
          ...existingRecord,
          ...record,
          publishedAt: existingRecord.publishedAt ?? record.publishedAt ?? now,
        }
      : {
          ...record,
          publishedAt: record.publishedAt ?? now,
        };
    const existingComparable = existingRecord
      ? JSON.stringify({ ...existingRecord, updatedAt: undefined })
      : undefined;
    const nextComparable = JSON.stringify({ ...mergedRecord, updatedAt: undefined });
    const isUnchanged = existingComparable === nextComparable;
    const nextRecord: PublicAssetRecord = {
      ...mergedRecord,
      updatedAt: existingRecord && isUnchanged
        ? existingRecord.updatedAt ?? now
        : record.updatedAt ?? now,
    };

    const nextAssets = registry.assets.filter((asset) => normalizeStableKey(asset) !== stableKey);
    nextAssets.push(nextRecord);

    await writeRegistryFileAtomically(
      resolvedRegistryPath,
      `${JSON.stringify({ assets: sortAssets(nextAssets) }, null, 2)}\n`,
    );

    return nextRecord;
  });
};
