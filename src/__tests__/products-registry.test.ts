import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  promoteProductToPublished,
  readProductsRegistry,
  upsertProductRecord,
} from "../publication/products-registry.js";

describe("products registry", () => {
  let registryDirPath: string;
  let registryPath: string;
  let previousRegistryPath: string | undefined;

  beforeEach(async () => {
    registryDirPath = await mkdtemp(join(tmpdir(), "products-registry-"));
    registryPath = join(registryDirPath, "products.json");
    await writeFile(registryPath, '{"products":[]}\n', "utf8");
    previousRegistryPath = process.env.PRODUCTS_REGISTRY_PATH;
    process.env.PRODUCTS_REGISTRY_PATH = registryPath;
  });

  afterEach(async () => {
    if (previousRegistryPath === undefined) delete process.env.PRODUCTS_REGISTRY_PATH;
    else process.env.PRODUCTS_REGISTRY_PATH = previousRegistryPath;
    await rm(registryDirPath, { recursive: true, force: true });
  });

  it("upserts and sorts draft products by slug", async () => {
    await upsertProductRecord({
      id: "zeta",
      name: "Zeta",
      slug: "zeta",
      summary: "Zeta summary",
      category: "api",
      status: "draft",
      internalPort: 8080,
    });
    await upsertProductRecord({
      id: "alpha",
      name: "Alpha",
      slug: "alpha",
      summary: "Alpha summary",
      category: "automation",
      status: "draft",
      internalPort: 3000,
    });

    const registry = await readProductsRegistry();
    expect(registry.products).toHaveLength(2);
    expect(registry.products.map((product) => product.slug)).toEqual(["alpha", "zeta"]);
    expect(registry.products[0]?.status).toBe("draft");
  });

  it("promotes existing draft product to published", async () => {
    await upsertProductRecord({
      id: "alpha",
      name: "Alpha",
      slug: "alpha",
      summary: "Alpha summary",
      category: "automation",
      status: "draft",
      internalPort: 3000,
    });

    const promoted = await promoteProductToPublished({
      slug: "alpha",
      publicUrl: "https://alpha.compintel.co",
      healthcheckPath: "/health",
      internalPort: 3000,
    });

    const registryContent = await readFile(registryPath, "utf8");
    const parsed = JSON.parse(registryContent) as { products: Array<{ slug: string; status: string; publicUrl: string }> };
    expect(promoted.status).toBe("published");
    expect(promoted.publicUrl).toBe("https://alpha.compintel.co");
    expect(parsed.products).toHaveLength(1);
    expect(parsed.products[0]).toMatchObject({
      slug: "alpha",
      status: "published",
      publicUrl: "https://alpha.compintel.co",
    });
  });
});
