import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDb, createTestConfig } from "./mocks.js";
import { ensureCoreDistributionChannels } from "../distribution/channels.js";
import { loadOperatorTargets } from "../distribution/targets.js";

describe("operator target loader", () => {
  const files: string[] = [];
  afterEach(() => {
    for (const f of files) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
  });

  it("handles missing file safely", () => {
    const db = createTestDb();
    ensureCoreDistributionChannels(db.raw, createTestConfig());
    const result = loadOperatorTargets(db.raw, {
      ...createTestConfig(),
      distribution: { operatorTargetsPath: "/tmp/does-not-exist.json" },
    } as any);
    expect(result.warning).toContain("not found");
    db.close();
  });

  it("handles malformed JSON safely", () => {
    const badFile = path.join(os.tmpdir(), `targets-bad-${Date.now()}.json`);
    files.push(badFile);
    fs.writeFileSync(badFile, "{ bad json", "utf-8");
    const db = createTestDb();
    ensureCoreDistributionChannels(db.raw, createTestConfig());
    const result = loadOperatorTargets(db.raw, {
      ...createTestConfig(),
      distribution: { operatorTargetsPath: badFile },
    } as any);
    expect(result.warning).toContain("invalid JSON");
    db.close();
  });

  it("loads valid targets and persists them", () => {
    const file = path.join(os.tmpdir(), `targets-good-${Date.now()}.json`);
    files.push(file);
    fs.writeFileSync(file, JSON.stringify([
      {
        project_id: "legacy-import",
        channel_id: "social_relay",
        target_key: "clawnews",
        target_label: "ClawNews",
        priority: 100,
      },
    ]), "utf-8");
    const db = createTestDb();
    ensureCoreDistributionChannels(db.raw, createTestConfig());
    const result = loadOperatorTargets(db.raw, {
      ...createTestConfig(),
      distribution: { operatorTargetsPath: file },
    } as any);
    expect(result.inserted).toBe(1);
    const count = db.raw.prepare("SELECT COUNT(*) AS c FROM distribution_targets").get() as { c: number };
    expect(count.c).toBe(1);
    db.close();
  });
});
