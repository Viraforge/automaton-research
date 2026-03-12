import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ProductStatus = "draft" | "published";

export type ProductRecord = {
  id: string;
  name: string;
  slug: string;
  summary: string;
  category: string;
  status: ProductStatus;
  internalPort?: number;
  serviceName?: string;
  entryPoint?: string;
  publicUrl?: string;
  healthcheckPath?: string;
  publishedAt?: string;
  updatedAt?: string;
  createdAt?: string;
  tags?: string[];
};

export type ProductsRegistry = {
  products: ProductRecord[];
};

const defaultRegistryContent = {
  products: [],
} satisfies ProductsRegistry;

const defaultProductsRegistryPath = fileURLToPath(new URL("../../docs/products.json", import.meta.url));
const registryWriteQueues = new Map<string, Promise<void>>();
const LOCK_RETRY_DELAY_MS = 10;
const STALE_LOCK_AGE_MS = 1_000;

const resolveRegistryPath = (registryPath?: string) => {
  if (registryPath?.trim()) return registryPath.trim();

  const overriddenRegistryPath = process.env.PRODUCTS_REGISTRY_PATH?.trim();
  if (overriddenRegistryPath) return overriddenRegistryPath;

  return defaultProductsRegistryPath;
};

const assertRequiredString = (value: string, fieldName: string) => {
  if (value.trim()) return;
  throw new Error(`Product record requires ${fieldName}.`);
};

const ensureProductRecord = (record: ProductRecord) => {
  assertRequiredString(record.id, "id");
  assertRequiredString(record.name, "name");
  assertRequiredString(record.slug, "slug");
  assertRequiredString(record.summary, "summary");
  assertRequiredString(record.category, "category");
  assertRequiredString(record.status, "status");
};

const normalizeStableKey = (record: Pick<ProductRecord, "slug" | "id">) => {
  const normalizedSlug = record.slug.trim().toLowerCase();
  if (normalizedSlug) return normalizedSlug;
  const normalizedId = record.id.trim().toLowerCase();
  if (normalizedId) return normalizedId;
  throw new Error("Product record requires a slug or id.");
};

const sortProducts = (products: ProductRecord[]) =>
  [...products].sort((left, right) => normalizeStableKey(left).localeCompare(normalizeStableKey(right)));

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
    if (registryWriteQueues.get(registryPath) === queuedWrite) registryWriteQueues.delete(registryPath);
  }
};

const sleep = async (delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs));

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const isMissingProcess = error instanceof Error && "code" in error && error.code === "ESRCH";
    return !isMissingProcess;
  }
};

const clearStaleRegistryLock = async (lockPath: string) => {
  try {
    const lockStats = await stat(lockPath);
    if (Date.now() - lockStats.mtimeMs < STALE_LOCK_AGE_MS) return false;

    const lockContent = await readFile(lockPath, "utf8");
    const parsedLock = JSON.parse(lockContent) as { pid?: number };
    if (typeof parsedLock.pid === "number" && isProcessAlive(parsedLock.pid)) return false;

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
      const isNestedMissingFile = nestedError instanceof Error
        && "code" in nestedError
        && nestedError.code === "ENOENT";
      if (isNestedMissingFile) return true;
      return false;
    }
  }
};

const acquireRegistryLock = async (registryPath: string) => {
  const lockPath = `${registryPath}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));

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

export const getDefaultProductsRegistryPath = () => defaultProductsRegistryPath;

export const readProductsRegistry = async (
  registryPath?: string,
): Promise<ProductsRegistry> => {
  const resolvedRegistryPath = resolveRegistryPath(registryPath);
  await ensureRegistryFile(resolvedRegistryPath);

  const registryContent = await readFile(resolvedRegistryPath, "utf8");
  const parsedRegistry = JSON.parse(registryContent) as Partial<ProductsRegistry>;
  if (!Array.isArray(parsedRegistry.products)) {
    throw new Error("Products registry must contain a products array.");
  }

  return {
    products: sortProducts(parsedRegistry.products as ProductRecord[]),
  };
};

export const upsertProductRecord = async (
  record: ProductRecord,
  registryPath?: string,
): Promise<ProductRecord> => {
  ensureProductRecord(record);
  const resolvedRegistryPath = resolveRegistryPath(registryPath);

  return withSerializedRegistryPath(resolvedRegistryPath, async () => {
    const now = new Date().toISOString();
    const registry = await readProductsRegistry(resolvedRegistryPath);
    const stableKey = normalizeStableKey(record);
    const existingRecord = registry.products.find((product) => normalizeStableKey(product) === stableKey);

    const mergedRecord: ProductRecord = existingRecord
      ? {
          ...existingRecord,
          ...record,
          createdAt: existingRecord.createdAt ?? now,
          publishedAt: record.status === "published"
            ? existingRecord.publishedAt ?? record.publishedAt ?? now
            : undefined,
        }
      : {
          ...record,
          createdAt: record.createdAt ?? now,
          publishedAt: record.status === "published" ? record.publishedAt ?? now : undefined,
        };

    const existingComparable = existingRecord
      ? JSON.stringify({ ...existingRecord, updatedAt: undefined })
      : undefined;
    const nextComparable = JSON.stringify({ ...mergedRecord, updatedAt: undefined });
    const isUnchanged = existingComparable === nextComparable;
    const nextRecord: ProductRecord = {
      ...mergedRecord,
      updatedAt: existingRecord && isUnchanged
        ? existingRecord.updatedAt ?? now
        : record.updatedAt ?? now,
    };

    const nextProducts = registry.products.filter((product) => normalizeStableKey(product) !== stableKey);
    nextProducts.push(nextRecord);

    await writeRegistryFileAtomically(
      resolvedRegistryPath,
      `${JSON.stringify({ products: sortProducts(nextProducts) }, null, 2)}\n`,
    );
    return nextRecord;
  });
};

export const promoteProductToPublished = async (
  params: {
    slug: string;
    publicUrl: string;
    healthcheckPath: string;
    internalPort: number;
    name?: string;
    summary?: string;
    category?: string;
    serviceName?: string;
  },
  registryPath?: string,
): Promise<ProductRecord> => {
  const normalizedSlug = params.slug.trim().toLowerCase();
  if (!normalizedSlug) throw new Error("Product promotion requires slug.");
  if (!params.publicUrl.trim()) throw new Error("Product promotion requires publicUrl.");

  const resolvedRegistryPath = resolveRegistryPath(registryPath);
  const registry = await readProductsRegistry(resolvedRegistryPath);
  const existing = registry.products.find((product) => product.slug.trim().toLowerCase() === normalizedSlug);

  const name = params.name?.trim() || existing?.name || normalizedSlug;
  const summary = params.summary?.trim() || existing?.summary || `Published service at ${params.publicUrl}`;
  const category = params.category?.trim() || existing?.category || "general";

  return upsertProductRecord(
    {
      id: existing?.id || normalizedSlug,
      name,
      slug: normalizedSlug,
      summary,
      category,
      status: "published",
      publicUrl: params.publicUrl,
      healthcheckPath: params.healthcheckPath,
      internalPort: params.internalPort,
      serviceName: params.serviceName || existing?.serviceName,
      entryPoint: existing?.entryPoint,
      tags: existing?.tags,
      createdAt: existing?.createdAt,
      publishedAt: existing?.publishedAt,
      updatedAt: existing?.updatedAt,
    },
    resolvedRegistryPath,
  );
};
