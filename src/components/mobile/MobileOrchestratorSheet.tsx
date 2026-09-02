"use client";

import { Bot, CornerDownRight, LoaderCircle, RefreshCw, RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { X } from "@/components/icons";
import {
  AgentLaunchControls,
  useAgentLaunchDraft,
  type LaunchAccountCatalog,
  type LaunchEngine,
  type SpeedChoice,
} from "@/components/draft/AgentLaunchControls";
import { useModalLayer } from "@/components/modalLayer";
import { Badge } from "@/components/ui/Badge";
import { useKeyboardInset } from "@/hooks/useComposer";
import { engineBadgeFor } from "@/components/utils";
import { useLocale, type MessageKey } from "@/lib/i18n";
import { ORCHESTRATOR_PROMPT_VERSION, ORCHESTRATOR_SPAWN_CONFIG, ORCHESTRATOR_SYSTEM_PROMPT, orchestratorMandateStale } from "@/lib/orchestrator/prompt";
import type { OrchestratorSeat } from "@/lib/orchestrator/seats";
import type { FileEntry } from "@/lib/types";

import { boardContext, ContextMeter } from "../orchestrator/IncumbentHeader";
import type { OrchestratorIncumbent } from "../orchestrator/incumbent";
import {
  deriveRotateDraftState,
  mandateSummaryOf,
  orchestratorQuietBannerEligible,
  rotateMandateBase,
  type OrchestratorPanelState,
  type OrchestratorSeatStatus,
  type RotationHint,
  type SeatSubmitFailure,
  type SeatTransition,
} from "../orchestrator/seatState";
import type { SeatConfirmLaunch } from "../orchestrator/useSeatConfirm";
import { readSeatDraftField, readSeatFlowField, writeSeatDraftField, writeSeatFlowField } from "./orchestratorDraftStorage";
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
 * The rotate flow as the sheet sees it (issue #1347). The row owns the state —
 * the durable confirm on `POST /api/orchestrator/rotate`, the incumbent read
 * the draft prefills from, and which conversation the open draft is replacing
 * — and the sheet renders it, exactly as the dock's panel does for the desktop.
 */
export interface SeatRotateFlow {
  /** The rotate draft is showing, over the live view. */
  open: boolean;
  /** The seat the draft replaces: the live one, or — after its conversation was
      closed while the rotation was still in the air — the vacated record the
      rotation is still settling against. Null when nothing is being rotated. */
  seat: OrchestratorSeat | null;
  /** The seat's conversation was closed while this rotation is in flight. */
  vacated: boolean;
  /** The press landed and the incumbent's own parameters are being re-read, so
      the draft opens PREFILLED rather than on the generic defaults. */
  opening: boolean;
  submitting: boolean;
  failure: SeatSubmitFailure | null;
  onOpen: () => void;
  onCancel: () => void;
  onConfirm: (input: { body: Record<string, unknown>; launch: SeatConfirmLaunch }) => void;
}

/**
 * The phone's orchestrator sheet (PRD #976 slice C): the create draft, every
 * seat state that is not «a conversation you can open» — and, since #1347, the
 * seat's CONTROLS for the state that is.
 *
 * It is the same draft as the desktop dock — the shared launch module
 * (`useAgentLaunchDraft` + `AgentLaunchControls`), the same default mandate in
 * an editable textarea, the same `POST /api/orchestrator/seat` behind Confirm —
 * rendered as a fullscreen sheet in the pattern this codebase already uses for
 * one (`TaskSheet`, the focus view's map): `fixed inset-0`, its own header row,
 * one scrolling body, one primary action parked at the thumb.
 *
 * On a live seat it is what the dock's incumbent header is on the desktop: who
 * holds the seat (engine, model at tier, account, context fullness), the
 * lineage it replaced, the mandate it runs under, and the one control that
 * acts on it — Rotate, which opens the SAME draft prefilled from the incumbent
 * (engine, model, reasoning, account, mandate) over the seat it would replace,
 * with its own two-way footer: keep this one, or rotate. The operator asked for
 * these from a phone and could not find them (#1347): the row's tap opened the
 * conversation and nothing else. Nothing here rotates on its own.
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
 * keyboard, and the body scrolls under it. Both safe-area insets are padded:
 * the header's controls clear the notch, the footer clears the home indicator.
 */
export function MobileOrchestratorSheet({
  project,
  projectName,
  projectCwd,
  state,
  status,
  file,
  incumbent,
  pendingMandate,
  viewerMcpRegistered,
  submitting,
  rotate,
  onConfirm,
  onRecheck,
  onOpenConversation,
  onClose,
}: {
  project: string;
  projectName: string;
  projectCwd?: string;
  state: OrchestratorPanelState;
  /** The seat read itself, for the rotate draft's own error state. */
  status: OrchestratorSeatStatus | null;
  /** The seat conversation as the files feed knows it, when it does. */
  file: FileEntry | null;
  /** The status read for the CURRENT seat, once it has answered; null keeps
      the identity on what the board itself knows about the conversation. */
  incumbent: OrchestratorIncumbent | null;
  /** The pending intent's own mandate, replayed verbatim when a stuck
      designation is resumed. */
  pendingMandate: string;
  viewerMcpRegistered: boolean;
  submitting: boolean;
  rotate: SeatRotateFlow;
  onConfirm: (payload: SeatConfirmPayload) => void;
  onRecheck: () => void;
  onOpenConversation: () => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const kbInset = useKeyboardInset();
  const sheetRef = useRef<HTMLFormElement>(null);
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

  const setMandate = (value: string) => {
    setMandateState(value);
    /* Stored only while it differs from the default, so an untouched draft
       follows the approved prompt forward instead of pinning today's copy. */
    writeSeatDraftField(project, "mandate", value === ORCHESTRATOR_SYSTEM_PROMPT ? "" : value);
  };

  const view = orchestratorRowView(state, { conversationReady: Boolean(file) });
  const drafting = state.kind === "draft" || state.kind === "intent-error";
  const rotating = rotate.open && rotate.seat !== null;
  const mode = rotating ? "rotate" : state.kind === "live" ? "live" : "create";
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
     only one of them is the dead end the panel's own design refuses. The rotate
     draft brings its own footer — two ways out, keep or rotate — so it takes
     the slot over. */
  const primary: { key: MessageKey; run: () => void; busy: boolean } | null = rotating
    ? null
    : drafting
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
      className="fixed inset-0 z-[60] flex flex-col bg-canvas pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
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
        data-orchestrator-sheet-mode={mode}
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

        {rotating && rotate.seat ? (
          <RotateDraft
            project={project}
            seat={rotate.seat}
            vacated={rotate.vacated}
            incumbent={incumbent}
            file={file}
            projectCwd={projectCwd}
            catalog={launch.catalog}
            status={status}
            viewerMcpRegistered={viewerMcpRegistered}
            submitting={rotate.submitting}
            failure={rotate.failure}
            onConfirm={rotate.onConfirm}
            onCancel={rotate.onCancel}
          />
        ) : (
          <>
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
                <LiveView state={state} file={file} incumbent={incumbent} catalog={launch.catalog} rotate={rotate} />
              ) : (
                <>
                  {state.kind === "intent-error" ? (
                    <IntentError error={state.error} retry={state.retry} rotate={false} />
                  ) : (
                    <div className="shrink-0">
                      <h2 className="text-title font-semibold text-primary">{t("orchPanel.draftTitle")}</h2>
                      {state.vacated ? (
                        <p className="mt-1 text-ui leading-4 text-muted">
                          {t("orchPanel.draftHintVacated", { project: projectName })}
                        </p>
                      ) : null}
                    </div>
                  )}

                  {/* The dock's own intro, word for word (#1163): the phone meets
                      this draft in the same three sentences, so what an orchestrator
                      is never depends on which surface you created it from. */}
                  <p className="shrink-0 text-ui leading-5 text-secondary" data-orchestrator-intro>
                    {t("orchPanel.introTalk")}{" "}
                    {t("orchPanel.introRuns")}{" "}
                    {t("orchPanel.introReports")}
                  </p>

                  <ViewerMcpStatus registered={viewerMcpRegistered} />

                  {/* The shared launch module, in the phone's own layout: the same
                      fields and the same invariants the dock has, lifted to 44px
                      touch targets from OUTSIDE the module — its own recipe
                      documents that the surrounding row owns the hit area. */}
                  <div className="shrink-0 [&_button]:min-h-11 [&_select]:min-h-11">
                    <AgentLaunchControls draft={launch} disabled={submitting} stacked />
                  </div>

                  <MandateField
                    id="mobile-orchestrator-mandate"
                    value={mandate}
                    disabled={submitting}
                    edited={mandate !== ORCHESTRATOR_SYSTEM_PROMPT}
                    caption={mandateSummaryOf(mandate, null)}
                    restoreKey="orchPanel.restoreDefault"
                    onChange={setMandate}
                    onRestore={() => setMandate(ORCHESTRATOR_SYSTEM_PROMPT)}
                    cwdLine={projectCwd ? t("orchPanel.cwd", { cwd: projectCwd }) : null}
                  />
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
          </>
        )}
      </form>
    </div>
  );
}

/**
 * The rotate draft on the phone (issue #1347): the SAME form the dock opens,
 * prefilled with the incumbent's own parameters, over the seat it would replace.
 *
 * Mounted only while it is open, which is what makes «prefilled» true: the
 * launch draft reads its initial engine/model/effort/account through the
 * injected storage, so the incumbent's values are the defaults and the
 * operator's edits are what persist over them — under the dock's own Rotate
 * keys, so a rotation half-written on one surface continues on the other.
 *
 * The handoff is NOT composed here. `POST /api/orchestrator/rotate` hands the
 * successor its predecessor's transcript path and the project's open tasks; the
 * text in this textarea is the MANDATE, and duplicating the handoff into it
 * would deliver the same instructions twice in two wordings.
 */
function RotateDraft({
  project,
  seat,
  vacated,
  incumbent,
  file,
  projectCwd,
  catalog,
  status,
  viewerMcpRegistered,
  submitting,
  failure,
  onConfirm,
  onCancel,
}: {
  project: string;
  seat: OrchestratorSeat;
  vacated: boolean;
  incumbent: OrchestratorIncumbent | null;
  file: FileEntry | null;
  projectCwd?: string;
  catalog: LaunchAccountCatalog | null;
  status: OrchestratorSeatStatus | null;
  viewerMcpRegistered: boolean;
  submitting: boolean;
  failure: SeatSubmitFailure | null;
  onConfirm: SeatRotateFlow["onConfirm"];
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const [formError, setFormError] = useState<string | null>(null);
  /* The text starts from the CURRENT default when the incumbent's mandate is
     based on an older version (#1452), the same rule the dock's draft applies;
     the incumbent's own text is one tap away, and a seat on the current
     version, or on bespoke rules, keeps its text. */
  const base = rotateMandateBase(seat);
  const staleVersion = orchestratorMandateStale(seat.promptVersion) ? seat.promptVersion : null;
  const [mandate, setMandateState] = useState(() => readSeatFlowField("Rotate", project, "mandate") || base);
  const setMandate = (value: string) => {
    setMandateState(value);
    writeSeatFlowField("Rotate", project, "mandate", value === base ? "" : value);
  };
  /* «Prefilled» in the operator's words: what the incumbent is ACTUALLY running
     on, read through the launch module's own storage seam rather than by forking
     it. Only the initializers call `read`, so switching engine here is never
     re-defaulted back to the predecessor's account or model. */
  const inherited: Record<string, string> = {
    engine: incumbent?.engine ?? (file?.engine === "codex" ? "codex" : file?.engine === "claude" ? "claude" : ""),
    model: incumbent?.model ?? file?.model ?? "",
    effort: incumbent?.effort ?? "",
    accountId: incumbent?.accountId ?? "",
  };
  const launch = useAgentLaunchDraft({
    storage: {
      read: (name) => readSeatFlowField("Rotate", project, name) || (inherited[name] ?? ""),
      write: (name, value) => writeSeatFlowField("Rotate", project, name, value),
    },
    catalog,
    initialEngine: ORCHESTRATOR_SPAWN_CONFIG.engine,
    initialModel: ORCHESTRATOR_SPAWN_CONFIG.model,
    initialEffort: ORCHESTRATOR_SPAWN_CONFIG.effort,
  });
  const state = deriveRotateDraftState({ status, submitFailure: failure });
  const errored = state.kind === "intent-error";
  /* The successor inherits the predecessor's checkout unless the operator says
     otherwise — so the rotate body carries no cwd at all, and the row below
     states which directory that is (issue #903). */
  const cwd = (incumbent?.cwd ?? null) ?? projectCwd;

  const confirm = () => {
    /* Emptiness is the only question trim answers here — the successor's
       mandate is posted exactly as it was typed. */
    if (!mandate.trim()) {
      setFormError(t("orchPanel.mandateRequired"));
      return;
    }
    setFormError(null);
    onConfirm({
      body: {
        project,
        mandate,
        engine: launch.engine,
        ...(launch.model ? { model: launch.model } : {}),
        ...(launch.effort ? { effort: launch.effort } : {}),
        ...(launch.engine === "codex" && launch.speed ? { fast: launch.speed === "fast" } : {}),
        ...(launch.launchAccountId ? { accountId: launch.launchAccountId } : {}),
      },
      launch: { draft: launch, cwd: cwd ?? "", firstMessage: mandate },
    });
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3" data-orchestrator-draft="rotate">
        {/* The seat's card was closed while this rotation was still in the air.
            The rotation is the live question, so it keeps the surface — with
            the vacancy stated above it — until it says where it landed. */}
        {vacated ? <Note tone="quiet">{t("orchPanel.rotateVacated")}</Note> : null}
        {errored ? (
          <IntentError error={state.error} retry={state.retry} rotate />
        ) : (
          <div className="shrink-0">
            <h2 className="text-title font-semibold text-primary">{t("orchPanel.rotateHeading")}</h2>
            <p className="mt-1 text-ui leading-4 text-muted">{t("orchPanel.rotateHint")}</p>
          </div>
        )}

        <ViewerMcpStatus registered={viewerMcpRegistered} />

        {/* The seat's settings — engine, account, model and reasoning — as the
            same shared module the create draft mounts, at the phone's 44px
            targets. What the operator adjusts here is what the successor runs
            on. */}
        <div className="shrink-0 [&_button]:min-h-11 [&_select]:min-h-11">
          <AgentLaunchControls draft={launch} disabled={submitting} stacked />
        </div>

        <MandateField
          id="mobile-orchestrator-rotate-mandate"
          value={mandate}
          disabled={submitting}
          edited={mandate !== base}
          caption={mandateSummaryOf(mandate, seat)}
          keepIncumbent={staleVersion !== null && mandate !== seat.mandate
            ? { version: staleVersion, onKeep: () => setMandate(seat.mandate) }
            : null}
          restoreKey={staleVersion === null ? "orchPanel.restoreIncumbent" : "orchPanel.restoreDefault"}
          onChange={setMandate}
          onRestore={() => setMandate(base)}
          cwdLine={cwd ? t("orchPanel.cwdInherited", { cwd }) : null}
        />
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-border bg-sunken px-3 py-2.5">
        {formError ? <p className="text-ui font-semibold text-danger" role="alert">{formError}</p> : null}
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-orchestrator-rotate-cancel
            onClick={onCancel}
            disabled={submitting}
            className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-control border border-border bg-card px-3 text-ui font-semibold text-secondary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
          >
            {t("orchPanel.rotateCancel")}
          </button>
          {/* Its own button, not the form's submit: the sheet's submit is the
              live view's «open the conversation», and a rotation must never be
              what an Enter in some other field triggers. */}
          <button
            type="button"
            data-orchestrator-confirm
            onClick={confirm}
            disabled={submitting}
            className="inline-flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-control border border-accent bg-accent px-3 text-body font-semibold text-white shadow-1 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
          >
            {submitting ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
            <span className="truncate">{t(errored ? "orchPanel.confirmRetry" : "orchPanel.rotateConfirm")}</span>
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * The mandate textarea, with the one behaviour the phone needs from it: the
 * keyboard costs the body scroller most of its height, and everything above the
 * mandate — an intent error's card, then engine/account/reasoning — can fill
 * what is left, leaving the operator typing into a field below the scroller's
 * own fold (#1004). So the field is brought to the top of the scroller once the
 * keyboard is actually up: the block, not the textarea, so its label comes
 * along.
 *
 * Both orders arrive here — focus first and the keyboard after (a tap), or the
 * keyboard already up (focus moving in from another field) — because the
 * condition is the state, not either event. It fires ONCE per typing session:
 * after that the scroller is the operator's, and a keyboard that resizes under
 * them never yanks it back. Shared by the create and the rotate drafts, so both
 * are typed into the same way.
 */
function MandateField({
  id,
  value,
  disabled,
  edited,
  caption,
  keepIncumbent = null,
  restoreKey,
  onChange,
  onRestore,
  cwdLine,
}: {
  id: string;
  value: string;
  disabled: boolean;
  edited: boolean;
  /** What the text IS — the built-in default, the incumbent's, or the
      operator's own — the same line the dock folds its rules behind. */
  caption: ReturnType<typeof mandateSummaryOf>;
  /** A rotation over a stale incumbent (#1452): its version, and the tap that
      puts its own text back in the box. Null when there is nothing to offer. */
  keepIncumbent?: { version: number; onKeep: () => void } | null;
  restoreKey: MessageKey;
  onChange: (value: string) => void;
  onRestore: () => void;
  cwdLine: string | null;
}) {
  const { t } = useLocale();
  const kbInset = useKeyboardInset();
  const blockRef = useRef<HTMLDivElement>(null);
  const revealedRef = useRef(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused || kbInset <= 0) {
      revealedRef.current = false;
      return;
    }
    if (revealedRef.current) return;
    revealedRef.current = true;
    blockRef.current?.scrollIntoView({ block: "start" });
  }, [focused, kbInset]);

  return (
    <div ref={blockRef} className="flex min-h-[180px] flex-1 flex-col gap-1">
      <div className="flex min-h-11 items-center gap-2">
        <label className="text-label font-semibold text-muted" htmlFor={id}>
          {t("orchPanel.mandate")}
        </label>
        {edited ? (
          <button
            type="button"
            onClick={onRestore}
            disabled={disabled}
            className="inline-flex min-h-11 items-center gap-1 rounded-control border border-border bg-card px-3 text-caption font-semibold text-muted hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> {t(restoreKey)}
          </button>
        ) : null}
        <span className="ml-auto shrink-0 text-caption text-muted">{t("orchPanel.mandateSent")}</span>
      </div>
      <p data-orchestrator-mandate-kind className="text-caption leading-4 text-muted">{t(caption.key, caption.params)}</p>
      {keepIncumbent ? (
        <div
          className="flex flex-col gap-1.5 rounded-control border border-warning/45 bg-warning-soft px-3 py-2 text-ui leading-4 text-secondary"
          data-orchestrator-mandate-stale={String(keepIncumbent.version)}
        >
          <span>{t("orchPanel.rotateStaleMandate", { version: keepIncumbent.version, current: ORCHESTRATOR_PROMPT_VERSION })}</span>
          <button
            type="button"
            data-orchestrator-keep-incumbent
            onClick={keepIncumbent.onKeep}
            disabled={disabled}
            className="inline-flex min-h-11 items-center justify-center gap-1 self-start rounded-control border border-border bg-card px-3 text-caption font-semibold text-secondary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
          >
            {t("orchPanel.keepIncumbentMandate", { version: keepIncumbent.version })}
          </button>
        </div>
      ) : null}
      <textarea
        id={id}
        data-orchestrator-mandate
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        spellCheck={false}
        /* Prose the agent reads, so sans (design system §1.1); the only mono
           here is the cwd caption, which is a path. */
        className="min-h-[160px] w-full flex-1 resize-none rounded-surface border border-border bg-sunken px-3 py-2.5 text-ui leading-[1.45] text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
      />
      {cwdLine ? (
        <p className="truncate font-mono text-caption text-muted" title={cwdLine}>
          {cwdLine}
        </p>
      ) : null}
    </div>
  );
}

/** A seated orchestrator, read from the sheet rather than from its own chat:
    who it is, what is riding alongside it, the rules it runs under, and the
    controls the desktop header carries — Rotate first among them. The one
    control that takes the operator INTO the conversation stays the footer's. */
function LiveView({
  state,
  file,
  incumbent,
  catalog,
  rotate,
}: {
  state: Extract<OrchestratorPanelState, { kind: "live" }>;
  file: FileEntry | null;
  incumbent: OrchestratorIncumbent | null;
  catalog: LaunchAccountCatalog | null;
  rotate: SeatRotateFlow;
}) {
  const { t } = useLocale();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="shrink-0">
        <h2 className="text-title font-semibold text-primary">{t("orchMobile.liveTitle")}</h2>
        <p className="mt-1 text-ui text-muted">{t(ROW_STATE_LABEL[state.liveness])}</p>
      </div>
      <SeatIdentity incumbent={incumbent} file={file} catalog={catalog} predecessorConversationId={state.seat.predecessorConversationId} />
      {/* Rotate: a control, and only a control. The advisory below states the
          recommendation; this performs it, and ONLY when pressed and then
          confirmed in the draft it opens. */}
      <div className="flex shrink-0 flex-col gap-1">
        <button
          type="button"
          data-orchestrator-rotate
          onClick={rotate.onOpen}
          disabled={rotate.opening || rotate.submitting}
          title={t("orchPanel.rotateTitle")}
          className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-control border border-border bg-card px-3 text-body font-semibold text-primary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
        >
          {rotate.opening
            ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
            : <RefreshCw className="h-4 w-4" aria-hidden />}
          {t(rotate.opening ? "orchMobile.rotateOpening" : "orchPanel.rotate")}
        </button>
        <p className="text-caption leading-4 text-muted">{t("orchPanel.rotateTitle")}</p>
      </div>
      {state.transition ? <TransitionCard transition={state.transition} /> : null}
      {state.rotation ? <RotationCard rotation={state.rotation} /> : null}
      {orchestratorQuietBannerEligible(state, file) ? <Note tone="warning">{t("orchPanel.stalled")}</Note> : null}
      {state.liveness === "resumable" ? <Note tone="quiet">{t("orchPanel.resumable")}</Note> : null}
      <MandateView seat={state.seat} />
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

/**
 * WHO is holding the seat — the desktop's incumbent header (`IncumbentHeader`),
 * in the sheet's own layout: engine, model at tier, account and context
 * fullness on one wrapping row, the lineage link under it. The status read
 * answers first; until it has, the board's own card fills the row, so the
 * identity is populated on the first paint instead of waiting out the poll.
 */
function SeatIdentity({
  incumbent,
  file,
  catalog,
  predecessorConversationId,
}: {
  incumbent: OrchestratorIncumbent | null;
  file: FileEntry | null;
  catalog: LaunchAccountCatalog | null;
  predecessorConversationId: string | null;
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
  const context = designated?.context ?? boardContext(file);

  return (
    <div
      data-orchestrator-incumbent
      className="flex shrink-0 flex-col gap-1.5 rounded-surface border border-border bg-sunken px-3 py-2.5"
      aria-label={t("orchPanel.incumbentAria")}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {badge ? <Badge style={badge.style}>{badge.label}</Badge> : null}
        {model ? (
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
      </div>
      {predecessorConversationId ? (
        <a
          href={"#c=" + encodeURIComponent(predecessorConversationId)}
          data-orchestrator-predecessor={predecessorConversationId}
          title={t("orchPanel.predecessorTitle")}
          className="inline-flex min-h-11 min-w-0 items-center gap-1 self-start text-ui text-muted hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <CornerDownRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">{t("orchPanel.predecessor")}</span>
        </a>
      ) : null}
    </div>
  );
}

/** The mandate the seat is running under, readable in place: the rules the
    dock folds behind a disclosure in its drafts, here folded the same way. It
    is the text the rotate draft opens prefilled with. */
function MandateView({ seat }: { seat: OrchestratorSeat }) {
  const { t } = useLocale();
  return (
    <details data-orchestrator-mandate-view className="shrink-0 rounded-control border border-border bg-card/60">
      <summary className="min-h-11 cursor-pointer select-none list-item px-3 py-2.5 text-label font-semibold text-secondary marker:text-muted hover:text-primary">
        {seat.promptVersion === null
          ? t("orchMobile.mandateViewCustom")
          : orchestratorMandateStale(seat.promptVersion)
            ? t("orchMobile.mandateViewStale", { version: seat.promptVersion, current: ORCHESTRATOR_PROMPT_VERSION })
            : t("orchMobile.mandateView", { version: seat.promptVersion })}
      </summary>
      <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words border-t border-border px-3 py-2 font-sans text-ui leading-5 text-secondary">
        {seat.mandate}
      </pre>
    </details>
  );
}

/** A failed designation — or a failed ROTATION, which says something different:
    the incumbent is still running, and «nothing is running» would be a lie
    exactly when the operator is deciding whether to try again. */
function IntentError({ error, retry, rotate }: { error: string; retry: "fresh" | "same"; rotate: boolean }) {
  const { t } = useLocale();
  return (
    <div className="shrink-0 rounded-surface border border-danger/40 bg-danger-soft px-3 py-2.5" role="alert" data-orchestrator-intent-error>
      <p className="flex items-center gap-1.5 text-ui font-semibold text-danger">
        <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />
        {t(retry === "same"
          ? rotate ? "orchPanel.rotateErrorUnknownTitle" : "orchPanel.errorUnknownTitle"
          : rotate ? "orchPanel.rotateErrorTitle" : "orchPanel.errorTitle")}
      </p>
      <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words font-sans text-ui leading-4 text-secondary">
        {error}
      </pre>
      <p className="mt-1 text-caption text-muted">
        {t(retry === "same"
          ? rotate ? "orchPanel.rotateErrorUnknownHint" : "orchPanel.errorUnknownHint"
          : rotate ? "orchPanel.rotateErrorHint" : "orchPanel.errorHint")}
      </p>
    </div>
  );
}

function ViewerMcpStatus({ registered }: { registered: boolean }) {
  const { t } = useLocale();
  return (
    <p
      className="shrink-0 rounded-control border border-border bg-card px-3 py-2 font-mono text-caption text-secondary"
      data-viewer-mcp-status={registered ? "registered" : "missing"}
      role="status"
    >
      {t(registered ? "orchPanel.viewerMcpRegistered" : "orchPanel.viewerMcpMissing")}
    </p>
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
    for it, through the Rotate control above, and confirms the draft it opens. */
function RotationCard({ rotation }: { rotation: RotationHint }) {
  const { t } = useLocale();
  const summary = rotation.reasons.map((reason) => (
    reason === "context"
      ? t("orchPanel.rotationContext", { percent: String(rotation.contextPercent ?? 0) })
      : t("orchPanel.rotationDead")
  )).join(" · ");
  return (
    <div className="shrink-0 rounded-surface border border-warning/45 bg-warning-soft px-3 py-2" role="status" data-orchestrator-rotation={rotation.level}>
      <p className="text-ui font-semibold text-warning">
        {t(rotation.level === "strongly_recommend" ? "orchPanel.rotationStrong" : "orchPanel.rotation")}
      </p>
      {summary ? <p className="mt-0.5 text-caption leading-4 text-secondary">{summary}</p> : null}
      {/* The server's own reasons, verbatim: each names the threshold it crossed
          and whether the number behind it is an estimate. */}
      {rotation.notes?.length ? (
        <ul className="mt-0.5 list-disc pl-3.5 text-caption leading-4 text-muted marker:text-muted/60">
          {rotation.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      ) : null}
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
