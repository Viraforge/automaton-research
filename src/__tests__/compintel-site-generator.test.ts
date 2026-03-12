import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateCompintelSite } from "../publication/generate-compintel-site.js";
import { upsertProductRecord } from "../publication/products-registry.js";

describe("generateCompintelSite", () => {
  let tempDirPath: string;
  let registryPath: string;
  let siteRoot: string;
  let previousRegistryPath: string | undefined;
  let previousSiteRoot: string | undefined;

  beforeEach(async () => {
    tempDirPath = await mkdtemp(join(tmpdir(), "compintel-site-"));
    registryPath = join(tempDirPath, "products.json");
    siteRoot = join(tempDirPath, "site");
    await writeFile(registryPath, '{"products":[]}\n', "utf8");

    previousRegistryPath = process.env.PRODUCTS_REGISTRY_PATH;
    previousSiteRoot = process.env.COMPINTEL_SITE_ROOT;
    process.env.PRODUCTS_REGISTRY_PATH = registryPath;
    process.env.COMPINTEL_SITE_ROOT = siteRoot;
  });

  afterEach(async () => {
    if (previousRegistryPath === undefined) delete process.env.PRODUCTS_REGISTRY_PATH;
    else process.env.PRODUCTS_REGISTRY_PATH = previousRegistryPath;
    if (previousSiteRoot === undefined) delete process.env.COMPINTEL_SITE_ROOT;
    else process.env.COMPINTEL_SITE_ROOT = previousSiteRoot;

    await rm(tempDirPath, { recursive: true, force: true });
  });

  it("renders published and draft sections from products registry", async () => {
    await upsertProductRecord({
      id: "alpha",
      name: "Alpha API",
      slug: "alpha",
      summary: "Alpha summary",
      category: "api",
      status: "published",
      publicUrl: "https://alpha.compintel.co",
      healthcheckPath: "/health",
      internalPort: 3000,
    });
    await upsertProductRecord({
      id: "beta",
      name: "Beta Draft",
      slug: "beta",
      summary: "Beta summary",
      category: "automation",
      status: "draft",
      internalPort: 4100,
    });

    const result = await generateCompintelSite();
    const html = await readFile(result.indexPath, "utf8");

    expect(result.productCount).toBe(2);
    expect(html).toContain("Compintel Product Catalog");
    expect(html).toContain("Published");
    expect(html).toContain("Draft");
    expect(html).toContain("Alpha API");
    expect(html).toContain("Beta Draft");
    expect(html).toContain("https://alpha.compintel.co");
  });

  it("renders empty placeholders when no products exist", async () => {
    const result = await generateCompintelSite();
    const html = await readFile(result.indexPath, "utf8");

    expect(result.productCount).toBe(0);
    expect(html).toContain("No products yet.");
  });
});
