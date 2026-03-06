import type { ToolCallResult } from "../types.js";

export interface ProgressEvaluationInput {
  toolCalls: ToolCallResult[];
  message?: string;
  taskDelta?: {
    completed?: number;
    failed?: number;
    assigned?: number;
  };
  metricRecorded?: boolean;
}

export interface ProgressEvaluation {
  progressed: boolean;
  reason: string;
}

const NON_PROGRESS_TOOLS = new Set([
  "list_goals",
  "orchestrator_status",
  "list_children",
  "discover_agents",
  "check_credits",
  "check_usdc_balance",
  "status_report",
]);

const PROGRESS_TOOLS = new Set([
  "create_project",
  "create_goal",
  "complete_task",
  "fail_task",
  "record_project_metric",
  "add_distribution_target",
  "send_message",
  "register_erc8004",
  "update_agent_card",
  "expose_port",
  "x402_fetch",
]);

export function evaluateProgress(input: ProgressEvaluationInput): ProgressEvaluation {
  const completed = input.taskDelta?.completed ?? 0;
  const failed = input.taskDelta?.failed ?? 0;
  if (completed > 0 || failed > 0) {
    return { progressed: true, reason: "task state changed" };
  }

  if (input.metricRecorded) {
    return { progressed: true, reason: "project metric recorded" };
  }

  for (const call of input.toolCalls) {
    if (PROGRESS_TOOLS.has(call.name) && !call.error) {
      return { progressed: true, reason: `productive tool: ${call.name}` };
    }
  }

  if (input.toolCalls.length > 0 && input.toolCalls.every((tc) => NON_PROGRESS_TOOLS.has(tc.name) || !!tc.error)) {
    return { progressed: false, reason: "status or discovery only" };
  }

  if (/I will|Let me/i.test(input.message ?? "")) {
    return { progressed: false, reason: "intent statement without verified outcome" };
  }

  return { progressed: false, reason: "no verified progress signal" };
}

