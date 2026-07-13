"use client";

import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { getLocale, translate, useLocale } from "@/lib/i18n";
import type { AgentGoal, AgentPlan, CtxUsage } from "@/lib/types";

const bcp47 = () => (getLocale() === "uk" ? "uk-UA" : "en-US");

const STEP_GLYPHS: Record<AgentPlan["steps"][number]["status"], string> = {
  completed: "✓",
  in_progress: "▸",
  pending: "○",
};

export function planTooltip(plan: AgentPlan): string {
  const lines = plan.steps.map((step) => `${STEP_GLYPHS[step.status]} ${step.text}`);
  return [translate(getLocale(), "plan.agentPlan"), ...lines].join("\n");
}

/**
 * Compact plan progress in a pane header: done/total plus a slim bar. The
 * full step list (with the current goal marked ▸) lives in the tooltip — the
 * header has no room for more, and the switchboard already spells the goal out.
 */
export function PlanChip({ plan }: { plan: AgentPlan }) {
  const { t } = useLocale();
  const percent = plan.total ? Math.round((plan.done / plan.total) * 100) : 0;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-1.5 py-0.5 font-mono text-[9.5px] font-semibold text-accent"
      title={planTooltip(plan)}
      aria-label={t("plan.stepsAria", { done: plan.done, total: plan.total }) + (plan.current ? t("plan.nowSuffix", { current: plan.current }) : "")}
    >
      {plan.done}/{plan.total}
      <span className="h-1 w-6 overflow-hidden rounded-full bg-accent/20" aria-hidden>
        <span className="block h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
      </span>
    </span>
  );
}

const GOAL_TONES: Record<AgentGoal["status"], { labelKey: "plan.goal" | "plan.goalDone" | "plan.goalBlocked"; tone: BadgeTone }> = {
  active: { labelKey: "plan.goal", tone: "accent" },
  complete: { labelKey: "plan.goalDone", tone: "success" },
  blocked: { labelKey: "plan.goalBlocked", tone: "danger" },
};

function goalTooltip(goal: AgentGoal): string {
  const locale = getLocale();
  const lines = [goal.objective ?? translate(locale, "plan.noObjective")];
  if (goal.tokensUsed !== null) lines.push(translate(locale, "plan.tokens", { n: goal.tokensUsed.toLocaleString(bcp47()) }));
  if (goal.timeUsedSeconds !== null) lines.push(translate(locale, "plan.time", { n: Math.round(goal.timeUsedSeconds / 60) }));
  return lines.join("\n");
}

/* Same escalation points as the sidebar limit bars: calm, then amber, then red. */
function ctxTone(pct: number | null): BadgeTone {
  if (pct === null) return "neutral";
  if (pct >= 90) return "danger";
  if (pct >= 70) return "warning";
  return "neutral";
}

/* Token counts shortened for the chip face: 176_000 → «176K», 1_000_000 → «1M»,
   1_200_000 → «1.2M». The exact figures stay in the tooltip. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) || m >= 10 ? Math.round(m) : Math.round(m * 10) / 10}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return `${n}`;
}

/** Context-window fullness of an agent: «ctx 176K / 200K» (used of window),
    the percentage still drives the tone and the exact token counts live in the
    tooltip. Rendered wherever the agent is shown (pane header, switch cards). */
export function CtxChip({ ctx }: { ctx: CtxUsage }) {
  const { t } = useLocale();
  const used = ctx.usedTokens.toLocaleString(bcp47());
  let title: string;
  let ariaLabel: string;
  if (ctx.windowTokens !== null && ctx.pct !== null) {
    const source = ctx.source === "registry"
      ? t("plan.ctxSourceRegistry", { version: ctx.registryVersion ?? "?" })
      : t("plan.ctxSourceRuntime");
    title = `${t("plan.ctxTitle", { pct: ctx.pct, used, window: ctx.windowTokens.toLocaleString(bcp47()) })}\n${source}`;
    ariaLabel = t("plan.ctxAria", { pct: ctx.pct });
  } else {
    title = t("plan.ctxTitleUnknown", { used });
    ariaLabel = t("plan.ctxAriaUnknown", { used });
  }
  return (
    <Badge tone={ctxTone(ctx.pct)} title={title} aria-label={ariaLabel}>
      ctx {fmtTokens(ctx.usedTokens)}
      {ctx.windowTokens === null ? null : (
        <>
          <span className="opacity-50">/</span>
          {fmtTokens(ctx.windowTokens)}
        </>
      )}
    </Badge>
  );
}

/** Codex thread-goal state in a pane header: status-colored chip, the
    objective and usage numbers in the tooltip. */
export function GoalChip({ goal }: { goal: AgentGoal }) {
  const { t } = useLocale();
  const goalTone = GOAL_TONES[goal.status];
  return (
    <Badge
      tone={goalTone.tone}
      title={goalTooltip(goal)}
      aria-label={t("plan.goalAria", { status: t(goalTone.labelKey) }) + (goal.objective ? ` — ${goal.objective.slice(0, 120)}` : "")}
    >
      {t(goalTone.labelKey)}
    </Badge>
  );
}
