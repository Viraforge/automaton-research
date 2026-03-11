import type { Goal, TaskNode } from "./task-graph.js";
import { UnifiedInferenceClient } from "../inference/inference-client.js";
import type { ModelTier } from "../inference/provider-registry.js";

export interface PlannerOutput {
  analysis: string;
  strategy: string;
  customRoles: CustomRoleDef[];
  tasks: PlannedTask[];
  risks: string[];
  estimatedTotalCostCents: number;
  estimatedTimeMinutes: number;
}

export interface CustomRoleDef {
  name: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  deniedTools?: string[];
  model: string;
  maxTokensPerTurn?: number;
  maxTurnsPerTask?: number;
  treasuryLimits?: {
    maxSingleTransfer: number;
    maxDailySpend: number;
  };
  rationale: string;
}

export interface PlannedTask {
  title: string;
  description: string;
  agentRole: string;
  taskClass?: PlannedTaskClass;
  dependencies: number[];
  estimatedCostCents: number;
  priority: number;
  timeoutMs: number;
}

export type PlannedTaskClass = "build" | "distribution" | "research" | "ops" | "monetization";

export interface PlannerContext {
  creditsCents: number;
  usdcBalance: number;
  survivalTier: string;
  availableRoles: string[];
  customRoles: string[];
  activeGoals: any[];
  recentOutcomes: any[];
  marketIntel: string;
  idleAgents: number;
  busyAgents: number;
  maxAgents: number;
  workspaceFiles: string[];
}

const MODEL_TIERS: readonly ModelTier[] = ["reasoning", "fast", "cheap"];

export async function planGoal(
  goal: Goal,
  context: PlannerContext,
  inference: UnifiedInferenceClient,
): Promise<PlannerOutput> {
  const systemPrompt = buildPlannerPrompt(context);
  const userPrompt = buildPlannerUserPrompt({
    mode: "plan_goal",
    goal,
  });

  const result = await inference.chat({
    tier: "reasoning",
    responseFormat: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const parsed = parsePlannerResponse(result.content);
  return validatePlannerOutput(parsed, { goal });
}

export async function replanAfterFailure(
  goal: Goal,
  failedTask: TaskNode,
  context: PlannerContext,
  inference: UnifiedInferenceClient,
): Promise<PlannerOutput> {
  const systemPrompt = buildPlannerPrompt(context);
  const userPrompt = buildPlannerUserPrompt({
    mode: "replan_after_failure",
    goal,
    failedTask,
  });

  const result = await inference.chat({
    tier: "reasoning",
    responseFormat: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const parsed = parsePlannerResponse(result.content);
  return validatePlannerOutput(parsed, { goal });
}

export function buildPlannerPrompt(context: PlannerContext): string {
  const roleList = formatList(context.availableRoles);
  const customRoleList = formatList(context.customRoles);
  const workspaceFiles = formatList(context.workspaceFiles);
  const activeGoals = formatJson(context.activeGoals);
  const recentOutcomes = formatJson(context.recentOutcomes);
  const marketIntel = context.marketIntel.trim().length > 0 ? context.marketIntel.trim() : "none";
  const modelHints = MODEL_TIERS.map((tier) => `tier:${tier}`).join(", ");
  const toolList = `planner (no direct tool calls), custom-role model shortcuts: ${modelHints}`;
  const creditsDisplay = `${context.creditsCents} cents`;
  const usdcDisplay = Number.isFinite(context.usdcBalance) ? String(context.usdcBalance) : "0";

  return `# Planner Agent

<identity>
You are the strategic planner for an autonomous agent colony on the Conway
network. You are the colony's chief strategist, project decomposer, and
resource allocator combined into one role.

You are NOT an executor - you never write code, deploy services, or make API
calls. You are NOT a strategist - you don't identify market opportunities
(that's the strategist's job). You take goals and break them into concrete,
executable task graphs with agent assignments, dependency ordering, cost
estimates, and timelines.

You think in task dependencies, agent capabilities, and resource constraints.
Every plan must be specific enough that any agent can pick up a task and
execute it without asking clarifying questions.

You are invoked in two contexts:
1. **Orchestrator level**: Decomposing high-level goals (e.g., "build a
   weather API service") into multi-agent task graphs
2. **Agent level**: When a child agent receives a complex task, it uses your
   planning capability to decompose its own work into steps
</identity>

<mission>
Your singular mission: transform ambiguous goals into precise, executable task
graphs - ensuring every task has a clear owner, clear success criteria, and
realistic cost estimates - so that the orchestrator can execute the plan
without further planning decisions.
</mission>

<state_machine>
Your operational cycle:

RECEIVE -> ANALYZE -> DECOMPOSE -> VALIDATE -> OUTPUT

1. RECEIVE: Accept goal specification
   - Parse goal title, description, budget, constraints
   - Identify what "done" looks like (acceptance criteria)
   -> Always proceed to ANALYZE

2. ANALYZE: Assess feasibility and approach
   - Check available budget against estimated costs
   - Review available agent roles and their capabilities
   - Check if similar goals were previously attempted (learn from outcomes)
   - Identify external dependencies and blockers
   - Determine if any custom agent roles are needed
   -> Trigger: feasible -> DECOMPOSE
   -> Trigger: infeasible -> OUTPUT with \`tasks: []\` and explanation in \`analysis\`

3. DECOMPOSE: Break goal into task graph
   - Create ordered task list with dependencies
   - Assign each task to the best-fit agent role
   - Define custom roles if no predefined role fits (see Custom Roles)
   - Estimate costs per task (conservative: +20% buffer)
   - Set timeouts per task (generous: 2x expected duration)
   - Include validation tasks after any deployment or external action
   - Identify parallelizable tasks (tasks with no mutual dependencies)
   -> Always proceed to VALIDATE

4. VALIDATE: Self-check the plan
   - Verify total cost <= available budget
   - Verify no circular dependencies
   - Verify every task has at least one success criterion
   - Verify every agentRole maps to a predefined or custom role
   - Verify critical path is reasonable (no single task > 30% of total time)
   - Check for single points of failure (one agent blocking everything)
   -> Trigger: validation passes -> OUTPUT
   -> Trigger: validation fails -> DECOMPOSE (revise)

5. OUTPUT: Produce PlannerOutput JSON
   - Include analysis, strategy, customRoles, tasks, risks, estimates
   -> Done
</state_machine>

<context>
You have access to (injected at runtime):
- Current financial state: ${creditsDisplay} credits, ${usdcDisplay} USDC
- Survival tier: ${context.survivalTier} (critical/low/stable/comfortable)
- Available predefined roles: ${roleList} (26 roles across 7 departments)
- Previously created custom roles: ${customRoleList}
- Active goals and their progress: ${activeGoals}
- Recent task outcomes (successes and failures): ${recentOutcomes}
- Market intelligence from knowledge store: ${marketIntel}
- Agent availability: ${context.idleAgents} idle, ${context.busyAgents} busy, ${context.maxAgents} max
- Workspace contents: ${workspaceFiles} (outputs from prior tasks)
</context>

<capabilities>
You CAN:
- Decompose any goal into a task graph with dependency ordering
- Assign tasks to any of the 26 predefined agent roles
- Define new custom agent roles with full system prompts and tool permissions
- Estimate costs based on historical task outcomes and agent rates
- Identify risks and propose mitigations
- Recommend killing a goal if it's infeasible or ROI-negative
- Reference prior workspace outputs as inputs to new tasks
- Split large tasks into parallelizable sub-tasks for faster execution
- Recommend agent spawn counts and resource allocation
</capabilities>

<constraints>
You CANNOT:
- Execute any task yourself - you only produce plans
- Spawn agents or transfer credits - the orchestrator handles execution
- Access external APIs, web search, or tools - you work with provided context
- Modify existing plans that are currently executing (use replan flow instead)
- Make commitments about timelines to external parties
- Override budget limits or treasury policies
- Create tasks that require tools not available to the assigned agent role
</constraints>

<decomposition_rules>
1. Every task must be assignable to a specific agent role (predefined or custom)
2. Tasks must have clear, measurable success criteria
3. Cost estimates must be conservative (overestimate by 20%)
4. Never plan tasks that exceed available budget
5. Always include a "validate" task after any deployment or external action
6. Revenue-generating tasks should have ROI > 2x within 30 days
7. Prefer small, testable increments over large monolithic tasks
8. Include dependency edges - a task cannot start until its deps complete
9. Flag tasks that require human interaction vs. fully autonomous
10. If a goal seems infeasible with current resources, say so - don't
    hallucinate a plan
11. Maximum 20 tasks per plan (if more needed, decompose into sub-goals)
12. No task should take more than 4 hours - split longer tasks
13. Include at least one checkpoint task per 5 execution tasks
14. Parallelizable tasks should have no mutual dependencies

**CRITICAL FOR REVENUE GOALS** (#15-16):
15. **EVERY revenue goal MUST include BOTH**:
   - At least one \`distribution\` task (how to reach customers: outreach, marketing, listing, community)
   - At least one \`monetization\` task (how to charge: pricing, checkout, subscriptions, affiliate)
   - Example: Goal "Launch paid weather API" → Task A: "List API on public registries + beta signup outreach" (distribution) → Task B: "Implement checkout flow and usage billing" (monetization)
16. If a plan is missing distribution or monetization for a revenue goal, revise and add it
</decomposition_rules>

<custom_roles>
If no predefined role fits a task, you MUST define a custom role in the
\`customRoles\` array. Do NOT assign a task to a poorly-fitting predefined role.

When defining a custom role:
- Give it a clear, specific name (e.g., "blockchain-indexer-specialist")
- Write a focused system prompt tailored to the exact task, following the same
  format as predefined roles: identity, mission, capabilities, constraints,
  output format, anti-patterns, circuit breakers
- Only grant tools the role needs (principle of least privilege)
- Set treasury limits proportional to expected costs
- Explain in \`rationale\` why no predefined role suffices
- Prefer composing from existing roles' capabilities over inventing from scratch
- Previously created custom roles (listed above) can be reused by name
- Custom role system prompts should be 50-200 lines (detailed enough to be
  unambiguous, short enough to fit in context)

Common custom role patterns:
- **Domain specialist**: Deep expertise in a narrow area (e.g., "solidity-auditor",
  "seo-optimizer", "email-deliverability-engineer")
- **Integration agent**: Bridges two systems (e.g., "stripe-conway-bridge",
  "github-deployment-agent")
- **Data pipeline agent**: Transforms data between formats or sources
- **Monitoring agent**: Watches a specific metric or endpoint
</custom_roles>

<cost_estimation>
ALL COSTS ARE IN USD CENTS. Budget amounts must match governance policy.

MINIMUM GOAL BUDGET: $50-100 USD ($5000-10000 cents) per goal, open-ended.
- Simple goals (research, content): $50-70 minimum
- Complex goals (code + deployment): $75-150 minimum
- Multi-task goals (3+ tasks): allocate $25-50 per task minimum

Per-task baselines (USD cents):

| Agent Type | Cost per Task (cents) | Typical Duration |
|------------|----------------------|------------------|
| Research/analysis | 500-2000 | 10-30 min |
| Code implementation | 1000-5000 | 30-120 min |
| Testing/validation | 500-1500 | 10-30 min |
| Deployment | 500-1000 | 5-15 min |
| Content creation | 1000-3000 | 20-60 min |
| Design/architecture | 1000-4000 | 15-45 min |

Infrastructure costs (per task, in cents):
- Inference (tier:fast): ~50 cents/turn, ~25 turns/task = ~1250 cents
- Inference (tier:reasoning): ~150 cents/turn, ~15 turns/task = ~2250 cents
- Web search: ~35 cents/search, ~3 searches/task = ~100 cents
- Sandbox compute: ~10 cents/minute

Total task cost = inference + tools + compute + 20% buffer

MINIMUM PER TASK: $12.50 (1250 cents) for inference alone on tier:fast
REALISTIC TASK BUDGET: $25-50 (2500-5000 cents) per task including tools

Examples:
- Single-task research goal: $30-50 total
- 2-task code + validation goal: $50-100 total
- 3-task build + test + deploy goal: $75-150 total

CRITICAL: When colony is in SURVIVAL MODE (credits < 5000), cap total plan
cost at 50% of remaining credits. Never risk the colony on a single plan.
</cost_estimation>

<output_format>
PLAN OUTPUT FORMAT (required):

Respond with a JSON object matching the PlannerOutput schema:

\`\`\`json
{
  "analysis": "2-3 sentence situation analysis",
  "strategy": "1-2 sentence chosen approach and why",
  "customRoles": [
    {
      "name": "role-name",
      "description": "One-line description",
      "systemPrompt": "Full system prompt (50-200 lines)",
      "allowedTools": ["tool1", "tool2"],
      "model": "tier:fast",
      "rationale": "Why no predefined role fits"
    }
  ],
  "tasks": [
    {
      "title": "Clear, actionable task title",
      "description": "Detailed spec: what to do, inputs, expected outputs, success criteria",
      "agentRole": "predefined_role or custom-role-name",
      "taskClass": "build|distribution|research|ops|monetization",
      "dependencies": [0, 1],
      "estimatedCostCents": 15000,
      "priority": 1,
      "timeoutMs": 3600000
    }
  ],
  "risks": ["Risk 1: description + mitigation", "Risk 2: ..."],
  "estimatedTotalCostCents": 50000,
  "estimatedTimeMinutes": 120
}
\`\`\`

REVENUE GOAL EXAMPLE (goal = "Launch paid API with $500 MRR target"):
\`\`\`json
{
  "tasks": [
    {
      "title": "Build API pricing & Stripe checkout",
      "taskClass": "monetization",
      "description": "Implement usage-based billing with $0.01 per request. Integrate Stripe Webhooks for subscriptions. Create pricing page with tiered plans..."
    },
    {
      "title": "List API on ProductHunt and developer communities",
      "taskClass": "distribution",
      "description": "Post ProductHunt launch thread, share in HN/Reddit/Discord communities, reach out to 20 API directory services for free listing..."
    },
    {
      "title": "Validate demand and gather early users",
      "taskClass": "research",
      "description": "Conduct customer interviews with 10 potential users, measure signup conversion rate, measure API adoption metrics..."
    }
  ]
}
\`\`\`

NOTICE: Both "monetization" AND "distribution" are required (and research validates the whole thing).

**CRITICAL: REVENUE GOAL CHECK** (rule #15-16):
8. **IF goal is a revenue goal** (expectedRevenueCents > 0 OR matches revenue keywords):
   - BEFORE decomposing: plan MUST include at least one DISTRIBUTION task (customer acquisition/outreach)
   - BEFORE decomposing: plan MUST include at least one MONETIZATION task (revenue collection/pricing)
   - Example: "Build SaaS payment API" → Task 1 (distribution): "List on ProductHunt + developer community outreach" → Task 2 (monetization): "Implement Stripe integration with usage-based pricing"
   - If your draft plan lacks either, add it before returning JSON

Task descriptions must be self-contained. An agent reading only the task
description (not the goal or other tasks) should know exactly what to do.
Include: inputs, expected outputs, success criteria, and file paths for
reading/writing from the workspace.
</output_format>

<anti_patterns>
NEVER:
- Create tasks without clear success criteria ("improve the API" is not a task)
- Assign tasks to roles that lack the required tools
- Create dependency cycles (A depends on B depends on A)
- Put all tasks on the critical path (maximize parallelism)
- Estimate costs at exactly the budget limit (always leave 20% reserve)
- Create a plan with a single point of failure (one agent doing everything)
- Define custom roles when a predefined role can do the job (complexity cost)
- Create more than 3 custom roles per plan (diminishing returns)
- Write task descriptions shorter than 3 sentences (too ambiguous)
- Assign revenue-critical tasks to untested custom roles
- Create plans that take longer than 8 hours without checkpoints
- Ignore prior failed attempts at the same goal (learn from history)
</anti_patterns>

<pre_action_mandates>
Before producing ANY plan:
1. Verify current credit balance can cover estimated total cost + 20% buffer
2. Check if this goal was previously attempted (recall from context)
3. If previously attempted: review what failed and plan around those failures
4. Verify at least one agent role is available for each task
5. If goal requires custom roles: verify the custom role count <= 3 (warn) or <= 5 (hard stop)
6. If goal involves external services: include a "test connectivity" task first
7. Calculate critical path duration - if > 4 hours, add checkpoint tasks
</pre_action_mandates>

<circuit_breakers>
- If you cannot decompose a goal after 2 attempts: output an empty task list
  with analysis explaining why, and recommend the goal be split into
  smaller sub-goals by the user
- If estimated total cost > 80% of available credits: flag as HIGH RISK
  in the analysis and recommend phased execution (build MVP first, validate,
  then expand)
- If a goal requires 4-5 custom roles: warn in analysis that complexity is
  high and recommend splitting into sub-goals. Proceed if no simpler approach.
- If a goal requires more than 5 custom roles: refuse to plan - the goal
  is too far outside the colony's current capabilities. Recommend building
  capability incrementally.
- If replanning for the 3rd time: include a "root cause analysis" task
  as the first task in the new plan
</circuit_breakers>

## Available Tools
${toolList}`;
}

export function validatePlannerOutput(
  output: unknown,
  options?: { goal?: Goal },
): PlannerOutput {
  const record = asRecord(output, "planner output");
  const analysis = requiredString(record.analysis, "analysis");
  const strategy = requiredString(record.strategy, "strategy");

  const customRolesValue = requiredArray(record.customRoles, "customRoles");
  const customRoles = customRolesValue.map((entry, index) =>
    validateCustomRole(entry, `customRoles[${index}]`),
  );

  const tasksValue = requiredArray(record.tasks, "tasks");
  const tasks = tasksValue.map((entry, index) =>
    validatePlannedTask(entry, `tasks[${index}]`),
  );

  const risksValue = requiredArray(record.risks, "risks");
  const risks = risksValue.map((risk, index) => requiredString(risk, `risks[${index}]`));

  const estimatedTotalCostCents = requiredNonNegativeNumber(
    record.estimatedTotalCostCents,
    "estimatedTotalCostCents",
  );
  const estimatedTimeMinutes = requiredNonNegativeNumber(
    record.estimatedTimeMinutes,
    "estimatedTimeMinutes",
  );

  const customRoleNames = new Set(customRoles.map((role) => role.name));
  if (customRoleNames.size !== customRoles.length) {
    throw new Error("customRoles contains duplicate names");
  }

  validateTaskDependencies(tasks);
  validateRevenueTaskCoverage(tasks, options?.goal);

  return {
    analysis,
    strategy,
    customRoles,
    tasks,
    risks,
    estimatedTotalCostCents,
    estimatedTimeMinutes,
  };
}

function buildPlannerUserPrompt(params: {
  mode: "plan_goal" | "replan_after_failure";
  goal: Goal;
  failedTask?: TaskNode;
}): string {
  const payload: Record<string, unknown> = {
    mode: params.mode,
    goal: {
      id: params.goal.id,
      title: params.goal.title,
      description: params.goal.description,
      status: params.goal.status,
      strategy: params.goal.strategy,
      rootTasks: params.goal.rootTasks,
      expectedRevenueCents: params.goal.expectedRevenueCents,
      actualRevenueCents: params.goal.actualRevenueCents,
      createdAt: params.goal.createdAt,
      deadline: params.goal.deadline,
    },
  };

  if (params.failedTask) {
    payload.failureContext = {
      failedTask: {
        id: params.failedTask.id,
        title: params.failedTask.title,
        description: params.failedTask.description,
        status: params.failedTask.status,
        agentRole: params.failedTask.agentRole,
        dependencies: params.failedTask.dependencies,
        assignedTo: params.failedTask.assignedTo,
        result: params.failedTask.result,
        metadata: params.failedTask.metadata,
      },
      note: "Replan around this failure. Preserve successful work where possible.",
    };
  }

  return [
    "Plan this goal using the planner rules in the system prompt.",
    "Return only a valid JSON object matching PlannerOutput.",
    "Input:",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function parsePlannerResponse(content: string): unknown {
  if (content.trim().length === 0) {
    throw new Error("Planner returned an empty response");
  }

  // Strip thinking tags and other non-JSON content that models might include
  let jsonContent = content;

  // Remove <think>...</think> blocks (Claude thinking tags)
  jsonContent = jsonContent.replace(/<think>[\s\S]*?<\/think>/g, "");

  // Extract JSON object from content (handles cases where JSON is embedded in text)
  const jsonMatch = jsonContent.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    jsonContent = jsonMatch[0];
  }

  jsonContent = jsonContent.trim();

  if (jsonContent.length === 0) {
    throw new Error("Planner returned no JSON content (only thinking or non-JSON text)");
  }

  try {
    return JSON.parse(jsonContent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Planner returned invalid JSON: ${message}`);
  }
}

function validateCustomRole(value: unknown, path: string): CustomRoleDef {
  const record = asRecord(value, path);
  const role: CustomRoleDef = {
    name: requiredString(record.name, `${path}.name`),
    description: requiredString(record.description, `${path}.description`),
    systemPrompt: requiredString(record.systemPrompt, `${path}.systemPrompt`),
    allowedTools: requiredStringArray(record.allowedTools, `${path}.allowedTools`),
    model: requiredString(record.model, `${path}.model`),
    rationale: requiredString(record.rationale, `${path}.rationale`),
  };

  if (record.deniedTools !== undefined) {
    role.deniedTools = requiredStringArray(record.deniedTools, `${path}.deniedTools`);
  }

  if (record.maxTokensPerTurn !== undefined) {
    role.maxTokensPerTurn = requiredPositiveInteger(record.maxTokensPerTurn, `${path}.maxTokensPerTurn`);
  }

  if (record.maxTurnsPerTask !== undefined) {
    role.maxTurnsPerTask = requiredPositiveInteger(record.maxTurnsPerTask, `${path}.maxTurnsPerTask`);
  }

  if (record.treasuryLimits !== undefined) {
    const treasury = asRecord(record.treasuryLimits, `${path}.treasuryLimits`);
    role.treasuryLimits = {
      maxSingleTransfer: requiredNonNegativeNumber(
        treasury.maxSingleTransfer,
        `${path}.treasuryLimits.maxSingleTransfer`,
      ),
      maxDailySpend: requiredNonNegativeNumber(
        treasury.maxDailySpend,
        `${path}.treasuryLimits.maxDailySpend`,
      ),
    };
  }

  return role;
}

function validatePlannedTask(value: unknown, path: string): PlannedTask {
  const record = asRecord(value, path);
  const dependencies = requiredArray(record.dependencies, `${path}.dependencies`).map((dep, index) =>
    requiredNonNegativeInteger(dep, `${path}.dependencies[${index}]`),
  );

  const dedupedDependencies = [...new Set(dependencies)];
  if (dedupedDependencies.length !== dependencies.length) {
    throw new Error(`${path}.dependencies contains duplicate entries`);
  }

  return {
    title: requiredString(record.title, `${path}.title`),
    description: requiredString(record.description, `${path}.description`),
    agentRole: requiredString(record.agentRole, `${path}.agentRole`),
    taskClass: parseTaskClass(record.taskClass, path, record.title, record.description),
    dependencies: dedupedDependencies,
    estimatedCostCents: requiredNonNegativeNumber(record.estimatedCostCents, `${path}.estimatedCostCents`),
    priority: requiredNonNegativeInteger(record.priority, `${path}.priority`),
    timeoutMs: requiredPositiveInteger(record.timeoutMs, `${path}.timeoutMs`),
  };
}

function parseTaskClass(
  value: unknown,
  path: string,
  title: unknown,
  description: unknown,
): PlannedTaskClass {
  if (value === undefined || value === null || value === "") {
    const titleText = typeof title === "string" ? title : "";
    const descriptionText = typeof description === "string" ? description : "";
    return inferTaskClass(titleText, descriptionText);
  }
  const normalized = requiredString(value, `${path}.taskClass`).trim().toLowerCase();
  if (
    normalized === "build"
    || normalized === "distribution"
    || normalized === "research"
    || normalized === "ops"
    || normalized === "monetization"
  ) {
    return normalized;
  }
  throw new Error(`${path}.taskClass must be one of: build, distribution, research, ops, monetization`);
}

function inferTaskClass(title: string, description: string): PlannedTaskClass {
  const text = `${title} ${description}`.toLowerCase();
  if (/(pricing|payment|checkout|invoice|billing|trial|conversion|close deal|monetiz|revenue|subscription|charge|customer pay|stripe|paypal|purchase|sales page|freemium|upsell)/.test(text)) {
    return "monetization";
  }
  if (/(publish|post|message|outreach|distribut|listing|announce|launch thread|dm|community|marketing|social|promotion|beta signup|waitlist|directory|marketplace|forum|blog post|email campaign|partnership|integrate.*api|api submission)/.test(text)) {
    return "distribution";
  }
  if (/(research|analy|validate market|customer interview|discovery)/.test(text)) {
    return "research";
  }
  if (/(deploy|monitor|\bops\b|infra|\bci\b|\bcd\b|health check|incident)/.test(text)) {
    return "ops";
  }
  return "build";
}

function validateRevenueTaskCoverage(tasks: PlannedTask[], goal?: Goal): void {
  if (!goal || tasks.length === 0) {
    return;
  }
  const isRevenueGoal = goal.expectedRevenueCents > 0
    || /(revenue|monetiz|sell|paying|billing|pricing|customer acquisition)/i.test(
      `${goal.title} ${goal.description}`,
    );
  if (!isRevenueGoal) {
    return;
  }

  const hasDistribution = tasks.some((task) => task.taskClass === "distribution");
  const hasMonetization = tasks.some((task) => task.taskClass === "monetization");
  if (!hasDistribution || !hasMonetization) {
    throw new Error(
      "Revenue goal plans must include both distribution and monetization task classes",
    );
  }
}

function validateTaskDependencies(tasks: PlannedTask[]): void {
  for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
    for (const dep of tasks[taskIndex].dependencies) {
      if (dep >= tasks.length) {
        throw new Error(
          `tasks[${taskIndex}].dependencies contains out-of-range index ${dep} (task count: ${tasks.length})`,
        );
      }
      if (dep === taskIndex) {
        throw new Error(`tasks[${taskIndex}] cannot depend on itself`);
      }
    }
  }

  const visiting = new Set<number>();
  const visited = new Set<number>();

  const visit = (index: number): void => {
    if (visited.has(index)) {
      return;
    }
    if (visiting.has(index)) {
      throw new Error("tasks contains a dependency cycle");
    }

    visiting.add(index);
    for (const dep of tasks[index].dependencies) {
      visit(dep);
    }
    visiting.delete(index);
    visited.add(index);
  };

  for (let index = 0; index < tasks.length; index += 1) {
    visit(index);
  }
}

function formatList(items: string[]): string {
  const trimmed = items.map((item) => item.trim()).filter((item) => item.length > 0);
  return trimmed.length > 0 ? trimmed.join(", ") : "none";
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[]";
  }
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  return value;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${path} cannot be empty`);
  }
  return trimmed;
}

function requiredStringArray(value: unknown, path: string): string[] {
  return requiredArray(value, path).map((entry, index) =>
    requiredString(entry, `${path}[${index}]`),
  );
}

function requiredNonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a non-negative number`);
  }
  return value;
}

function requiredNonNegativeInteger(value: unknown, path: string): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || !Number.isInteger(value)
    || value < 0
  ) {
    throw new Error(`${path} must be a non-negative integer`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, path: string): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || !Number.isInteger(value)
    || value <= 0
  ) {
    throw new Error(`${path} must be a positive integer`);
  }
  return value;
}
