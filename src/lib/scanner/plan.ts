import type { AgentGoal, AgentPlan, FileEntry, PlanStep, PlanStepStatus } from "../types";
import { tailRecordsResult } from "./activity";
import { globalCache } from "./caches";
import { numberValue, recordValue, recordsValue, stringValue } from "./json";

const planCache = globalCache<[number, number, AgentPlan | null]>("plan-v2");
const goalCache = globalCache<[number, number, AgentGoal | null]>("goal-v2");

function normalizeStatus(value: unknown): PlanStepStatus {
  if (value === "in_progress" || value === "completed") return value;
  return "pending";
}

function buildPlan(steps: PlanStep[], updatedAt: string | null): AgentPlan | null {
  if (!steps.length) return null;
  const done = steps.filter((step) => step.status === "completed").length;
  const current =
    steps.find((step) => step.status === "in_progress")?.text ?? steps.find((step) => step.status === "pending")?.text ?? null;
  return { steps, done, total: steps.length, current, updatedAt };
}

/** Claude: assistant tool_use TodoWrite → input.todos[{content, status, activeForm}]. */
function claudePlan(obj: Record<string, unknown>): AgentPlan | null {
  if (obj.type !== "assistant") return null;
  for (const block of recordsValue(recordValue(obj.message)?.content)) {
    if (block.type !== "tool_use" || stringValue(block.name) !== "TodoWrite") continue;
    const todos = recordsValue(recordValue(block.input)?.todos);
    const steps = todos
      .map<PlanStep | null>((todo) => {
        const status = normalizeStatus(todo.status);
        /* activeForm reads better while the step runs («Running tests» vs
           «Run tests»), so it wins for the in-progress step. */
        const text =
          (status === "in_progress" ? stringValue(todo.activeForm)?.trim() : null) || stringValue(todo.content)?.trim() || null;
        return text ? { text, status } : null;
      })
      .filter((step): step is PlanStep => step !== null);
    return buildPlan(steps, stringValue(obj.timestamp));
  }
  return null;
}

/** Codex: function_call update_plan → JSON arguments {plan: [{step, status}]}. */
function codexPlan(obj: Record<string, unknown>): AgentPlan | null {
  const payload = recordValue(obj.payload);
  if (!payload || payload.type !== "function_call" || stringValue(payload.name) !== "update_plan") return null;
  const args = stringValue(payload.arguments);
  if (!args) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return null;
  }
  const steps = recordsValue(recordValue(parsed)?.plan)
    .map<PlanStep | null>((item) => {
      const text = stringValue(item.step)?.trim();
      return text ? { text, status: normalizeStatus(item.status) } : null;
    })
    .filter((step): step is PlanStep => step !== null);
  return buildPlan(steps, stringValue(obj.timestamp));
}

/**
 * The newest plan state an agent reported in its transcript tail. Both CLIs
 * rewrite the full plan on every update, so the last record alone is the
 * whole truth — no merging across records needed. Entries whose tail carries
 * no plan record return null (plan updates older than the tail window are
 * treated as expired context rather than surfaced as stale).
 */
export function planFor(entry: FileEntry): AgentPlan | null {
  const conversationRoot = entry.root === "claude-projects" || entry.root === "codex-sessions";
  if (!conversationRoot || !entry.path.endsWith(".jsonl")) return null;
  const mtimeMs = entry.mtime * 1000;
  const cached = planCache.get(entry.path);
  if (cached?.[0] === entry.size && cached[1] === mtimeMs) return cached[2];

  const tail = tailRecordsResult(entry.path, entry.size, mtimeMs);
  let plan: AgentPlan | null = null;
  for (const obj of tail.records.reverse()) {
    plan = entry.root === "codex-sessions" ? codexPlan(obj) : claudePlan(obj);
    if (plan) break;
  }
  if (tail.complete) planCache.set(entry.path, [entry.size, mtimeMs, plan]);
  return plan;
}

function goalStatus(value: unknown): AgentGoal["status"] | null {
  return value === "active" || value === "complete" || value === "blocked" ? value : null;
}

/** One record's contribution to the goal picture. Two record shapes exist:
    `thread_goal_updated` events carry the full goal object; `update_goal`
    function calls carry only the fields the agent changed (often just
    {"status":"complete"}). */
function goalFragment(obj: Record<string, unknown>): Partial<AgentGoal> | null {
  const payload = recordValue(obj.payload);
  if (!payload) return null;
  if (payload.type === "thread_goal_updated") {
    const goal = recordValue(payload.goal);
    if (!goal) return null;
    return {
      objective: stringValue(goal.objective),
      status: goalStatus(goal.status) ?? undefined,
      tokensUsed: numberValue(goal.tokensUsed),
      timeUsedSeconds: numberValue(goal.timeUsedSeconds),
    };
  }
  if (payload.type === "function_call" && stringValue(payload.name) === "update_goal") {
    const args = stringValue(payload.arguments);
    if (!args) return null;
    try {
      const parsed = recordValue(JSON.parse(args));
      if (!parsed) return null;
      return {
        objective: stringValue(parsed.objective),
        status: goalStatus(parsed.status) ?? (stringValue(parsed.objective) ? "active" : undefined),
      };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The session's declared goal, newest state first: the freshest record wins
 * per field, so a tail `update_goal {"status":"complete"}` combines with the
 * objective text an earlier record carried.
 */
export function goalFor(entry: FileEntry): AgentGoal | null {
  if (entry.root !== "codex-sessions" || !entry.path.endsWith(".jsonl")) return null;
  const mtimeMs = entry.mtime * 1000;
  const cached = goalCache.get(entry.path);
  if (cached?.[0] === entry.size && cached[1] === mtimeMs) return cached[2];

  const tail = tailRecordsResult(entry.path, entry.size, mtimeMs);
  let objective: string | null = null;
  let status: AgentGoal["status"] | null = null;
  let tokensUsed: number | null = null;
  let timeUsedSeconds: number | null = null;
  for (const obj of tail.records.reverse()) {
    const fragment = goalFragment(obj);
    if (!fragment) continue;
    if (status === null && fragment.status) status = fragment.status;
    if (objective === null && fragment.objective) objective = fragment.objective;
    if (tokensUsed === null && typeof fragment.tokensUsed === "number") tokensUsed = fragment.tokensUsed;
    if (timeUsedSeconds === null && typeof fragment.timeUsedSeconds === "number") timeUsedSeconds = fragment.timeUsedSeconds;
    if (status !== null && objective !== null && tokensUsed !== null) break;
  }
  const goal: AgentGoal | null = status === null && objective === null ? null : {
    objective,
    status: status ?? "active",
    tokensUsed,
    timeUsedSeconds,
  };
  if (tail.complete) goalCache.set(entry.path, [entry.size, mtimeMs, goal]);
  return goal;
}
