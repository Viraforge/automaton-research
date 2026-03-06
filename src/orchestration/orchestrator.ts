import type { Database } from "better-sqlite3";
import { ulid } from "ulid";
import type { AutomatonIdentity } from "../types.js";
import { createLogger } from "../observability/logger.js";
import {
  assignTask,
  completeTask,
  decomposeGoal,
  failTask,
  getGoalProgress,
  getReadyTasks,
  invalidateGhostGoal,
  type Goal,
  type DecomposeTaskInput,
  type TaskNode,
  type TaskResult,
  normalizeTaskResult,
} from "./task-graph.js";
import {
  planGoal,
  replanAfterFailure,
  type PlannerContext,
  type PlannerOutput,
  type PlannedTask,
} from "./planner.js";
import { ColonyMessaging, type AgentMessage } from "./messaging.js";
import { generateTodoMd } from "./attention.js";
import { UnifiedInferenceClient } from "../inference/inference-client.js";
import { reviewPlan } from "./plan-mode.js";
import { isChildRecent } from "./time.js";
import {
  getActiveGoals,
  getGoalById,
  getProjectById,
  getTaskById,
  getTasksByGoal,
  updateGoalStatus,
  type GoalRow,
  type ProjectLane,
  type TaskGraphRow,
} from "../state/database.js";
import type {
  AgentAssignment,
  AgentTracker,
  FundingProtocol,
  OrchestratorTickResult,
} from "./types.js";

const logger = createLogger("orchestration.orchestrator");

const ORCHESTRATOR_STATE_KEY = "orchestrator.state";
const ORCHESTRATOR_TODO_KEY = "orchestrator.todo_md";
const ORCHESTRATOR_DEAD_WORKERS_KEY = "orchestrator.dead_workers";
const ORCHESTRATOR_EXEC_STALL_KEY = "orchestrator.executing_stall";
const ORCHESTRATOR_PLANNER_RUNTIME_ISSUE_KEY = "orchestrator.planner_runtime_issue";
const ORCHESTRATOR_CHILD_FAILURES_KEY = "orchestrator.child_failures";
const DEFAULT_TASK_FUNDING_CENTS = 25;
const DEFAULT_MAX_REPLANS = 3;
const DEFAULT_ORCHESTRATOR_TASK_TIMEOUT_MS = 300_000;
const DEFAULT_WORKER_LIVENESS_TTL_MS = 30 * 60_000;
const DEFAULT_WORKER_QUARANTINE_TTL_MS = 30 * 60_000;
const EXECUTION_STALL_THRESHOLD_MS = 10 * 60_000;

type ExecutionPhase =
  | "idle"
  | "classifying"
  | "planning"
  | "plan_review"
  | "executing"
  | "replanning"
  | "complete"
  | "failed";

interface OrchestratorState {
  phase: ExecutionPhase;
  goalId: string | null;
  replanCount: number;
  failedTaskId: string | null;
  failedError: string | null;
}

interface TaskResultEnvelope {
  taskId: string;
  goalId: string | null;
  result: TaskResult;
  error?: string;
}

interface TickCounters {
  tasksAssigned: number;
  tasksCompleted: number;
  tasksFailed: number;
}

interface DeadWorkerRecord {
  address: string;
  fingerprint: string;
  taskId: string;
  reason: string;
  until: string;
  updatedAt: string;
}

interface ExecutionStallState {
  goalId: string;
  signature: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

const DEFAULT_STATE: OrchestratorState = {
  phase: "idle",
  goalId: null,
  replanCount: 0,
  failedTaskId: null,
  failedError: null,
};

export class Orchestrator {
  private pendingTaskResults: TaskResultEnvelope[] = [];

  constructor(private readonly params: {
    db: Database;
    agentTracker: AgentTracker;
    funding: FundingProtocol;
    messaging: ColonyMessaging;
    inference: UnifiedInferenceClient;
    identity: AutomatonIdentity;
    /** Check if a worker agent is still alive. Used to recover stale tasks. */
    isWorkerAlive?: (address: string) => boolean;
    config: any;
  }) {}

  async tick(): Promise<OrchestratorTickResult> {
    const counters: TickCounters = {
      tasksAssigned: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
    };

    let state = this.loadState();

    try {
      switch (state.phase) {
        case "idle": {
          state = this.handleIdlePhase(state);
          break;
        }

        case "classifying": {
          state = await this.handleClassifyingPhase(state);
          break;
        }

        case "planning": {
          state = await this.handlePlanningPhase(state);
          break;
        }

        case "plan_review": {
          state = await this.handlePlanReviewPhase(state);
          break;
        }

        case "executing": {
          state = await this.handleExecutingPhase(state, counters);
          break;
        }

        case "replanning": {
          state = await this.handleReplanningPhase(state);
          break;
        }

        case "complete": {
          state = await this.handleCompletePhase(state);
          break;
        }

        case "failed": {
          state = this.handleFailedPhase(state);
          break;
        }

        default: {
          state = { ...DEFAULT_STATE };
          break;
        }
      }
    } catch (error) {
      const err = normalizeError(error);
      logger.error("Orchestrator tick failed", err, {
        phase: state.phase,
        goalId: state.goalId,
      });

      if (state.goalId) {
        updateGoalStatus(this.params.db, state.goalId, "failed");
      }

      state = {
        ...state,
        phase: "failed",
        failedError: err.message,
      };
    }

    this.saveState(state);
    this.persistTodo();

    return {
      phase: state.phase,
      tasksAssigned: counters.tasksAssigned,
      tasksCompleted: counters.tasksCompleted,
      tasksFailed: counters.tasksFailed,
      goalsActive: getActiveGoals(this.params.db).length,
      agentsActive: this.getActiveAgentCount(),
    };
  }

  async matchTaskToAgent(task: TaskNode): Promise<AgentAssignment> {
    const requestedRole = task.agentRole?.trim() || "generalist";
    const isBlocked = (address: string) => this.isWorkerQuarantined(address);

    const idleAgents = this.params.agentTracker
      .getIdle()
      .filter((agent) => !isBlocked(agent.address));
    const directRoleMatch = idleAgents.find((agent) => agent.role === requestedRole);
    if (directRoleMatch) {
      return {
        agentAddress: directRoleMatch.address,
        agentName: directRoleMatch.name,
        spawned: false,
      };
    }

    const bestIdle = this.params.agentTracker.getBestForTask(requestedRole);
    if (bestIdle && !isBlocked(bestIdle.address)) {
      return {
        agentAddress: bestIdle.address,
        agentName: bestIdle.name,
        spawned: false,
      };
    }

    const spawned = await this.trySpawnAgent(task);
    if (spawned) {
      return spawned;
    }

    const reassigned = this.findBusyAgentForReassign();
    if (reassigned) {
      return {
        agentAddress: reassigned.address,
        agentName: reassigned.name,
        spawned: false,
      };
    }

    // Fallback: assign to the parent agent itself (self-execution mode).
    // This handles local dev environments where spawning child sandboxes
    // is not available, and ensures goals still make progress.
    if (this.params.identity?.address) {
      logger.warn("No child agents available, self-assigning task to parent", {
        taskId: task.id,
        role: requestedRole,
      });
      return {
        agentAddress: this.params.identity.address,
        agentName: this.params.identity.name ?? "parent",
        spawned: false,
      };
    }

    throw new Error(`No available agent for task ${task.id}`);
  }

  async fundAgentForTask(addr: string, task: TaskNode): Promise<void> {
    const estimated = Math.max(0, task.metadata.estimatedCostCents);
    const configuredDefault = Number(this.params.config?.defaultTaskFundingCents ?? DEFAULT_TASK_FUNDING_CENTS);
    const amountCents = Math.max(estimated, Number.isFinite(configuredDefault) ? configuredDefault : 0);

    if (amountCents <= 0) {
      return;
    }

    const result = await this.params.funding.fundChild(addr, amountCents);
    if (!result.success) {
      throw new Error(`Funding transfer failed for ${addr}`);
    }
  }

  async collectResults(): Promise<TaskResult[]> {
    this.pendingTaskResults = [];

    const processed = await this.params.messaging.processInbox();
    for (const entry of processed) {
      if (!entry.success || entry.message.type !== "task_result") {
        continue;
      }

      const parsed = parseTaskResultMessage(entry.message);
      if (!parsed) {
        continue;
      }

      this.pendingTaskResults.push(parsed);
    }

    return this.pendingTaskResults.map((entry) => entry.result);
  }

  async handleFailure(
    task: Pick<TaskNode, "id" | "goalId">,
    error: string,
    shouldRetry = true,
  ): Promise<void> {
    failTask(this.params.db, task.id, error, shouldRetry);

    const latest = getTaskById(this.params.db, task.id);
    if (!latest || latest.status !== "failed") {
      return;
    }

    const state = this.loadState();
    const maxReplans = this.getMaxReplans();

    if (state.replanCount < maxReplans) {
      updateGoalStatus(this.params.db, task.goalId, "active");
    }

    this.saveState({
      ...state,
      phase: state.replanCount < maxReplans ? "replanning" : "failed",
      goalId: task.goalId,
      failedTaskId: task.id,
      failedError: error,
    });
  }

  private handleIdlePhase(state: OrchestratorState): OrchestratorState {
    const activeGoals = getActiveGoals(this.params.db);
    if (activeGoals.length === 0) {
      return {
        ...state,
        phase: "idle",
        goalId: null,
      };
    }

    const goal = this.pickGoalByPortfolio(activeGoals, state.goalId);
    const goalTasks = getTasksByGoal(this.params.db, goal.id);
    // Fresh goals legitimately have 0 tasks before classifying/planning.
    // Ghost-goal invalidation is enforced after planning/fallback and during executing.
    if (goalTasks.length > 0 && invalidateGhostGoal(this.params.db, goal.id, "idle_phase_validation")) {
      return {
        ...state,
        phase: "idle",
        goalId: null,
      };
    }
    return {
      ...state,
      phase: "classifying",
      goalId: goal.id,
      failedTaskId: null,
      failedError: null,
    };
  }

  private async handleClassifyingPhase(state: OrchestratorState): Promise<OrchestratorState> {
    if (!state.goalId) {
      return {
        ...state,
        phase: "idle",
      };
    }

    const goal = getGoalById(this.params.db, state.goalId);
    if (!goal) {
      return {
        ...state,
        phase: "idle",
        goalId: null,
      };
    }

    const tasks = getTasksByGoal(this.params.db, goal.id);
    if (tasks.length > 0) {
      return {
        ...state,
        phase: "executing",
      };
    }

    const complexity = await this.classifyComplexity(goal);
    if (complexity.requiresPlanMode) {
      return {
        ...state,
        phase: "planning",
      };
    }

    decomposeGoal(this.params.db, goal.id, [
      {
        parentId: null,
        goalId: goal.id,
        title: goal.title,
        description: goal.description,
        status: "pending",
        assignedTo: null,
        agentRole: "generalist",
        priority: 50,
        dependencies: [],
        result: null,
        estimatedCostCents: 200,
        timeoutMs: this.getDefaultTaskTimeoutMs(),
      },
    ]);

    if (invalidateGhostGoal(this.params.db, goal.id, "classifying_fallback_validation")) {
      return {
        ...state,
        phase: "failed",
        failedError: "Goal invalidated: no executable tasks after fallback synthesis.",
      };
    }

    return {
      ...state,
      phase: "executing",
    };
  }

  private async handlePlanningPhase(state: OrchestratorState): Promise<OrchestratorState> {
    if (!state.goalId) {
      return {
        ...state,
        phase: "idle",
      };
    }

    const goal = getGoalById(this.params.db, state.goalId);
    if (!goal) {
      return {
        ...state,
        phase: "idle",
        goalId: null,
      };
    }

    let output: PlannerOutput;
    try {
      output = await planGoal(
        goalRowToGoal(goal),
        await this.buildPlannerContext(),
        this.params.inference,
      );
      this.clearPlannerRuntimeIssue();
    } catch (error) {
      const err = normalizeError(error);
      this.recordPlannerRuntimeIssue("planner", goal.id, err.message);
      logger.warn("Planner inference failed, falling back to single-task plan", {
        goalId: goal.id,
        error: err.message,
      });
      output = {
        analysis: `Planner fallback: ${err.message}`,
        strategy: "Execute goal as a single generalist task",
        customRoles: [],
        tasks: [{
          title: goal.title,
          description: goal.description,
          agentRole: "generalist",
          dependencies: [],
          estimatedCostCents: 200,
          priority: 50,
          timeoutMs: this.getDefaultTaskTimeoutMs(),
        }],
        risks: ["Planner unavailable — executing without decomposition"],
        estimatedTotalCostCents: 200,
        estimatedTimeMinutes: 30,
      };
    }

    if (output.tasks.length === 0) {
      // Planner returned valid JSON but empty tasks — use fallback single task
      logger.warn("Planner returned no tasks, falling back to single-task plan", { goalId: goal.id });
      output = {
        ...output,
        tasks: [{
          title: goal.title,
          description: goal.description,
          agentRole: "generalist",
          dependencies: [],
          estimatedCostCents: 200,
          priority: 50,
          timeoutMs: this.getDefaultTaskTimeoutMs(),
        }],
      };
    }

    decomposeGoal(this.params.db, goal.id, plannerOutputToTasks(goal.id, output));
    if (invalidateGhostGoal(this.params.db, goal.id, "planning_output_validation")) {
      return {
        ...state,
        phase: "failed",
        failedError: "Goal invalidated: planner output produced no executable tasks.",
      };
    }
    this.persistPlannerOutput(goal.id, output, "plan");

    return {
      ...state,
      phase: "plan_review",
    };
  }

  private async handlePlanReviewPhase(state: OrchestratorState): Promise<OrchestratorState> {
    if (!state.goalId) {
      return { ...state, phase: "idle" };
    }

    const planKey = `orchestrator.plan.${state.goalId}`;
    const planRow = this.params.db
      .prepare("SELECT value FROM kv WHERE key = ?")
      .get(planKey) as { value: string } | undefined;

    if (!planRow?.value) {
      return { ...state, phase: "executing" };
    }

    const planData = safeJsonParse(planRow.value);
    if (!planData) {
      return { ...state, phase: "executing" };
    }

    try {
      const result = await reviewPlan(planData as any, {
        mode: "auto",
        autoBudgetThreshold: 5000,
        consensusCriticRole: "reviewer",
        reviewTimeoutMs: 1800000,
      });

      if (result.approved) {
        return { ...state, phase: "executing" };
      }

      this.params.db.prepare(
        "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))",
      ).run(`orchestrator.review_feedback.${state.goalId}`, result.feedback ?? "Plan rejected");

      return { ...state, phase: "planning" };
    } catch (error) {
      const err = normalizeError(error);
      if (err.message === "awaiting human approval") {
        return state;
      }
      throw error;
    }
  }

  private async handleExecutingPhase(
    state: OrchestratorState,
    counters: TickCounters,
  ): Promise<OrchestratorState> {
    if (!state.goalId) {
      return {
        ...state,
        phase: "idle",
      };
    }

    const goal = getGoalById(this.params.db, state.goalId);
    if (!goal) {
      return {
        ...state,
        phase: "idle",
        goalId: null,
      };
    }

    if (invalidateGhostGoal(this.params.db, goal.id, "executing_phase_validation")) {
      return {
        ...state,
        phase: "failed",
        failedError: "Goal invalidated: active goal has no executable tasks.",
      };
    }

    // Recover stale tasks: workers that died (process restart, sandbox crash)
    // leave tasks stuck in 'assigned' forever. Detect and reset them.
    let staleRecoveries = 0;
    if (this.params.isWorkerAlive) {
      const assignedTasks = getTasksByGoal(this.params.db, goal.id)
        .filter((t) => t.status === "assigned" && t.assignedTo);
      for (const task of assignedTasks) {
        const alive = this.params.isWorkerAlive(task.assignedTo!);
        if (!alive) {
          staleRecoveries += 1;
          logger.warn("Recovering stale task from dead worker", {
            taskId: task.id,
            worker: task.assignedTo,
          });
          const staleError = `Task recovered from stale worker assignment (${task.assignedTo})`;
          this.rememberDeadWorker(task.assignedTo!, task.id, "stale-assignment");
          this.params.agentTracker.updateStatus(task.assignedTo!, "failed");
          await this.handleFailure(task, staleError, true);
        }
      }
    }

    const ready = this.prioritizeReadyTasksForGoal(
      goal,
      getReadyTasks(this.params.db).filter((task) => task.goalId === goal.id),
    );

    for (const task of ready) {
      try {
        const assignment = await this.matchTaskToAgent(task);
        assignTask(this.params.db, task.id, assignment.agentAddress);

        const isLocalWorker = assignment.agentAddress.startsWith("local://");
        const isSelfAssigned = assignment.agentAddress === this.params.identity?.address;

        // Local workers receive their task directly at spawn time and run
        // their own inference loop. Self-assigned tasks are handled by the
        // parent agent via its normal turn. Neither needs funding or messaging.
        if (!isLocalWorker && !isSelfAssigned) {
          await this.fundAgentForTask(assignment.agentAddress, task);

          const message = this.params.messaging.createMessage({
            type: "task_assignment",
            to: assignment.agentAddress,
            goalId: task.goalId,
            taskId: task.id,
            priority: "high",
            requiresResponse: true,
            content: JSON.stringify({
              taskId: task.id,
              title: task.title,
              description: task.description,
              agentRole: task.agentRole,
              dependencies: task.dependencies,
              timeoutMs: task.metadata.timeoutMs,
            }),
          });

          await this.params.messaging.send(message);
        }

        this.params.agentTracker.updateStatus(assignment.agentAddress, "running");
        counters.tasksAssigned += 1;
      } catch (error) {
        const err = normalizeError(error);

        // If no agent is available, skip this task — it stays pending and will
        // be retried on the next tick when an agent becomes available or is spawned.
        if (err.message.startsWith("No available agent")) {
          logger.warn("No agent available for task, will retry next tick", {
            taskId: task.id,
            role: task.agentRole,
          });
          continue;
        }

        const previous = getTaskById(this.params.db, task.id);
        await this.handleFailure(task, err.message);
        const latest = getTaskById(this.params.db, task.id);
        if (previous?.status !== "failed" && latest?.status === "failed") {
          counters.tasksFailed += 1;
        }
      }
    }

    await this.collectResults();

    for (const event of this.pendingTaskResults) {
      const taskRow = getTaskById(this.params.db, event.taskId);
      if (!taskRow) {
        continue;
      }

      if (event.result.success) {
        try {
          completeTask(this.params.db, taskRow.id, event.result);
          counters.tasksCompleted += 1;

          if (taskRow.assignedTo) {
            this.params.agentTracker.updateStatus(taskRow.assignedTo, "healthy");
          }
        } catch (error) {
          const err = normalizeError(error);
          const taskNode = taskRowToTaskNode(taskRow);
          await this.handleFailure(taskNode, err.message);
          const latest = getTaskById(this.params.db, taskNode.id);
          if (taskRow.status !== "failed" && latest?.status === "failed") {
            counters.tasksFailed += 1;
          }
        }

        continue;
      }

      const taskNode = taskRowToTaskNode(taskRow);
      const failureError = event.error ?? event.result.output;
      const isPermanent = taskRow.retryCount >= taskRow.maxRetries;
      if (this.shouldRecordChildFailure(taskRow.assignedTo)) {
        this.recordChildFailure({
          taskId: taskNode.id,
          goalId: taskNode.goalId,
          assignedTo: taskRow.assignedTo,
          error: failureError,
          isPermanent,
        });
      }
      await this.handleFailure(taskNode, failureError);
      const latest = getTaskById(this.params.db, taskNode.id);
      if (taskRow.status !== "failed" && latest?.status === "failed") {
        counters.tasksFailed += 1;
      }
    }

    const progress = getGoalProgress(this.params.db, goal.id);

    if (progress.total > 0 && progress.completed === progress.total) {
      updateGoalStatus(this.params.db, goal.id, "completed");
      return {
        ...state,
        phase: "complete",
      };
    }

    if (progress.failed > 0) {
      const maxReplans = this.getMaxReplans();
      return {
        ...state,
        phase: state.replanCount < maxReplans ? "replanning" : "failed",
        failedTaskId: state.failedTaskId ?? this.findFirstFailedTaskId(goal.id),
        failedError: state.failedError ?? "Task execution failed",
      };
    }

    if (this.shouldBreakExecutionStall(goal.id, counters, staleRecoveries)) {
      logger.warn("Execution appears stalled; forcing task unstick pass", {
        goalId: goal.id,
        staleRecoveries,
      });
      this.params.db.prepare(
        `UPDATE task_graph
         SET status = 'pending', assigned_to = NULL, started_at = NULL
         WHERE goal_id = ?
           AND status IN ('assigned', 'running')`,
      ).run(goal.id);
    }

    return state;
  }

  private async handleReplanningPhase(state: OrchestratorState): Promise<OrchestratorState> {
    if (!state.goalId) {
      return {
        ...state,
        phase: "idle",
      };
    }

    const goal = getGoalById(this.params.db, state.goalId);
    if (!goal) {
      return {
        ...state,
        phase: "idle",
        goalId: null,
      };
    }

    const failedTaskRow = state.failedTaskId
      ? getTaskById(this.params.db, state.failedTaskId)
      : getTasksByGoal(this.params.db, goal.id).find((task) => task.status === "failed");

    if (!failedTaskRow) {
      return {
        ...state,
        phase: "executing",
      };
    }

    let output: PlannerOutput;
    try {
      output = await replanAfterFailure(
        goalRowToGoal(goal),
        taskRowToTaskNode(failedTaskRow),
        await this.buildPlannerContext(),
        this.params.inference,
      );
      this.clearPlannerRuntimeIssue();
    } catch (error) {
      const err = normalizeError(error);
      this.recordPlannerRuntimeIssue("replanner", goal.id, err.message);
      logger.warn("Replanner inference failed, falling back to single-task plan", {
        goalId: goal.id,
        error: err.message,
      });
      output = {
        analysis: `Replanner fallback: ${err.message}`,
        strategy: "Re-execute goal as a single generalist task",
        customRoles: [],
        tasks: [{
          title: goal.title,
          description: goal.description,
          agentRole: "generalist",
          dependencies: [],
          estimatedCostCents: 200,
          priority: 50,
          timeoutMs: this.getDefaultTaskTimeoutMs(),
        }],
        risks: ["Replanner unavailable — re-executing without decomposition"],
        estimatedTotalCostCents: 200,
        estimatedTimeMinutes: 30,
      };
    }

    if (output.tasks.length === 0) {
      logger.warn("Replanner returned no tasks, falling back to single-task plan", { goalId: goal.id });
      output = {
        ...output,
        tasks: [{
          title: goal.title,
          description: goal.description,
          agentRole: "generalist",
          dependencies: [],
          estimatedCostCents: 200,
          priority: 50,
          timeoutMs: this.getDefaultTaskTimeoutMs(),
        }],
      };
    }

    this.params.db.prepare(
      `UPDATE task_graph
       SET status = 'pending',
           assigned_to = NULL,
           started_at = NULL,
           completed_at = NULL,
           result = NULL
       WHERE goal_id = ?
         AND status IN ('failed', 'blocked')`,
    ).run(goal.id);

    updateGoalStatus(this.params.db, goal.id, "active");

    decomposeGoal(this.params.db, goal.id, plannerOutputToTasks(goal.id, output));
    if (invalidateGhostGoal(this.params.db, goal.id, "replanning_output_validation")) {
      return {
        ...state,
        phase: "failed",
        failedError: "Goal invalidated: replan output produced no executable tasks.",
      };
    }
    this.persistPlannerOutput(goal.id, output, "replan");

    return {
      ...state,
      phase: "plan_review",
      replanCount: state.replanCount + 1,
      failedTaskId: null,
      failedError: null,
    };
  }

  private async handleCompletePhase(state: OrchestratorState): Promise<OrchestratorState> {
    await this.recallAgentCredits();

    return {
      ...DEFAULT_STATE,
      phase: "idle",
    };
  }

  private handleFailedPhase(state: OrchestratorState): OrchestratorState {
    logger.warn("Goal execution failed", {
      goalId: state.goalId,
      error: state.failedError,
      replanCount: state.replanCount,
    });

    if (!state.goalId) {
      return { ...DEFAULT_STATE };
    }

    updateGoalStatus(this.params.db, state.goalId, "failed");

    // Reset to idle so the orchestrator can pick up other active goals
    // instead of being stuck in "failed" forever.
    return { ...DEFAULT_STATE };
  }

  private async classifyComplexity(goal: GoalRow): Promise<{ requiresPlanMode: boolean; estimatedSteps: number }> {
    try {
      const result = await this.params.inference.chat({
        tier: "cheap",
        responseFormat: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "Classify execution complexity.",
              "Return JSON with keys: estimatedSteps (number), reason (string), stepOutline (array of strings).",
              "No markdown.",
            ].join(" "),
          },
          {
            role: "user",
            content: `Goal title: ${goal.title}\nGoal description: ${goal.description}`,
          },
        ],
      });

      const parsed = safeJsonParse(result.content);
      const estimatedSteps = clampSteps(
        typeof parsed?.estimatedSteps === "number" ? parsed.estimatedSteps : heuristicStepEstimate(goal),
      );

      return {
        estimatedSteps,
        requiresPlanMode: estimatedSteps > 3,
      };
    } catch {
      const estimatedSteps = heuristicStepEstimate(goal);
      return {
        estimatedSteps,
        requiresPlanMode: estimatedSteps > 3,
      };
    }
  }

  private async buildPlannerContext(): Promise<PlannerContext> {
    const activeGoals = getActiveGoals(this.params.db);
    const idleAgents = this.params.agentTracker.getIdle().length;
    const agentsActive = this.getActiveAgentCount();
    const creditsCents = await this.params.funding.getBalance(this.params.identity.address);

    const recentOutcomes = this.params.db.prepare(
      `SELECT type, goal_id AS goalId, task_id AS taskId, content, created_at AS createdAt
       FROM event_stream
       WHERE type IN ('task_completed', 'task_failed')
       ORDER BY created_at DESC
       LIMIT 20`,
    ).all() as Array<{
      type: string;
      goalId: string | null;
      taskId: string | null;
      content: string;
      createdAt: string;
    }>;

    return {
      creditsCents,
      usdcBalance: Number(this.params.config?.usdcBalance ?? 0),
      survivalTier: creditsCents <= 0 ? "critical" : creditsCents < 100 ? "low" : "stable",
      availableRoles: ["generalist"],
      customRoles: [],
      activeGoals: activeGoals.map((goal) => ({
        id: goal.id,
        title: goal.title,
        description: goal.description,
        status: goal.status,
      })),
      recentOutcomes,
      marketIntel: "none",
      idleAgents,
      busyAgents: Math.max(0, agentsActive - idleAgents),
      maxAgents: Number(this.params.config?.maxChildren ?? 3),
      workspaceFiles: [],
    };
  }

  private findBusyAgentForReassign(): { address: string; name: string } | null {
    const idleAddresses = new Set(this.params.agentTracker.getIdle().map((agent) => agent.address));

    const rows = this.params.db.prepare(
      `SELECT name, address, status
      , created_at, last_checked
       FROM children
       WHERE status IN ('running', 'healthy')
       ORDER BY created_at ASC`,
    ).all() as {
      name: string;
      address: string;
      status: string;
      created_at: string | null;
      last_checked: string | null;
    }[];

    const candidate = rows.find((row) =>
      !idleAddresses.has(row.address)
      && !this.isWorkerQuarantined(row.address)
      && isChildRecent(
        row.last_checked,
        row.created_at,
        Date.now(),
        this.getWorkerLivenessTtlMs(),
      ));
    if (!candidate) {
      return null;
    }

    return {
      address: candidate.address,
      name: candidate.name,
    };
  }

  private async trySpawnAgent(task: TaskNode): Promise<AgentAssignment | null> {
    if (this.params.config?.disableSpawn === true) {
      return null;
    }

    const spawn = this.params.config?.spawnAgent;
    if (typeof spawn !== "function") {
      return null;
    }

    const spawned = await spawn(task);
    if (!spawned || typeof spawned.address !== "string" || typeof spawned.name !== "string") {
      return null;
    }

    const sandboxId = typeof spawned.sandboxId === "string" ? spawned.sandboxId : ulid();
    const existing = this.params.db.prepare(
      "SELECT id FROM children WHERE address = ? OR sandbox_id = ? LIMIT 1",
    ).get(spawned.address, sandboxId) as { id: string } | undefined;
    if (!existing) {
      this.params.agentTracker.register({
        address: spawned.address,
        name: spawned.name,
        role: task.agentRole ?? "generalist",
        sandboxId,
      });
    }

    this.params.agentTracker.updateStatus(spawned.address, "running");

    return {
      agentAddress: spawned.address,
      agentName: spawned.name,
      spawned: true,
    };
  }

  private async recallAgentCredits(): Promise<void> {
    const children = this.params.db.prepare(
      `SELECT address FROM children WHERE status IN ('running', 'healthy')`,
    ).all() as { address: string }[];

    for (const child of children) {
      try {
        await this.params.funding.recallCredits(child.address);
      } catch (error) {
        const err = normalizeError(error);
        logger.warn("Failed to recall credits", {
          address: child.address,
          error: err.message,
        });
      }
    }
  }

  private persistTodo(): void {
    const todoMd = generateTodoMd(this.params.db);
    this.params.db.prepare(
      "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    ).run(ORCHESTRATOR_TODO_KEY, todoMd);
  }

  private persistPlannerOutput(goalId: string, output: PlannerOutput, mode: "plan" | "replan"): void {
    const key = `orchestrator.${mode}.${goalId}`;
    this.params.db.prepare(
      "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    ).run(key, JSON.stringify(output));
  }

  private loadState(): OrchestratorState {
    const row = this.params.db
      .prepare("SELECT value FROM kv WHERE key = ?")
      .get(ORCHESTRATOR_STATE_KEY) as { value: string } | undefined;

    if (!row?.value) {
      return { ...DEFAULT_STATE };
    }

    const parsed = safeJsonParse(row.value);
    if (!parsed || typeof parsed !== "object") {
      return { ...DEFAULT_STATE };
    }

    const phase = asPhase(parsed.phase);
    return {
      phase: phase ?? DEFAULT_STATE.phase,
      goalId: typeof parsed.goalId === "string" ? parsed.goalId : null,
      replanCount: typeof parsed.replanCount === "number" ? Math.max(0, Math.floor(parsed.replanCount)) : 0,
      failedTaskId: typeof parsed.failedTaskId === "string" ? parsed.failedTaskId : null,
      failedError: typeof parsed.failedError === "string" ? parsed.failedError : null,
    };
  }

  private saveState(state: OrchestratorState): void {
    this.params.db.prepare(
      "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    ).run(ORCHESTRATOR_STATE_KEY, JSON.stringify(state));
  }

  private findFirstFailedTaskId(goalId: string): string | null {
    const row = this.params.db.prepare(
      `SELECT id FROM task_graph WHERE goal_id = ? AND status = 'failed' ORDER BY created_at ASC LIMIT 1`,
    ).get(goalId) as { id: string } | undefined;

    return row?.id ?? null;
  }

  private getActiveAgentCount(): number {
    const row = this.params.db.prepare(
      `SELECT COUNT(*) AS count FROM children WHERE status IN ('running', 'healthy')`,
    ).get() as { count: number } | undefined;

    return row?.count ?? 0;
  }

  private getMaxReplans(): number {
    const configured = Number(this.params.config?.maxReplans ?? DEFAULT_MAX_REPLANS);
    if (!Number.isFinite(configured)) {
      return DEFAULT_MAX_REPLANS;
    }

    return Math.max(0, Math.floor(configured));
  }

  private getDefaultTaskTimeoutMs(): number {
    return DEFAULT_ORCHESTRATOR_TASK_TIMEOUT_MS;
  }

  private getWorkerLivenessTtlMs(): number {
    const configured = this.params.config?.orchestration?.workerLivenessTtlMs;
    return normalizeTtlMs(configured, DEFAULT_WORKER_LIVENESS_TTL_MS);
  }

  private getWorkerQuarantineTtlMs(): number {
    const configured = this.params.config?.orchestration?.workerQuarantineTtlMs;
    return normalizeTtlMs(configured, DEFAULT_WORKER_QUARANTINE_TTL_MS);
  }

  private rememberDeadWorker(address: string, taskId: string, reason: string): void {
    const now = new Date();
    const until = new Date(now.getTime() + this.getWorkerQuarantineTtlMs()).toISOString();
    const fingerprint = workerFingerprint(address);
    const previous = this.loadDeadWorkers().filter((worker) => worker.address !== address);
    const next: DeadWorkerRecord[] = [
      {
        address,
        fingerprint,
        taskId,
        reason,
        until,
        updatedAt: now.toISOString(),
      },
      ...previous,
    ].slice(0, 50);
    this.params.db.prepare(
      "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    ).run(ORCHESTRATOR_DEAD_WORKERS_KEY, JSON.stringify(next));
  }

  private isWorkerQuarantined(address: string): boolean {
    const now = Date.now();
    const candidateFingerprint = workerFingerprint(address);
    // Quarantine release policy: rows expire strictly by `until`. Eligibility
    // for assignment is determined later by normal liveness checks.
    const active = this.loadDeadWorkers().filter((worker) => {
      const untilAt = Date.parse(worker.until);
      return Number.isFinite(untilAt) && untilAt > now;
    });
    if (active.length > 0) {
      this.params.db.prepare(
        "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))",
      ).run(ORCHESTRATOR_DEAD_WORKERS_KEY, JSON.stringify(active));
    }
    return active.some((worker) =>
      worker.address === address
      || (!!candidateFingerprint && worker.fingerprint === candidateFingerprint));
  }

  private loadDeadWorkers(): DeadWorkerRecord[] {
    const row = this.params.db
      .prepare("SELECT value FROM kv WHERE key = ?")
      .get(ORCHESTRATOR_DEAD_WORKERS_KEY) as { value: string } | undefined;
    const parsed = row?.value ? safeJsonParse(row.value) : null;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is DeadWorkerRecord =>
        !!entry
        && typeof entry.address === "string"
        && typeof entry.fingerprint === "string"
        && typeof entry.until === "string")
      : [];
  }

  private shouldBreakExecutionStall(
    goalId: string,
    counters: TickCounters,
    staleRecoveries: number,
  ): boolean {
    if (counters.tasksAssigned > 0 || counters.tasksCompleted > 0 || counters.tasksFailed > 0) {
      this.params.db.prepare("DELETE FROM kv WHERE key = ?").run(ORCHESTRATOR_EXEC_STALL_KEY);
      return false;
    }

    const tasks = getTasksByGoal(this.params.db, goalId);
    const signature = JSON.stringify(
      tasks
        .map((task) => `${task.id}:${task.status}:${task.assignedTo ?? "none"}:${task.retryCount}`)
        .sort(),
    );
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const current = this.loadExecutionStallState();

    if (!current || current.goalId !== goalId || current.signature !== signature) {
      this.saveExecutionStallState({
        goalId,
        signature,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
      });
      return false;
    }

    this.saveExecutionStallState({
      ...current,
      lastSeenAt: nowIso,
    });
    const firstSeenMs = Date.parse(current.firstSeenAt);
    const hasTimedOut = Number.isFinite(firstSeenMs) && nowMs - firstSeenMs >= EXECUTION_STALL_THRESHOLD_MS;
    if (!hasTimedOut) return false;

    // Force unstick when execution is stale even without fresh dead-worker events.
    // Requiring staleRecoveries can miss prolonged "assigned/running but no progress" loops.
    const inFlightCount = Number(
      (
        this.params.db.prepare(
          "SELECT COUNT(*) AS count FROM task_graph WHERE goal_id = ? AND status IN ('assigned', 'running')",
        ).get(goalId) as { count?: number } | undefined
      )?.count ?? 0,
    );
    return staleRecoveries > 0 || inFlightCount > 0;
  }

  private loadExecutionStallState(): ExecutionStallState | null {
    const row = this.params.db
      .prepare("SELECT value FROM kv WHERE key = ?")
      .get(ORCHESTRATOR_EXEC_STALL_KEY) as { value: string } | undefined;
    const parsed = row?.value ? safeJsonParse(row.value) : null;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.goalId !== "string" || typeof parsed.signature !== "string") return null;
    if (typeof parsed.firstSeenAt !== "string" || typeof parsed.lastSeenAt !== "string") return null;
    return {
      goalId: parsed.goalId,
      signature: parsed.signature,
      firstSeenAt: parsed.firstSeenAt,
      lastSeenAt: parsed.lastSeenAt,
    };
  }

  private saveExecutionStallState(state: ExecutionStallState): void {
    this.params.db.prepare(
      "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    ).run(ORCHESTRATOR_EXEC_STALL_KEY, JSON.stringify(state));
  }

  private recordPlannerRuntimeIssue(
    phase: "planner" | "replanner",
    goalId: string,
    message: string,
  ): void {
    const previous = this.params.db.prepare(
      "SELECT value FROM kv WHERE key = ?",
    ).get(ORCHESTRATOR_PLANNER_RUNTIME_ISSUE_KEY) as { value: string } | undefined;
    const previousParsed = previous?.value ? safeJsonParse(previous.value) : null;
    const previousCount = typeof previousParsed?.count === "number"
      ? Math.max(0, Math.floor(previousParsed.count))
      : 0;
    const now = new Date().toISOString();
    const isAuthLike = /(401|invalid api key|api[_\s-]?key|unauthoriz|login fail|missing)/i.test(message);
    const missingRuntimeKey = /(zai_api_key:missing|minimax_api_key:missing|api[_\s-]?key:missing)/i.test(message);
    const payload = {
      phase,
      goalId,
      message,
      isAuthLike,
      missingRuntimeKey,
      count: previousCount + 1,
      firstSeenAt: typeof previousParsed?.firstSeenAt === "string" ? previousParsed.firstSeenAt : now,
      lastSeenAt: now,
    };
    this.params.db.prepare(
      "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    ).run(ORCHESTRATOR_PLANNER_RUNTIME_ISSUE_KEY, JSON.stringify(payload));
  }

  private clearPlannerRuntimeIssue(): void {
    this.params.db.prepare("DELETE FROM kv WHERE key = ?").run(ORCHESTRATOR_PLANNER_RUNTIME_ISSUE_KEY);
  }

  private recordChildFailure(entry: {
    taskId: string;
    goalId: string;
    assignedTo: string | null | undefined;
    error: string;
    isPermanent: boolean;
  }): void {
    const row = this.params.db.prepare(
      "SELECT value FROM kv WHERE key = ?",
    ).get(ORCHESTRATOR_CHILD_FAILURES_KEY) as { value: string } | undefined;
    const parsed = row?.value ? safeJsonParseArray(row.value) : [];
    const nextEntry = {
      taskId: entry.taskId,
      goalId: entry.goalId,
      assignedTo: entry.assignedTo ?? "unassigned",
      error: entry.error.slice(0, 240),
      isPermanent: entry.isPermanent,
      at: new Date().toISOString(),
    };
    const deduped = [
      nextEntry,
      ...parsed.filter((item) => item.taskId !== entry.taskId),
    ].slice(0, 25);
    this.params.db.prepare(
      "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    ).run(ORCHESTRATOR_CHILD_FAILURES_KEY, JSON.stringify(deduped));
  }

  private shouldRecordChildFailure(assignedTo: string | null | undefined): boolean {
    if (!assignedTo) return false;
    if (assignedTo === this.params.identity.address) return false;
    const row = this.params.db.prepare(
      "SELECT 1 AS exists_flag FROM children WHERE address = ? LIMIT 1",
    ).get(assignedTo) as { exists_flag?: number } | undefined;
    return row?.exists_flag === 1;
  }

  private prioritizeReadyTasksForGoal(goal: GoalRow, tasks: TaskNode[]): TaskNode[] {
    if (tasks.length <= 1) return tasks;
    if (!goal.projectId) return tasks;

    const project = getProjectById(this.params.db, goal.projectId);
    if (!project) return tasks;

    const scored = tasks.map((task, index) => ({
      task,
      index,
      score: laneTaskClassScore(project.lane, task.taskClass),
    }));

    scored.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (a.task.priority !== b.task.priority) return b.task.priority - a.task.priority;
      const aTs = Date.parse(a.task.metadata.createdAt);
      const bTs = Date.parse(b.task.metadata.createdAt);
      const aTime = Number.isFinite(aTs) ? aTs : 0;
      const bTime = Number.isFinite(bTs) ? bTs : 0;
      if (aTime !== bTime) return aTime - bTime;
      return a.index - b.index;
    });

    return scored.map((entry) => entry.task);
  }

  private pickGoalByPortfolio(goals: GoalRow[], preferredId: string | null): GoalRow {
    if (goals.length === 1) return goals[0];

    const readyByGoal = new Map<string, number>();
    for (const ready of getReadyTasks(this.params.db)) {
      readyByGoal.set(ready.goalId, (readyByGoal.get(ready.goalId) ?? 0) + 1);
    }

    const monetizationCoverageByGoal = new Map<string, number>();
    const coverageRows = this.params.db.prepare(
      `SELECT goal_id AS goalId,
              SUM(CASE WHEN task_class = 'distribution' AND status = 'pending' THEN 1 ELSE 0 END) AS pendingDistribution,
              SUM(CASE WHEN task_class = 'monetization' AND status = 'pending' THEN 1 ELSE 0 END) AS pendingMonetization
       FROM task_graph
       WHERE goal_id IN (${goals.map(() => "?").join(",")})
       GROUP BY goal_id`,
    ).all(...goals.map((goal) => goal.id)) as Array<{
      goalId: string;
      pendingDistribution: number;
      pendingMonetization: number;
    }>;
    for (const row of coverageRows) {
      let score = 0;
      if ((row.pendingDistribution ?? 0) > 0) score += 6;
      if ((row.pendingMonetization ?? 0) > 0) score += 6;
      monetizationCoverageByGoal.set(row.goalId, score);
    }

    const scored = goals.map((goal, index) => {
      const project = goal.projectId ? getProjectById(this.params.db, goal.projectId) : undefined;
      const readyCount = readyByGoal.get(goal.id) ?? 0;
      const projectStatusScore = project ? projectStatusPriority(project.status) : 0;
      const laneScore = project ? projectLanePriority(project.lane) : 0;
      const coverageScore = monetizationCoverageByGoal.get(goal.id) ?? 0;
      const preferredBonus = preferredId && goal.id === preferredId && readyCount > 0 ? 5 : 0;
      const total = readyCount * 20 + projectStatusScore + laneScore + coverageScore + preferredBonus;
      return { goal, index, total };
    });

    scored.sort((a, b) => {
      if (a.total !== b.total) return b.total - a.total;
      const aCreated = Date.parse(a.goal.createdAt);
      const bCreated = Date.parse(b.goal.createdAt);
      const aTime = Number.isFinite(aCreated) ? aCreated : 0;
      const bTime = Number.isFinite(bCreated) ? bCreated : 0;
      if (aTime !== bTime) return aTime - bTime;
      return a.index - b.index;
    });

    return scored[0].goal;
  }
}

function laneTaskClassScore(
  lane: ProjectLane,
  taskClass: TaskNode["taskClass"],
): number {
  const normalized = taskClass ?? "build";
  if (lane === "distribution") {
    if (normalized === "distribution" || normalized === "monetization") return 0;
    if (normalized === "ops" || normalized === "build") return 1;
    return 2;
  }
  if (lane === "research") {
    if (normalized === "research") return 0;
    if (normalized === "ops" || normalized === "build") return 1;
    return 2;
  }
  if (normalized === "build" || normalized === "ops") return 0;
  if (normalized === "monetization") return 1;
  return 2;
}

function projectStatusPriority(status: string): number {
  switch (status) {
    case "monetizing":
      return 20;
    case "distribution":
      return 16;
    case "shipping":
      return 12;
    case "incubating":
      return 8;
    default:
      return 0;
  }
}

function projectLanePriority(lane: ProjectLane): number {
  switch (lane) {
    case "distribution":
      return 8;
    case "build":
      return 5;
    case "research":
      return 2;
    default:
      return 0;
  }
}

function plannerOutputToTasks(goalId: string, output: PlannerOutput): DecomposeTaskInput[] {
  return output.tasks.map((task, index) => ({
    parentId: null,
    goalId,
    title: task.title,
    description: task.description,
    status: "pending",
    taskClass: task.taskClass,
    assignedTo: null,
    agentRole: task.agentRole,
    priority: clampPriority(task.priority, index),
    dependencies: task.dependencies.map((dep) => String(dep)),
    result: null,
    estimatedCostCents: task.estimatedCostCents,
    timeoutMs: task.timeoutMs,
  }));
}

function normalizeTtlMs(value: unknown, fallbackMs: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallbackMs;
  }
  return Math.max(1_000, Math.floor(numeric));
}

function goalRowToGoal(goal: GoalRow): Goal {
  return {
    id: goal.id,
    title: goal.title,
    description: goal.description,
    status: goal.status,
    strategy: goal.strategy,
    rootTasks: [],
    expectedRevenueCents: goal.expectedRevenueCents,
    actualRevenueCents: goal.actualRevenueCents,
    createdAt: goal.createdAt,
    deadline: goal.deadline,
  };
}

function taskRowToTaskNode(task: TaskGraphRow): TaskNode {
  return {
    id: task.id,
    parentId: task.parentId,
    goalId: task.goalId,
    title: task.title,
    description: task.description,
    status: task.status,
    taskClass: task.taskClass as TaskNode["taskClass"],
    assignedTo: task.assignedTo,
    agentRole: task.agentRole,
    priority: task.priority,
    dependencies: task.dependencies,
    result: normalizeTaskResult(task.result),
    metadata: {
      estimatedCostCents: task.estimatedCostCents,
      actualCostCents: task.actualCostCents,
      maxRetries: task.maxRetries,
      retryCount: task.retryCount,
      timeoutMs: task.timeoutMs,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
    },
  };
}

function parseTaskResultMessage(message: AgentMessage): TaskResultEnvelope | null {
  const payload = safeJsonParse(message.content);
  const fallbackTaskId = typeof message.taskId === "string" ? message.taskId : null;

  if (!payload || typeof payload !== "object") {
    if (!fallbackTaskId) {
      return null;
    }

    return {
      taskId: fallbackTaskId,
      goalId: message.goalId,
      result: {
        success: true,
        output: message.content,
        artifacts: [],
        costCents: 0,
        duration: 0,
      },
    };
  }

  const obj = payload as Record<string, unknown>;
  const nested = obj.result && typeof obj.result === "object"
    ? obj.result as Record<string, unknown>
    : obj;

  const taskId = firstString(obj.taskId, fallbackTaskId);
  if (!taskId) {
    return null;
  }

  const success = firstBoolean(nested.success, obj.success, true);
  const output = firstString(nested.output, obj.output, success ? "ok" : "task failed") ?? "";

  const result: TaskResult = {
    success,
    output,
    artifacts: normalizeArtifacts(nested.artifacts ?? obj.artifacts),
    costCents: firstNumber(nested.costCents, obj.costCents, 0),
    duration: firstNumber(nested.duration, obj.duration, 0),
  };

  return {
    taskId,
    goalId: message.goalId,
    result,
    error: success ? undefined : (firstString(obj.error, output) ?? undefined),
  };
}

function pickGoal(goals: GoalRow[], preferredId: string | null): GoalRow {
  if (preferredId) {
    const preferred = goals.find((goal) => goal.id === preferredId);
    if (preferred) {
      return preferred;
    }
  }

  return goals[0];
}

function clampPriority(priority: number, fallbackIndex: number): number {
  if (!Number.isFinite(priority)) {
    return Math.max(0, 50 - fallbackIndex);
  }

  return Math.max(0, Math.min(100, Math.floor(priority)));
}

function heuristicStepEstimate(goal: GoalRow): number {
  const words = `${goal.title} ${goal.description}`.trim().split(/\s+/).filter(Boolean).length;
  if (words >= 40) return 6;
  if (words >= 24) return 5;
  if (words >= 12) return 4;
  return 2;
}

function clampSteps(value: number): number {
  if (!Number.isFinite(value)) {
    return 4;
  }

  const rounded = Math.floor(value);
  return Math.max(1, Math.min(20, rounded));
}

function workerFingerprint(address: string): string {
  const normalized = address.toUpperCase();
  const match = normalized.match(/([A-Z0-9]{6})$/);
  return match ? match[1] : normalized;
}

function safeJsonParse(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function safeJsonParseArray(raw: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is Record<string, unknown> =>
      !!item && typeof item === "object");
  } catch {
    return [];
  }
}

function normalizeArtifacts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return null;
}

function firstBoolean(...values: unknown[]): boolean {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
  }

  return false;
}

function firstNumber(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return 0;
}

function asPhase(value: unknown): ExecutionPhase | null {
  if (
    value === "idle"
    || value === "classifying"
    || value === "planning"
    || value === "plan_review"
    || value === "executing"
    || value === "replanning"
    || value === "complete"
    || value === "failed"
  ) {
    return value;
  }

  return null;
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
