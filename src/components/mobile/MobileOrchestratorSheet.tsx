"use client";

import { Bot, LoaderCircle, RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { X } from "@/components/icons";
import { AgentLaunchControls, useAgentLaunchDraft, type LaunchEngine, type SpeedChoice } from "@/components/draft/AgentLaunchControls";
import { useModalLayer } from "@/components/modalLayer";
import { useKeyboardInset } from "@/hooks/useComposer";
import { engineBadge } from "@/components/utils";
import { useLocale, type MessageKey } from "@/lib/i18n";
import { ORCHESTRATOR_SPAWN_CONFIG, ORCHESTRATOR_SYSTEM_PROMPT } from "@/lib/orchestrator/prompt";
import type { FileEntry } from "@/lib/types";

import { orchestratorQuietBannerEligible, type OrchestratorPanelState, type RotationHint, type SeatTransition } from "../orchestrator/seatState";
import { readSeatDraftField, writeSeatDraftField } from "./orchestratorDraftStorage";
import { ROW_STATE_LABEL, ROW_TONE, orchestratorRowView } from "./orchestratorRowState";

/** Everything one confirm carries. The row owns the POST — and with it the one
    idempotency key per submission — so the sheet only reports what the operator
    chose. */
export interface SeatConfirmPayload {
  mandate: string;
  engine: LaunchEngine;
  model: string;
  effort: string;
  speed: SpeedChoice;
  accountId: string;
  /** Replay an EXISTING durable intent by its own key, for a designation whose
      accepting request died. The seat command completes THAT intent with its
      original mandate, so nothing here can become a second variant of it. */
  replayRequestId?: string | null;
}

/**
 * The phone's orchestrator sheet (PRD #976 slice C): the create draft, and
 * every seat state that is not «a conversation you can open».
 *
 * It is the same draft as the desktop dock — the shared launch module
 * (`useAgentLaunchDraft` + `AgentLaunchControls`), the same default mandate in
 * an editable textarea, the same `POST /api/orchestrator/seat` behind Confirm —
 * rendered as a fullscreen sheet in the pattern this codebase already uses for
 * one (`TaskSheet`, the focus view's map): `fixed inset-0`, its own header row,
 * one scrolling body, one primary action parked at the thumb.
 *
 * It never mounts a conversation. A seat that goes live while this is open
 * hands off to `MobileFocusView` (the row closes the sheet and pins the pane),
 * which is the operator's decision from the interview: the phone reads the
 * orchestrator in the standard focus view, not in a second chat surface.
 *
 * The keyboard is the phone's whole problem here — a large textarea plus an
 * on-screen keyboard is exactly the case #983 repaired for the focus root — so
 * the sheet budgets against the SAME `useKeyboardInset` signal rather than
 * measuring the viewport a second way. The footer action stays above the
 * keyboard, and the body scrolls under it.
 */
export function MobileOrchestratorSheet({
  project,
  projectName,
  projectCwd,
  state,
  file,
  pendingMandate,
  submitting,
  onConfirm,
  onRecheck,
  onOpenConversation,
  onClose,
}: {
  project: string;
  projectName: string;
  projectCwd?: string;
  state: OrchestratorPanelState;
  /** The seat conversation as the files feed knows it, when it does. */
  file: FileEntry | null;
  /** The pending intent's own mandate, replayed verbatim when a stuck
      designation is resumed. */
  pendingMandate: string;
  submitting: boolean;
  onConfirm: (payload: SeatConfirmPayload) => void;
  onRecheck: () => void;
  onOpenConversation: () => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const kbInset = useKeyboardInset();
  const sheetRef = useRef<HTMLFormElement>(null);
  const mandateBlockRef = useRef<HTMLDivElement>(null);
  const revealedRef = useRef(false);
  const [mandateFocused, setMandateFocused] = useState(false);
  const [mandate, setMandateState] = useState(() => readSeatDraftField(project, "mandate") || ORCHESTRATOR_SYSTEM_PROMPT);
  const [formError, setFormError] = useState<string | null>(null);
  const launch = useAgentLaunchDraft({
    storage: {
      read: (name) => readSeatDraftField(project, name),
      write: (name, value) => writeSeatDraftField(project, name, value),
    },
    initialEngine: ORCHESTRATOR_SPAWN_CONFIG.engine,
    initialModel: ORCHESTRATOR_SPAWN_CONFIG.model,
    initialEffort: ORCHESTRATOR_SPAWN_CONFIG.effort,
  });

  /* Full modal semantics through the shared layer stack: focus in on open, Tab
     trapped, Escape closes, body scroll locked, focus back to the row. */
  useModalLayer({ containerRef: sheetRef, onClose });

  /* The keyboard costs the body scroller most of its height, and everything
     above the mandate — an intent error's card, then engine/account/reasoning —
     can fill what is left, leaving the operator typing into a field below the
     scroller's own fold (#1004). So the field is brought to the top of the
     scroller once the keyboard is actually up: the block, not the textarea, so
     its label comes along.
     Both orders arrive here — focus first and the keyboard after (a tap), or
     the keyboard already up (focus moving in from another field) — because the
     condition is the state, not either event. It fires ONCE per typing session:
     after that the scroller is the operator's, and a keyboard that resizes
     under them never yanks it back. */
  useEffect(() => {
    if (!mandateFocused || kbInset <= 0) {
      revealedRef.current = false;
      return;
    }
    if (revealedRef.current) return;
    revealedRef.current = true;
    mandateBlockRef.current?.scrollIntoView({ block: "start" });
  }, [mandateFocused, kbInset]);

  const setMandate = (value: string) => {
    setMandateState(value);
    /* Stored only while it differs from the default, so an untouched draft
       follows the approved prompt forward instead of pinning today's copy. */
    writeSeatDraftField(project, "mandate", value === ORCHESTRATOR_SYSTEM_PROMPT ? "" : value);
  };

  const view = orchestratorRowView(state, { conversationReady: Boolean(file) });
  const drafting = state.kind === "draft" || state.kind === "intent-error";
  const params = {
    engine: launch.engine,
    model: launch.model,
    effort: launch.effort,
    speed: launch.speed,
    accountId: launch.launchAccountId,
  };

  const submitDraft = () => {
    const text = mandate.trim();
    if (!text) {
      setFormError(t("orchPanel.mandateRequired"));
      return;
    }
    setFormError(null);
    onConfirm({ ...params, mandate: text });
  };

  /* ONE primary action, parked at the thumb, whatever the state is. A sheet
     that can be opened on six different states and offers a way forward on
     only one of them is the dead end the panel's own design refuses. */
  const primary: { key: MessageKey; run: () => void; busy: boolean } | null = drafting
    ? { key: state.kind === "intent-error" ? "orchPanel.confirmRetry" : "orchPanel.confirm", run: submitDraft, busy: submitting }
    : state.kind === "creating"
      ? (!submitting && state.clientRequestId
        ? {
            key: "orchPanel.creatingResume",
            run: () => onConfirm({ ...params, mandate: pendingMandate || ORCHESTRATOR_SYSTEM_PROMPT, replayRequestId: state.clientRequestId }),
            busy: false,
          }
        : null)
      : state.kind === "unavailable"
        ? { key: "orchPanel.recheck", run: onRecheck, busy: false }
        : state.kind === "live" && file
          ? { key: "orchMobile.open", run: onOpenConversation, busy: false }
          : null;

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-canvas pb-[env(safe-area-inset-bottom)]"
      /* The keyboard's overlap with this full-height surface (#983). Inline so
         it wins over the safe-area padding above: with the keyboard up, the
         home indicator is behind it and the only inset that matters is this. */
      style={kbInset > 0 ? { paddingBottom: kbInset } : undefined}
      role="presentation"
    >
      <form
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("orchMobile.sheetAria", { project: projectName })}
        tabIndex={-1}
        data-testid="mobile-orchestrator-sheet"
        data-orchestrator-sheet-state={view.state}
        className="flex min-h-0 flex-1 flex-col focus-visible:outline-none"
        onSubmit={(event) => {
          event.preventDefault();
          primary?.run();
        }}
      >
        <header className="flex min-h-[52px] shrink-0 items-center gap-2 border-b border-border bg-card px-2 py-1.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent" aria-hidden>
            <Bot className="h-4 w-4" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-body font-semibold text-primary">{t("orchPanel.title")}</span>
            <span className="truncate text-caption text-muted" title={projectName}>{projectName}</span>
          </span>
          <span className={`shrink-0 rounded-full border px-2 py-0.5 text-caption font-semibold ${ROW_TONE[view.state].chip}`}>
            {t(ROW_STATE_LABEL[view.state])}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-control border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
          {state.kind === "loading" ? (
            <Centered>
              <LoaderCircle className="h-5 w-5 animate-spin text-muted" aria-hidden />
              <p className="text-ui text-muted" role="status">{t("orchPanel.loading")}</p>
            </Centered>
          ) : state.kind === "unavailable" ? (
            <Centered>
              <TriangleAlert className="h-6 w-6 text-warning" aria-hidden />
              <p className="text-body font-semibold text-primary" role="alert">{t("orchPanel.unavailable")}</p>
              <p className="text-ui leading-4 text-muted">{t("orchPanel.unavailableHint")}</p>
            </Centered>
          ) : state.kind === "creating" ? (
            <Centered>
              <LoaderCircle className="h-5 w-5 animate-spin text-accent" aria-hidden />
              <p className="text-body font-semibold text-primary" role="status">{t("orchPanel.creating")}</p>
              <p className="text-ui leading-4 text-muted">{t("orchPanel.creatingHint")}</p>
              {state.launchId ? (
                <p className="max-w-full truncate font-mono text-caption text-muted" title={state.launchId}>
                  {t("orchPanel.receipt", { launchId: state.launchId })}
                </p>
              ) : null}
              {/* Durably pending with nothing of ours on the wire: the request
                  that accepted it died, and only a re-post of its OWN key
                  converges it — the phone's most likely failure by far. */}
              {!submitting && state.clientRequestId ? (
                <p className="text-ui leading-4 text-muted">{t("orchPanel.creatingStuck")}</p>
              ) : null}
            </Centered>
          ) : state.kind === "live" ? (
            <LiveView state={state} file={file} />
          ) : (
            <>
              {state.kind === "intent-error" ? (
                <div className="shrink-0 rounded-surface border border-danger/40 bg-danger-soft px-3 py-2.5" role="alert" data-orchestrator-intent-error>
                  <p className="flex items-center gap-1.5 text-ui font-semibold text-danger">
                    <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />
                    {t(state.retry === "same" ? "orchPanel.errorUnknownTitle" : "orchPanel.errorTitle")}
                  </p>
                  <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words font-sans text-ui leading-4 text-secondary">
                    {state.error}
                  </pre>
                  <p className="mt-1 text-caption text-muted">
                    {t(state.retry === "same" ? "orchPanel.errorUnknownHint" : "orchPanel.errorHint")}
                  </p>
                </div>
              ) : (
                <div className="shrink-0">
                  <h2 className="text-title font-semibold text-primary">{t("orchPanel.draftTitle")}</h2>
                  <p className="mt-1 text-ui leading-4 text-muted">
                    {t(state.vacated ? "orchPanel.draftHintVacated" : "orchPanel.draftHint", { project: projectName })}
                  </p>
                </div>
              )}

              {/* The shared launch module, in the phone's own layout: the same
                  fields and the same invariants the dock has, lifted to 44px
                  touch targets from OUTSIDE the module — its own recipe
                  documents that the surrounding row owns the hit area. */}
              <div className="shrink-0 [&_button]:min-h-11 [&_select]:min-h-11">
                <AgentLaunchControls draft={launch} disabled={submitting} stacked />
              </div>

              <div ref={mandateBlockRef} className="flex min-h-[180px] flex-1 flex-col gap-1">
                <div className="flex min-h-11 items-center gap-2">
                  <label className="text-label font-semibold text-muted" htmlFor="mobile-orchestrator-mandate">
                    {t("orchPanel.mandate")}
                  </label>
                  {mandate !== ORCHESTRATOR_SYSTEM_PROMPT ? (
                    <button
                      type="button"
                      onClick={() => setMandate(ORCHESTRATOR_SYSTEM_PROMPT)}
                      disabled={submitting}
                      className="inline-flex min-h-11 items-center gap-1 rounded-control border border-border bg-card px-3 text-caption font-semibold text-muted hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
                    >
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden /> {t("orchPanel.restoreDefault")}
                    </button>
                  ) : null}
                  <span className="ml-auto shrink-0 text-caption text-muted">{t("orchPanel.mandateSent")}</span>
                </div>
                <textarea
                  id="mobile-orchestrator-mandate"
                  data-orchestrator-mandate
                  value={mandate}
                  disabled={submitting}
                  onChange={(event) => setMandate(event.target.value)}
                  onFocus={() => setMandateFocused(true)}
                  onBlur={() => setMandateFocused(false)}
                  spellCheck={false}
                  /* Prose the agent reads, so sans (design system §1.1); the
                     only mono here is the cwd caption, which is a path. */
                  className="min-h-[160px] w-full flex-1 resize-none rounded-surface border border-border bg-sunken px-3 py-2.5 text-ui leading-[1.45] text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
                />
                {projectCwd ? (
                  <p className="truncate font-mono text-caption text-muted" title={projectCwd}>
                    {t("orchPanel.cwd", { cwd: projectCwd })}
                  </p>
                ) : null}
              </div>
            </>
          )}
        </div>

        {primary ? (
          <div className="flex shrink-0 flex-col gap-2 border-t border-border bg-sunken px-3 py-2.5">
            {formError ? <p className="text-ui font-semibold text-danger" role="alert">{formError}</p> : null}
            <button
              type="submit"
              data-orchestrator-confirm
              disabled={primary.busy}
              className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-control border border-accent bg-accent px-3 text-body font-semibold text-white shadow-1 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
            >
              {primary.busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <Bot className="h-4 w-4" aria-hidden />}
              {t(primary.key)}
            </button>
          </div>
        ) : null}
      </form>
    </div>
  );
}

/** A seated orchestrator, read from the sheet rather than from its own chat:
    who it is, what is riding alongside it, and the one control that takes the
    operator into the conversation. */
function LiveView({ state, file }: { state: Extract<OrchestratorPanelState, { kind: "live" }>; file: FileEntry | null }) {
  const { t } = useLocale();
  const badge = file ? engineBadge(file) : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="shrink-0">
        <h2 className="text-title font-semibold text-primary">{t("orchMobile.liveTitle")}</h2>
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-ui text-muted">
          {badge ? (
            <span className="rounded-full px-2 py-0.5 text-caption font-semibold" style={badge.style}>{badge.label}</span>
          ) : null}
          {file?.model ? <span className="text-ui font-semibold text-secondary">{file.model}</span> : null}
          <span>{t(ROW_STATE_LABEL[state.liveness])}</span>
        </p>
      </div>
      {state.transition ? <TransitionCard transition={state.transition} /> : null}
      {state.rotation ? <RotationCard rotation={state.rotation} /> : null}
      {orchestratorQuietBannerEligible(state, file) ? <Note tone="warning">{t("orchPanel.stalled")}</Note> : null}
      {state.liveness === "resumable" ? <Note tone="quiet">{t("orchPanel.resumable")}</Note> : null}
      {file ? (
        <p className="text-ui leading-4 text-muted">{t("orchMobile.liveHint")}</p>
      ) : (
        /* Seated, but its transcript has not reached this device: say so, and
           keep the board deep link rather than a control that cannot act. */
        <Centered>
          <LoaderCircle className="h-5 w-5 animate-spin text-muted" aria-hidden />
          <p className="text-body font-semibold text-primary" role="status">{t("orchPanel.resolving")}</p>
          <p className="text-ui leading-4 text-muted">{t("orchPanel.resolvingHint")}</p>
          <a
            href={"#c=" + encodeURIComponent(state.conversationId)}
            className="inline-flex min-h-11 items-center text-ui font-semibold text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            {t("orchPanel.openOnBoard")}
          </a>
        </Centered>
      )}
    </div>
  );
}

function TransitionCard({ transition }: { transition: SeatTransition }) {
  const { t } = useLocale();
  if (transition.kind === "creating") {
    return (
      <p className="flex shrink-0 items-center gap-1.5 rounded-surface border border-accent/45 bg-accent-soft px-3 py-2 text-ui text-accent" role="status">
        <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
        {t("orchPanel.transitionPending")}
      </p>
    );
  }
  return (
    <div className="shrink-0 rounded-surface border border-danger/40 bg-danger-soft px-3 py-2" role="alert" data-orchestrator-intent-error>
      <p className="flex items-center gap-1.5 text-ui font-semibold text-danger">
        <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />
        {t("orchPanel.transitionFailed")}
      </p>
      <p className="mt-0.5 whitespace-pre-wrap break-words text-caption leading-4 text-secondary">{transition.error}</p>
    </div>
  );
}

/** The advisory and nothing more — rotation happens only when the operator asks
    for it, and the ask is slice B's (#978) own control on the desktop panel. */
function RotationCard({ rotation }: { rotation: RotationHint }) {
  const { t } = useLocale();
  return (
    <div className="shrink-0 rounded-surface border border-warning/45 bg-warning-soft px-3 py-2" role="status" data-orchestrator-rotation={rotation.level}>
      <p className="text-ui font-semibold text-warning">
        {t(rotation.level === "strongly_recommend" ? "orchPanel.rotationStrong" : "orchPanel.rotation")}
      </p>
      <p className="mt-0.5 text-caption leading-4 text-secondary">
        {rotation.reasons.map((reason) => (
          reason === "context"
            ? t("orchPanel.rotationContext", { percent: String(rotation.contextPercent ?? 0) })
            : t("orchPanel.rotationDead")
        )).join(" · ")}
      </p>
    </div>
  );
}

function Note({ tone, children }: { tone: "warning" | "quiet"; children: React.ReactNode }) {
  return (
    <p
      className={`shrink-0 rounded-surface px-3 py-2 text-ui ${tone === "warning" ? "bg-warning-soft text-warning" : "bg-sunken text-secondary"}`}
      role="status"
    >
      {children}
    </p>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center">{children}</div>
  );
}
