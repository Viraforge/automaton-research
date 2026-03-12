# Compintel Asset Publication Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure Connie only treats `*.compintel.co` URLs as valid public distribution assets in sovereign mode and records successful publications in a repo-backed registry for the `compintel.co` UI.

**Architecture:** Tighten the publication gate in `expose_port` so temporary public URLs such as `*.trycloudflare.com` are treated as intermediate results instead of completion. Move durable public asset state into a repo-backed registry file written by publication helpers, then require public-proof validation to accept only approved `compintel.co` URLs.

**Tech Stack:**
- TypeScript
- Vitest
- Existing `publish_service` / `expose_port` tools in `src/agent/tools.ts`
- Repo-backed JSON artifact under `docs/`

---

## Task 1: Add publication URL classification helpers

**Files:**
- Modify: `src/agent/tools.ts`
- Test: `src/__tests__/publish-service.test.ts`

**Step 1: Write the failing test**

Add a test that proves `expose_port` does not accept a temporary Cloudflare tunnel URL as the final public result in sovereign mode.

```typescript
it("does not treat trycloudflare URLs as valid final publication targets", async () => {
  conway.exposePort = vi.fn(async (port: number) => ({
    port,
    publicUrl: "https://beautifully-epinions-featured-serious.trycloudflare.com",
    sandboxId: "test-sandbox-id",
  }));

  const exposeTool = createBuiltinTools("test-sandbox-id").find(
    (tool) => tool.name === "expose_port",
  );

  const result = await exposeTool!.execute({ port: 3000 }, ctx);

  expect(result).not.toContain("trycloudflare.com");
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -s vitest run src/__tests__/publish-service.test.ts -t "trycloudflare"`

Expected: FAIL because the current logic accepts the raw `publicUrl` too easily.

**Step 3: Write minimal implementation**

Add a small helper in `src/agent/tools.ts` that classifies publication URLs.

```typescript
function isApprovedPublishedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "compintel.co" || parsed.hostname.endsWith(".compintel.co");
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
```

Then change `expose_port` to branch on approval status, not just `http://localhost`.

**Step 4: Run test to verify it passes**

Run: `pnpm -s vitest run src/__tests__/publish-service.test.ts -t "trycloudflare"`

Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/tools.ts src/__tests__/publish-service.test.ts
git commit -m "fix: reject temporary publication URLs"
```

## Task 2: Promote unapproved public URLs to managed compintel publication

**Files:**
- Modify: `src/agent/tools.ts`
- Test: `src/__tests__/publish-service.test.ts`

**Step 1: Write the failing test**

Add a test that proves sovereign `expose_port` promotes a non-`compintel.co` public URL into a real `*.compintel.co` publication when Cloudflare publication is available.

```typescript
it("promotes non-compintel public URLs to compintel.co publication", async () => {
  conway.exposePort = vi.fn(async (port: number) => ({
    port,
    publicUrl: "https://beautifully-epinions-featured-serious.trycloudflare.com",
    sandboxId: "test-sandbox-id",
  }));

  const exposeTool = createBuiltinTools("test-sandbox-id").find(
    (tool) => tool.name === "expose_port",
  );

  const result = await exposeTool!.execute({ port: 3000 }, ctx);

  expect(result).toContain(".compintel.co");
  expect(result).not.toContain("trycloudflare.com");
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -s vitest run src/__tests__/publish-service.test.ts -t "promotes non-compintel"`

Expected: FAIL because the current logic only upgrades localhost-style results.

**Step 3: Write minimal implementation**

In `expose_port`, replace this gate:

```typescript
if (info.publicUrl.startsWith("http://localhost") && ...)
```

with logic closer to:

```typescript
const requiresManagedPublication =
  ctx.config.useSovereignProviders &&
  hasCloudflarePublishingCredentials(ctx.config) &&
  !isApprovedPublishedUrl(info.publicUrl);
```

Then:
- attempt managed publication when `requiresManagedPublication` is true
- on failure, return a blocker or a clear fallback message that does not claim temporary URLs are valid public asset URLs

**Step 4: Run test to verify it passes**

Run: `pnpm -s vitest run src/__tests__/publish-service.test.ts -t "promotes non-compintel"`

Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/tools.ts src/__tests__/publish-service.test.ts
git commit -m "fix: force sovereign assets onto compintel.co"
```

## Task 3: Add a repo-backed public asset registry

**Files:**
- Create: `src/publication/public-asset-registry.ts`
- Create: `src/__tests__/public-asset-registry.test.ts`
- Create: `docs/public-assets.json`
- Modify: `src/agent/tools.ts`

**Step 1: Write the failing test**

Create `src/__tests__/public-asset-registry.test.ts` to verify idempotent upsert behavior.

```typescript
import { describe, expect, it } from "vitest";
import { upsertPublicAssetRecord } from "../publication/public-asset-registry.js";

describe("public asset registry", () => {
  it("upserts an asset by stable key", async () => {
    await upsertPublicAssetRecord({
      id: "polymarket-api",
      title: "Polymarket API",
      url: "https://polymarket.compintel.co",
      subdomain: "polymarket",
      status: "published",
    });

    await upsertPublicAssetRecord({
      id: "polymarket-api",
      title: "Polymarket API",
      url: "https://polymarket.compintel.co",
      subdomain: "polymarket",
      status: "published",
    });

    const records = readRegistryForTest();
    expect(records).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -s vitest run src/__tests__/public-asset-registry.test.ts`

Expected: FAIL because the helper does not exist yet.

**Step 3: Write minimal implementation**

Create `src/publication/public-asset-registry.ts` with:
- a record type
- file read/write helpers
- stable-key upsert
- sorted output for clean diffs

Use `docs/public-assets.json` as the default registry file and initialize it with:

```json
{
  "assets": []
}
```

Update `publish_service` to write/update a record after successful publication.

**Step 4: Run test to verify it passes**

Run: `pnpm -s vitest run src/__tests__/public-asset-registry.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/publication/public-asset-registry.ts src/__tests__/public-asset-registry.test.ts docs/public-assets.json src/agent/tools.ts
git commit -m "feat: add public asset registry for compintel UI"
```

## Task 4: Tighten public-proof validation to approved compintel URLs

**Files:**
- Modify: `src/agent/tools.ts`
- Test: `src/__tests__/loop.test.ts`

**Step 1: Write the failing test**

Add a regression showing that temporary public URLs do not count as valid public completion evidence.

```typescript
it("rejects temporary tunnel URLs as public completion evidence", async () => {
  const completionCall = await completeTaskWithArtifacts([
    "https://beautifully-epinions-featured-serious.trycloudflare.com/health",
  ]);

  expect(completionCall.result).toContain("requires public completion evidence");
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -s vitest run src/__tests__/loop.test.ts -t "temporary tunnel URLs"`

Expected: FAIL because current validation checks for `https://` and route shape, not approved domain.

**Step 3: Write minimal implementation**

Tighten `hasPublicRevenueCompletionEvidence()` in `src/agent/tools.ts` so it requires:
- `https://`
- approved `compintel.co` host
- expected route shape

Example direction:

```typescript
const approvedPublicHost = /https:\/\/([a-z0-9-]+\.)*compintel\.co\b/i.test(combined);
return approvedPublicHost && hasBusinessRoute;
```

**Step 4: Run test to verify it passes**

Run: `pnpm -s vitest run src/__tests__/loop.test.ts -t "temporary tunnel URLs"`

Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/tools.ts src/__tests__/loop.test.ts
git commit -m "fix: require compintel URLs for public proof"
```

## Task 5: Full verification

**Files:**
- Verify: `src/agent/tools.ts`
- Verify: `src/publication/public-asset-registry.ts`
- Verify: `src/__tests__/publish-service.test.ts`
- Verify: `src/__tests__/public-asset-registry.test.ts`
- Verify: `src/__tests__/loop.test.ts`
- Verify: `docs/public-assets.json`

**Step 1: Run focused publication tests**

Run: `pnpm -s vitest run src/__tests__/publish-service.test.ts src/__tests__/public-asset-registry.test.ts`

Expected: PASS

**Step 2: Run focused loop/public-proof regressions**

Run: `pnpm -s vitest run src/__tests__/loop.test.ts -t "Cloudflare|public completion|temporary tunnel|compintel"`

Expected: PASS

**Step 3: Run lint/type/build verification**

Run: `pnpm run typecheck && pnpm run build`

Expected: PASS

**Step 4: Sanity-check registry output**

Run: `python3 -m json.tool docs/public-assets.json >/dev/null`

Expected: exit 0

**Step 5: Commit**

```bash
git add src/agent/tools.ts src/publication/public-asset-registry.ts src/__tests__/publish-service.test.ts src/__tests__/public-asset-registry.test.ts src/__tests__/loop.test.ts docs/public-assets.json
git commit -m "feat: publish compintel assets to registry-backed catalog"
```
