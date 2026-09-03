"use client";

import { CornerDownRight, LoaderCircle, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { engineBadgeFor } from "@/components/utils";
import { useLocale } from "@/lib/i18n";
import { ORCHESTRATOR_PROMPT_VERSION, orchestratorMandateStale } from "@/lib/orchestrator/prompt";
import type { FileEntry } from "@/lib/types";

import type { LaunchAccountCatalog } from "@/components/draft/AgentLaunchControls";

import type { IncumbentContext, OrchestratorIncumbent } from "./incumbent";
import { ROTATION_CONTEXT_PERCENT } from "./seatState";

/**
 * WHO is holding the seat, above the conversation they are holding it with
 * (PRD #976 slice B).
 *
 * The operator could always see WHAT the orchestrator was saying and never who
 * it WAS: which engine, on which model, under which account, and how full its
 * context window had become. All of that already existed — inside
 * `get_orchestrator`, where only an agent could read it. This row is that
 * reading, in the one place the operator is already looking.
 *
 * It is also the only place rotation is offered. The advisory below states the
 * recommendation; the button here performs it, and ONLY when pressed.
 */
export function IncumbentHeader({
  incumbent,
  file,
  catalog,
  predecessorConversationId,
  promptVersion,
  rotating,
  opening,
  onRotate,
}: {
  /** The status read, once it has answered. */
  incumbent: OrchestratorIncumbent | null;
  /** The default version the seat's mandate is based on, null for bespoke
      rules. Shown only when it is behind the current default (#1452), the
      same reading `get_orchestrator` gives an agent. */
  promptVersion: number | null;
  /** The seat conversation as the board knows it — engine, model and context
      are on the card already, so the row is populated on the first paint
      instead of waiting out the slower status poll. */
  file: FileEntry | null;
  catalog: LaunchAccountCatalog | null;
  predecessorConversationId: string | null;
  rotating: boolean;
  /** The press landed and the incumbent's own parameters are being read, so the
      draft below opens PREFILLED rather than on the generic defaults. */
  opening: boolean;
  onRotate: () => void;
}) {
  const { t } = useLocale();
  const designated = incumbent?.designated ? incumbent : null;
  const engine = designated?.engine ?? (file?.engine === "claude" || file?.engine === "codex" ? file.engine : null);
  const model = designated?.model ?? file?.model ?? null;
  const effort = designated?.effort ?? null;
  const accountId = designated?.accountId ?? null;
  const account = accountId
    ? catalog?.[engine ?? "claude"]?.accounts.find((candidate) => candidate.id === accountId)?.label ?? accountId
    : null;
  const badge = engine ? engineBadgeFor(engine) : null;
  const context: IncumbentContext | null = designated?.context ?? boardContext(file);

  return (
    <div
      data-orchestrator-incumbent
      className="flex shrink-0 flex-col gap-1 border-b border-border bg-sunken px-3 py-1.5"
      aria-label={t("orchPanel.incumbentAria")}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {badge ? <Badge style={badge.style}>{badge.label}</Badge> : null}
        {model ? (
          /* A product name, so sans (design system §1.1 mono rule) — the tier
             rides with it because «opus» and «opus at high» are one answer to
             «what is this orchestrator». */
          <span className="min-w-0 shrink truncate text-ui font-semibold text-primary" title={effort ? `${model} · ${effort}` : model}>
            {model}
            {effort ? <span className="font-normal text-muted"> · {effort}</span> : null}
          </span>
        ) : (
          <span className="text-ui text-muted">{t("orchPanel.incumbentUnknown")}</span>
        )}
        {account ? (
          <Badge tone="neutral" shrinkable title={t("orchPanel.accountTitle", { account })}>
            <span className="min-w-0 truncate">{account}</span>
          </Badge>
        ) : null}
        <ContextMeter context={context} />
        {orchestratorMandateStale(promptVersion) ? (
          <span
            data-orchestrator-mandate-version={String(promptVersion)}
            className="shrink-0 text-caption font-semibold text-warning"
            title={t("orchPanel.mandateStaleTitle", { version: promptVersion, current: ORCHESTRATOR_PROMPT_VERSION })}
          >
            {t("orchPanel.mandateStale", { version: promptVersion, current: ORCHESTRATOR_PROMPT_VERSION })}
          </span>
        ) : null}
        <button
          type="button"
          data-orchestrator-rotate
          onClick={onRotate}
          disabled={rotating || opening}
          title={t("orchPanel.rotateTitle")}
          className="ml-auto inline-flex h-6 shrink-0 items-center gap-1 rounded-control border border-border bg-card px-2 text-caption font-semibold text-secondary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
        >
          {opening
            ? <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden />
            : <RefreshCw className="h-3 w-3" aria-hidden />}
          {t("orchPanel.rotate")}
        </button>
      </div>
      {predecessorConversationId ? (
        <a
          href={"#c=" + encodeURIComponent(predecessorConversationId)}
          data-orchestrator-predecessor={predecessorConversationId}
          title={t("orchPanel.predecessorTitle")}
          className="inline-flex min-w-0 items-center gap-1 self-start text-caption text-muted hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <CornerDownRight className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">{t("orchPanel.predecessor")}</span>
        </a>
      ) : null}
    </div>
  );
}

/** The board's own context read, in the status route's shape — what the header
    shows until the slower status poll answers with the server's reading.
    Exported for the phone's seat identity (issue #1347), which reads the same
    fallback so both surfaces show one number for one seat. */
export function boardContext(file: FileEntry | null): IncumbentContext | null {
  const ctx = file?.ctx;
  if (!ctx) return null;
  return {
    tokens: ctx.usedTokens,
    limit: ctx.windowTokens,
    percent: ctx.pct,
    estimated: ctx.confidence !== "exact",
    basis: "",
  };
}

/**
 * Context fullness, toned by the ROTATION policy rather than by a generic
 * fullness scale: the line that matters for an orchestrator is the one the
 * server would recommend rotating at, so the bar turns amber exactly there.
 *
 * An inferred number is marked «~» and says why in its own tooltip — a guess
 * must never be readable as a provider-reported count.
 *
 * The DESKTOP's meter, and only the desktop's: it fills with what is USED,
 * which is the dock's own reading. The phone fills every meter with what
 * REMAINS (mobile v2 §5), so the seat sheet there renders `MobileMeter`
 * instead — one semantic per surface, stated rather than shared by accident.
 */
function ContextMeter({ context }: { context: IncumbentContext | null }) {
  const { t } = useLocale();
  if (!context || context.tokens === null) return null;
  const { percent, estimated } = context;
  const tone = percent === null || percent < ROTATION_CONTEXT_PERCENT
    ? { text: "text-secondary", bar: "bg-secondary/50" }
    : percent >= 90
      ? { text: "text-danger", bar: "bg-danger" }
      : { text: "text-warning", bar: "bg-warning" };
  const title = [
    percent === null
      ? t("orchPanel.ctxUnknownWindow", { used: context.tokens.toLocaleString("en-US") })
      : t("orchPanel.ctxTitle", {
        percent: String(percent),
        used: context.tokens.toLocaleString("en-US"),
        window: (context.limit ?? 0).toLocaleString("en-US"),
      }),
    context.basis,
  ].filter(Boolean).join("\n");

  return (
    <span
      data-orchestrator-context={percent === null ? "unknown" : String(percent)}
      className="inline-flex shrink-0 items-center gap-1"
      title={title}
      aria-label={percent === null ? t("orchPanel.ctxAriaUnknown") : t("orchPanel.ctxAria", { percent: String(percent) })}
    >
      <span className={`text-caption font-semibold tabular-nums ${tone.text}`}>
        {estimated ? "~" : ""}
        {percent === null ? shortTokens(context.tokens) : `${percent}%`}
      </span>
      {percent === null ? null : (
        <span className="h-1 w-8 overflow-hidden rounded-full bg-border" aria-hidden>
          <span className={`block h-full rounded-full ${tone.bar}`} style={{ width: `${Math.min(100, percent)}%` }} />
        </span>
      )}
    </span>
  );
}

/** 176_000 → «176K», the chip face's own shortening (`PlanChip`). */
function shortTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${millions >= 10 || Number.isInteger(millions) ? Math.round(millions) : Math.round(millions * 10) / 10}M`;
  }
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : `${tokens}`;
}
