import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readProductsRegistry, type ProductRecord } from "./products-registry.js";

const defaultSiteRoot = resolve(process.cwd(), "docs", "compintel-site");

const resolveSiteRoot = (siteRoot?: string) => {
  if (siteRoot?.trim()) return siteRoot.trim();

  const envSiteRoot = process.env.COMPINTEL_SITE_ROOT?.trim();
  if (envSiteRoot) return envSiteRoot;

  return defaultSiteRoot;
};

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const formatProductMeta = (product: ProductRecord) => {
  const meta: string[] = [];
  meta.push(`Category: ${product.category}`);
  if (product.internalPort) meta.push(`Port: ${product.internalPort}`);
  if (product.serviceName) meta.push(`Service: ${product.serviceName}`);
  if (product.healthcheckPath) meta.push(`Health: ${product.healthcheckPath}`);
  if (product.status === "published" && product.publicUrl) meta.push(`URL: ${product.publicUrl}`);
  return meta;
};

const renderProductCard = (product: ProductRecord) => {
  const meta = formatProductMeta(product)
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join("");
  const urlMarkup = product.publicUrl
    ? `<p><a href="${escapeHtml(product.publicUrl)}" target="_blank" rel="noopener noreferrer">Open product</a></p>`
    : "<p>Not publicly published yet.</p>";

  return [
    "<article>",
    `<h3>${escapeHtml(product.name)}</h3>`,
    `<p>${escapeHtml(product.summary)}</p>`,
    `<p><code>${escapeHtml(product.slug)}</code></p>`,
    urlMarkup,
    `<ul>${meta}</ul>`,
    "</article>",
  ].join("");
};

const renderSection = (title: string, products: ProductRecord[]) => {
  if (products.length === 0) {
    return `<section><h2>${escapeHtml(title)}</h2><p>No products yet.</p></section>`;
  }

  const cards = products.map(renderProductCard).join("\n");
  return `<section><h2>${escapeHtml(title)}</h2>${cards}</section>`;
};

const sortBySlug = (products: ProductRecord[]) =>
  [...products].sort((left, right) => left.slug.localeCompare(right.slug));

const buildIndexHtml = (products: ProductRecord[]) => {
  const published = sortBySlug(products.filter((product) => product.status === "published"));
  const draft = sortBySlug(products.filter((product) => product.status === "draft"));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Compintel Catalog</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 40px; line-height: 1.5; }
    main { max-width: 960px; margin: 0 auto; }
    section { margin-bottom: 36px; }
    article { border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin: 12px 0; }
    h1, h2, h3 { margin: 0 0 12px; }
    ul { margin: 10px 0 0; padding-left: 20px; }
    code { background: #f4f4f4; padding: 2px 5px; border-radius: 4px; }
  </style>
</head>
<body>
  <main>
    <h1>Compintel Product Catalog</h1>
    <p>Auto-generated from Connie's product registry.</p>
    ${renderSection("Published", published)}
    ${renderSection("Draft", draft)}
  </main>
</body>
</html>
`;
};

export const getDefaultCompintelSiteRoot = () => defaultSiteRoot;

export const generateCompintelSite = async (
  options?: {
    registryPath?: string;
    siteRoot?: string;
  },
): Promise<{ indexPath: string; siteRoot: string; productCount: number }> => {
  const siteRoot = resolveSiteRoot(options?.siteRoot);
  const indexPath = `${siteRoot}/index.html`;
  const registry = await readProductsRegistry(options?.registryPath);

  const html = buildIndexHtml(registry.products);
  await mkdir(dirname(indexPath), { recursive: true });
  await writeFile(indexPath, html, "utf8");

  return {
    indexPath,
    siteRoot,
    productCount: registry.products.length,
  };
};
