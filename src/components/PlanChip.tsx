"use client";

import type { AgentGoal, AgentPlan } from "@/lib/types";

const STEP_GLYPHS: Record<AgentPlan["steps"][number]["status"], string> = {
  completed: "✓",
  in_progress: "▸",
  pending: "○",
};

export function planTooltip(plan: AgentPlan): string {
  const lines = plan.steps.map((step) => `${STEP_GLYPHS[step.status]} ${step.text}`);
  return ["План агента:", ...lines].join("\n");
}

/**
 * Compact plan progress in a pane header: done/total plus a slim bar. The
 * full step list (with the current goal marked ▸) lives in the tooltip — the
 * header has no room for more, and the switchboard already spells the goal out.
 */
export function PlanChip({ plan }: { plan: AgentPlan }) {
  const percent = plan.total ? Math.round((plan.done / plan.total) * 100) : 0;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#f1f0fc] px-1.5 py-0.5 font-mono text-[9.5px] font-semibold text-accent"
      title={planTooltip(plan)}
      aria-label={`План: ${plan.done} з ${plan.total} кроків${plan.current ? `, зараз: ${plan.current}` : ""}`}
    >
      {plan.done}/{plan.total}
      <span className="h-1 w-6 overflow-hidden rounded-full bg-accent/20" aria-hidden>
        <span className="block h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
      </span>
    </span>
  );
}

const GOAL_TONES: Record<AgentGoal["status"], { label: string; className: string }> = {
  active: { label: "ціль", className: "bg-[#f1f0fc] text-accent" },
  complete: { label: "ціль ✓", className: "bg-[#e7f4ea] text-ok" },
  blocked: { label: "ціль ✖", className: "bg-[#fbeaea] text-err" },
};

function goalTooltip(goal: AgentGoal): string {
  const lines = [goal.objective ?? "(objective не записаний у хвості транскрипта)"];
  if (goal.tokensUsed !== null) lines.push(`токенів: ${goal.tokensUsed.toLocaleString("uk-UA")}`);
  if (goal.timeUsedSeconds !== null) lines.push(`часу: ${Math.round(goal.timeUsedSeconds / 60)} хв`);
  return lines.join("\n");
}

/** Codex thread-goal state in a pane header: status-colored chip, the
    objective and usage numbers in the tooltip. */
export function GoalChip({ goal }: { goal: AgentGoal }) {
  const tone = GOAL_TONES[goal.status];
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold ${tone.className}`}
      title={goalTooltip(goal)}
      aria-label={`Ціль сесії: ${goal.status}${goal.objective ? ` — ${goal.objective.slice(0, 120)}` : ""}`}
    >
      {tone.label}
    </span>
  );
}
