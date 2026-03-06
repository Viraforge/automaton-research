import { describe, expect, it } from "vitest";
import { evaluateProgress } from "../../governance/progress.js";

describe("progress governance", () => {
  it("marks task state changes as progress", () => {
    const result = evaluateProgress({
      toolCalls: [],
      taskDelta: { completed: 1 },
    });
    expect(result.progressed).toBe(true);
  });

  it("treats discovery-only turns as non-progress", () => {
    const result = evaluateProgress({
      toolCalls: [
        {
          id: "1",
          name: "discover_agents",
          arguments: {},
          result: "No agents found",
          durationMs: 10,
        },
      ],
    });
    expect(result.progressed).toBe(false);
  });

  it("counts record_project_metric as progress", () => {
    const result = evaluateProgress({
      toolCalls: [
        {
          id: "1",
          name: "record_project_metric",
          arguments: {},
          result: "ok",
          durationMs: 10,
        },
      ],
    });
    expect(result.progressed).toBe(true);
  });
});
