"use client";

import { useState } from "react";

import { Pause, Play, RefreshCw, Square, X } from "lucide-react";

import { type MessageKey, useLocale } from "@/lib/i18n";
import type { Flow, FlowAction } from "@/lib/flows/types";

import { ATTENTION_STATES, patchFlow, stateLabel, VERDICT_GLYPHS, verdictTone } from "./flowModel";

/* The one button the current state is waiting on, rendered prominent. */
const PENDING_ACTIONS: Partial<Record<Flow["state"], { labelKey: MessageKey; action: FlowAction }>> = {
  waiting_ready: { labelKey: "flowStrip.startReview", action: "advance" },
  spawn_pending: { labelKey: "flowStrip.spawnReviewer", action: "advance" },
  relay_pending: { labelKey: "flowStrip.relayNotes", action: "advance" },
  needs_decision: { labelKey: "flowStrip.retryRound", action: "retry-round" },
  done_comment: { labelKey: "flowStrip.anotherRound", action: "another-round" },
};

const BUSY_STATES: ReadonlySet<Flow["state"]> = new Set(["spawning", "reviewing", "relaying", "fixing"]);

function stateDot(flow: Flow): string {
  if (flow.state === "approved") return "bg-ok";
  if (flow.state === "needs_decision") return "bg-err";
  if (flow.state === "paused") return "bg-[#e0ae45]";
  if (BUSY_STATES.has(flow.state)) return "bg-ok animate-pulse";
  return "bg-[#9a9aa4]";
}

/**
 * The loop's shared header bar, spanning the implementer↔reviewer pair:
 * state cluster on the left, the round timeline in the middle, controls on
 * the right. All mutations go through PATCH /api/flows/:id; the poll
 * refresh carries the resulting state back.
 */
export function FlowStrip({ flow, onFocusRound }: { flow: Flow; onFocusRound?: (n: number) => void }) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const run = async (action: FlowAction, extra?: { mode?: "auto" | "manual"; rounds?: number; note?: string }) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const fail = await patchFlow(flow.id, { action, ...extra });
    if (fail) setError(fail);
    else if (extra?.note !== undefined) setNote("");
    setBusy(false);
  };

  const pending = PENDING_ACTIONS[flow.state];
  const attention = ATTENTION_STATES.has(flow.state);
  const closed = flow.state === "closed" || flow.state === "approved";
  /* The note rides along with the action that starts the next round. */
  const noteTakingAction = flow.state === "waiting_ready" || flow.state === "needs_decision";

  return (
    <div
      data-scheme-ui
      className={`pointer-events-auto flex h-11 w-full items-center gap-3 rounded-[14px] border bg-panel/95 px-4 shadow-[0_2px_10px_rgb(20_20_30/0.08)] ${
        attention ? "border-[#e0ae45]/70" : "border-line"
      }`}
    >
      {/* State cluster: dot, the FLOW mark, current state and its detail. */}
      <span className="flex min-w-0 max-w-[38%] shrink-0 items-center gap-2">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${stateDot(flow)}`} aria-hidden />
        <span className="shrink-0 text-[10.5px] font-bold tracking-[0.08em] text-dim">{t("flowStrip.flow")}</span>
        <span className="shrink-0 text-[12px] font-bold">{stateLabel(t, flow.state)}</span>
        {flow.stateDetail ? (
          <span className="min-w-0 truncate text-[11.5px] font-semibold text-dim" title={flow.stateDetail}>
            {flow.stateDetail}
          </span>
        ) : null}
      </span>

      {/* Round timeline, centered over the loop corridor. */}
      <span
        className="no-scrollbar flex min-w-0 flex-1 items-center justify-center gap-1.5 overflow-x-auto"
        aria-label={t("flowStrip.roundsAria")}
      >
        {flow.rounds.map((round, index) => {
          const tone = verdictTone(round.verdict);
          const live = round.verdict === null && !round.error;
          return (
            <span key={round.n} className="flex shrink-0 items-center gap-1.5">
              {index > 0 ? (
                <span className="text-[10px] font-bold text-[#c9c9d1]" aria-hidden>
                  →
                </span>
              ) : null}
              <button
                className={`inline-flex h-6 items-center gap-1 rounded-full px-2 text-[10.5px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                  live ? "animate-pulse" : ""
                }`}
                style={{ backgroundColor: tone.soft, color: tone.color }}
                title={
                  round.error
                    ? t("flowStrip.roundError", { n: round.n, error: round.error })
                    : round.verdict
                      ? t("flowStrip.roundVerdict", { n: round.n, verdict: round.verdict }) +
                        (round.findingsCount != null ? ` · ${t("roundDeck.findings", { count: round.findingsCount })}` : "")
                      : t("flowStrip.roundInProgress", { n: round.n })
                }
                onClick={() => onFocusRound?.(round.n)}
              >
                R{round.n}
                {round.verdict ? <span>{VERDICT_GLYPHS[round.verdict]}</span> : live ? <span>⏳</span> : <span>!</span>}
                {round.findingsCount != null && round.findingsCount > 0 ? <span>{round.findingsCount}</span> : null}
              </button>
            </span>
          );
        })}
      </span>

      {/* Control cluster. */}
      <span className="flex shrink-0 items-center gap-1.5">
        {error ? (
          <span className="max-w-[220px] truncate text-[10.5px] font-semibold text-err" title={error}>
            {error}
          </span>
        ) : null}
        {busy ? <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin text-dim" aria-hidden /> : null}
        {noteTakingAction ? (
          <input
            className="w-40 shrink-0 rounded-full border border-line bg-bg px-2.5 py-1 text-[10.5px] font-medium text-ink placeholder:text-dim/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            value={note}
            placeholder={t("flowStrip.notePlaceholder")}
            title={t("flowStrip.noteTitle")}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && pending) void run(pending.action, { note });
            }}
          />
        ) : null}
        {flow.state === "reviewing" ? (
          <button
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-err/40 bg-[#fbeaea] px-2.5 text-[10.5px] font-bold text-err hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
            disabled={busy}
            title={t("flowStrip.stopReviewerTitle")}
            onClick={() => void run("cancel-round")}
          >
            <Square className="h-3 w-3" aria-hidden /> {t("flowStrip.stopReviewer")}
          </button>
        ) : null}
        {pending ? (
          <button
            className="shrink-0 rounded-full border border-accent bg-accent px-3 py-1 text-[11px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40"
            disabled={busy}
            onClick={() => void run(pending.action, noteTakingAction ? { note } : undefined)}
          >
            {t(pending.labelKey)}
          </button>
        ) : null}
        {flow.state === "needs_decision" ? (
          <button
            className="shrink-0 rounded-full border border-line bg-bg px-2.5 py-1 text-[10.5px] font-semibold text-ink hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
            disabled={busy}
            title={t("flowStrip.addRoundsTitle")}
            onClick={() => void run("extend", { rounds: 2 })}
          >
            {t("flowStrip.plus2")}
          </button>
        ) : null}
        {closed ? null : (
          <>
            <button
              className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 ${
                flow.mode === "auto" ? "border-ok/40 bg-[#eef8f0] text-ok" : "border-line bg-bg text-dim hover:text-ink"
              }`}
              disabled={busy}
              title={flow.mode === "auto" ? t("flowStrip.autoTitle") : t("flowStrip.manualTitle")}
              onClick={() => void run("set-mode", { mode: flow.mode === "auto" ? "manual" : "auto" })}
            >
              {flow.mode === "auto" ? t("flowDialog.auto") : t("flowStrip.manualShort")}
            </button>
            {flow.state === "paused" ? (
              <button
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ok hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
                disabled={busy}
                title={t("flowStrip.resume")}
                aria-label={t("flowStrip.resume")}
                onClick={() => void run("resume")}
              >
                <Play className="h-3.5 w-3.5" aria-hidden />
              </button>
            ) : (
              <button
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-dim hover:bg-bg hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
                disabled={busy}
                title={t("flowStrip.pause")}
                aria-label={t("flowStrip.pause")}
                onClick={() => void run("pause")}
              >
                <Pause className="h-3.5 w-3.5" aria-hidden />
              </button>
            )}
          </>
        )}
        <button
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-dim hover:bg-bg hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
          disabled={busy}
          title={t("flowStrip.close")}
          aria-label={t("flowStrip.close")}
          onClick={() => void run("close")}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </span>
    </div>
  );
}
