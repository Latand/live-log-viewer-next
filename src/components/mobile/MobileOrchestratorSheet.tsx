"use client";

import { Bot, ChevronRight, Command, CornerDownRight, LoaderCircle, Pencil, RefreshCw, RotateCcw, Sparkle, TriangleAlert } from "lucide-react";
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
import { useKeyboardInset } from "@/hooks/useComposer";
import { useEngineAccounts } from "@/hooks/useEngineAccounts";
import { useLocale, type MessageKey, type TFunction } from "@/lib/i18n";
import { ORCHESTRATOR_PROMPT_VERSION, ORCHESTRATOR_SPAWN_CONFIG, ORCHESTRATOR_SYSTEM_PROMPT, orchestratorMandateStale } from "@/lib/orchestrator/prompt";
import type { OrchestratorSeat } from "@/lib/orchestrator/seats";
import type { FileEntry } from "@/lib/types";

import { boardContext } from "../orchestrator/IncumbentHeader";
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
import { humanizeDuration } from "../turnDuration";
import { statePhrase } from "./MobileBoard";
import { MobileMeter } from "./MobileMeter";
import { MobileSheet } from "./MobileSheet";
import { mobileRowState } from "./mobileBoardModel";
import { readSeatDraftField, readSeatFlowField, writeSeatDraftField, writeSeatFlowField } from "./orchestratorDraftStorage";
import {
  CONVERSATION_STATE_TONE,
  ROW_STATE_LABEL,
  SEAT_STATE_TONE,
  orchestratorRowView,
  seatCardView,
  type SeatBadgeTone,
  type SeatCardView,
} from "./orchestratorRowState";

const BADGE_TONE: Record<SeatBadgeTone, string> = {
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  accent: "bg-accent-soft text-accent",
  neutral: "bg-sunken text-secondary",
};

/**
 * The one badge recipe (README §5): 20 px, soft fill, role text, and it never
 * truncates — the title beside it does first (2026-08 audit finding 17, where
 * the phone's seat row cut the state word down to «R…»).
 *
 * It lives in this file, and the card imports it from here, because the card
 * already imports the sheet: one direction, no cycle. The two surfaces say a
 * seat's state through the same component so they cannot say it two ways.
 */
export function SeatBadge({ tone, children }: { tone: SeatBadgeTone; children: React.ReactNode }) {
  return (
    <span
      data-mobile2-seat-badge={tone}
      className={`inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-full px-[7px] text-caption font-semibold leading-none tabular-nums ${BADGE_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * WHAT that badge says, decided once for both surfaces.
 *
 * A live seat whose transcript is on this device speaks its CONVERSATION's
 * phrase — «working 12:40», the same words the board's rows and the
 * conversation's bar carry — and every other state speaks the seat's own word
 * (`orchestratorRowState`). The card and this sheet both read it from here, so
 * a seat cannot say «working 12:40» on the board and «live» one tap later:
 * that disagreement is what the approved picture shows as one phrase in both
 * places (`prototype/app.js`, `seatCard()` and `seatSheet()` share `st.phrase`).
 */
export function seatBadgeReading(
  t: TFunction,
  view: SeatCardView,
  file: FileEntry | null,
  now: number,
): { tone: SeatBadgeTone; text: string } {
  if (view.badge === "conversation" && file) {
    const conversation = mobileRowState(file, now);
    return { tone: CONVERSATION_STATE_TONE[conversation.key], text: statePhrase(t, conversation, now) };
  }
  return { tone: SEAT_STATE_TONE[view.state], text: t(ROW_STATE_LABEL[view.state]) };
}

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
 * The phone's orchestrator sheets, chosen by which one the navigation store
 * has open (§3.3):
 *
 *  - `seat` — the BOTTOM sheet that reads the seat (README §4.5). The board
 *    stays visible and dimmed behind it, the handle closes it, and the two
 *    controls that act on the seat sit at the thumb.
 *  - `rotate` — the FULLSCREEN draft that replaces the seat, and the create
 *    draft over a vacancy: the same surface with a different primary. It keeps
 *    #1004's keyboard budget verbatim, because that budget was measured
 *    against a surface that owns the whole viewport.
 *
 * They are two components rather than two branches so each owns its own modal
 * layer: switching from one to the other unmounts a surface and mounts the
 * other, which is what makes the focus return and the scroll lock balance.
 */
export function MobileOrchestratorSheet(props: SeatSheetProps) {
  return props.sheet === "rotate" ? <SeatDraftSheet {...props} /> : <SeatStatusSheet {...props} />;
}

interface SeatSheetProps {
  project: string;
  projectName: string;
  projectCwd?: string;
  /** Which of the card's two sheets is open. The name decides the container;
      the seat state decides what is inside it. */
  sheet: "seat" | "rotate";
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
  /** Epoch seconds, the card's own clock: «holding the seat for 2h» ages on the
      same tick the card's badge does. */
  now: number;
  rotate: SeatRotateFlow;
  onConfirm: (payload: SeatConfirmPayload) => void;
  onRecheck: () => void;
  onOpenConversation: () => void;
  onClose: () => void;
}

/** The draft's own launch state, on the create keys the desktop dock uses. */
function useCreateDraft(project: string) {
  return useAgentLaunchDraft({
    storage: {
      read: (name) => readSeatDraftField(project, name),
      write: (name, value) => writeSeatDraftField(project, name, value),
    },
    initialEngine: ORCHESTRATOR_SPAWN_CONFIG.engine,
    initialModel: ORCHESTRATOR_SPAWN_CONFIG.model,
    initialEffort: ORCHESTRATOR_SPAWN_CONFIG.effort,
  });
}

/**
 * The seat, read as a bottom sheet: identity (model · reasoning, the state
 * badge, the engine mark, account · plan, how long it has held the seat), the
 * context meter filling with what REMAINS, the predecessor, the mandate it runs
 * under, the row that edits it, and the sentence that says editing means a
 * successor. Rotate and Open conversation are the footer, at the thumb.
 *
 * Every state that is not a draft lands here too — loading, an unreadable seat,
 * a designation still in flight — because each of them is a READING of the
 * seat, and the one way forward each has is the same footer slot.
 */
function SeatStatusSheet({
  project,
  projectName,
  state,
  file,
  incumbent,
  pendingMandate,
  submitting,
  now,
  rotate,
  onConfirm,
  onRecheck,
  onOpenConversation,
  onClose,
}: SeatSheetProps) {
  const { t } = useLocale();
  const launch = useCreateDraft(project);
  const view = orchestratorRowView(state, { conversationReady: Boolean(file) });
  const mode = state.kind === "live" ? "live" : "create";

  const primary: { key: MessageKey; run: () => void; busy: boolean } | null = state.kind === "creating"
    ? (!submitting && state.clientRequestId
      ? {
          key: "orchPanel.creatingResume",
          run: () => onConfirm({
            engine: launch.engine,
            model: launch.model,
            effort: launch.effort,
            speed: launch.speed,
            accountId: launch.launchAccountId,
            mandate: pendingMandate || ORCHESTRATOR_SYSTEM_PROMPT,
            replayRequestId: state.clientRequestId,
          }),
          busy: false,
        }
      : null)
    : state.kind === "unavailable"
      ? { key: "orchPanel.recheck", run: onRecheck, busy: false }
      : state.kind === "live" && file
        ? { key: "mobile2.seat.open", run: onOpenConversation, busy: false }
        : null;

  return (
    <MobileSheet
      name="seat"
      title={t("mobile2.seat.sheetTitle", { project: projectName })}
      onClose={onClose}
      footer={
        <>
          {/* Rotate: a control, and only a control. The advisory in the body
              states the recommendation; this performs it, and ONLY when
              pressed and then confirmed in the draft it opens. */}
          {state.kind === "live" ? (
            <button
              type="button"
              data-orchestrator-rotate
              data-mobile2-open="rotate"
              onClick={rotate.onOpen}
              disabled={rotate.opening || rotate.submitting}
              title={t("orchPanel.rotateTitle")}
              className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-control border border-border bg-card px-3 text-body font-semibold text-primary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
            >
              {rotate.opening
                ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
                : <RefreshCw className="h-4 w-4" aria-hidden />}
              {t(rotate.opening ? "orchMobile.rotateOpening" : "orchPanel.rotate")}
            </button>
          ) : null}
          {primary ? (
            <button
              type="button"
              data-orchestrator-confirm
              disabled={primary.busy}
              onClick={primary.run}
              className="inline-flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-control border border-accent bg-accent px-3 text-body font-semibold text-white shadow-1 active:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
            >
              {primary.busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <Bot className="h-4 w-4" aria-hidden />}
              <span className="truncate">{t(primary.key)}</span>
            </button>
          ) : null}
        </>
      }
    >
      <div
        data-testid="mobile-orchestrator-sheet"
        data-orchestrator-sheet-state={view.state}
        data-orchestrator-sheet-mode={mode}
        className="flex flex-col gap-3 px-4 pb-2"
      >
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
          <LiveView state={state} file={file} incumbent={incumbent} now={now} onEditMandate={rotate.onOpen} />
        ) : (
          /* A vacancy or a failed designation reached this sheet from somewhere
             other than the card (the platform's forward gesture onto a replaced
             route, a state that changed under an open sheet): the draft is the
             surface that can act on it, and it is one tap away. */
          <Centered>
            <Bot className="h-6 w-6 text-accent" aria-hidden />
            <p className="text-body font-semibold text-primary">{t("mobile2.seat.none")}</p>
            <button
              type="button"
              data-mobile2-open="rotate"
              onClick={rotate.onOpen}
              className="inline-flex min-h-11 items-center gap-1 text-ui font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              {t("mobile2.seat.create")}
              <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
            </button>
          </Centered>
        )}
      </div>
    </MobileSheet>
  );
}

/**
 * The create and rotate drafts, fullscreen (README §4.5, unchanged in substance
 * from #979 / #1347 / #1004).
 *
 * It is the same draft as the desktop dock — the shared launch module
 * (`useAgentLaunchDraft` + `AgentLaunchControls`), the same default mandate in
 * an editable textarea, the same `POST /api/orchestrator/seat` behind Confirm —
 * rendered as a fullscreen sheet in the pattern this codebase already uses for
 * one (`TaskSheet`): `fixed inset-0`, its own header row, one scrolling body,
 * the actions parked at the thumb.
 *
 * It never mounts a conversation. A seat that goes live while this is open
 * hands off to the conversation screen (the card closes the sheet and pins the
 * pane), which is the operator's decision from the interview: the phone reads
 * the orchestrator in the standard conversation surface, not in a second chat
 * inside a sheet.
 *
 * The keyboard is the phone's whole problem here — a large textarea plus an
 * on-screen keyboard is exactly the case #983 repaired for the focus root — so
 * the sheet budgets against the SAME `useKeyboardInset` signal rather than
 * measuring the viewport a second way. The footer actions stay above the
 * keyboard, and the body scrolls under them. Both safe-area insets are padded:
 * the header's controls clear the notch, the footer clears the home indicator.
 */
function SeatDraftSheet({
  project,
  projectName,
  projectCwd,
  state,
  status,
  file,
  incumbent,
  viewerMcpRegistered,
  submitting,
  rotate,
  onConfirm,
  onClose,
}: SeatSheetProps) {
  const { t } = useLocale();
  const kbInset = useKeyboardInset();
  const sheetRef = useRef<HTMLFormElement>(null);
  const [mandate, setMandateState] = useState(() => readSeatDraftField(project, "mandate") || ORCHESTRATOR_SYSTEM_PROMPT);
  const [formError, setFormError] = useState<string | null>(null);
  const launch = useCreateDraft(project);

  /* Full modal semantics through the shared layer stack: focus in on open, Tab
     trapped, Escape closes, body scroll locked, focus back to the card. */
  useModalLayer({ containerRef: sheetRef, onClose });

  const setMandate = (value: string) => {
    setMandateState(value);
    /* Stored only while it differs from the default, so an untouched draft
       follows the approved prompt forward instead of pinning today's copy. */
    writeSeatDraftField(project, "mandate", value === ORCHESTRATOR_SYSTEM_PROMPT ? "" : value);
  };

  const view = orchestratorRowView(state, { conversationReady: Boolean(file) });
  const rotating = rotate.open && rotate.seat !== null;
  const mode = rotating ? "rotate" : state.kind === "live" ? "live" : "create";

  const submitDraft = () => {
    const text = mandate.trim();
    if (!text) {
      setFormError(t("orchPanel.mandateRequired"));
      return;
    }
    setFormError(null);
    onConfirm({
      engine: launch.engine,
      model: launch.model,
      effort: launch.effort,
      speed: launch.speed,
      accountId: launch.launchAccountId,
      mandate: text,
    });
  };

  /* The create draft's own primary, parked at the thumb. The rotate draft
     brings its own footer — two ways out, keep or rotate — so it takes the
     slot over; and a state that stops being a draft under an open sheet (a
     confirm that landed) keeps the surface with no primary rather than a
     control that no longer acts. */
  const drafting = state.kind === "draft" || state.kind === "intent-error";
  const primary: { key: MessageKey; run: () => void; busy: boolean } | null = rotating || !drafting
    ? null
    : { key: state.kind === "intent-error" ? "orchPanel.confirmRetry" : "orchPanel.confirm", run: submitDraft, busy: submitting };

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
        data-mobile2-sheet="rotate"
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
            <span className="truncate text-body font-semibold text-primary">
              {rotating ? t("orchPanel.rotateHeading") : t("orchPanel.draftTitle")}
            </span>
            <span className="truncate text-caption text-muted" title={projectName}>{projectName}</span>
          </span>
          <SeatBadge tone={SEAT_STATE_TONE[view.state]}>{t(ROW_STATE_LABEL[view.state])}</SeatBadge>
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
        ) : !drafting ? (
          /* The draft surface with nothing to draft yet: the rotation's own
             read is still in flight, or a confirm has just landed and the seat
             is settling. Showing the create form here would offer to create a
             SECOND orchestrator over a live one for the frame it takes. */
          <Centered>
            <LoaderCircle className="h-5 w-5 animate-spin text-accent" aria-hidden />
            <p className="text-ui text-muted" role="status">{t("orchMobile.rotateOpening")}</p>
          </Centered>
        ) : (
          <>
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
              {state.kind === "intent-error" ? (
                <IntentError error={state.error} retry={state.retry} rotate={false} />
              ) : state.kind === "draft" && state.vacated ? (
                <p className="shrink-0 text-ui leading-4 text-muted">
                  {t("orchPanel.draftHintVacated", { project: projectName })}
                </p>
              ) : null}

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
            </div>

            {primary ? (
              <div className="flex shrink-0 flex-col gap-2 border-t border-border bg-sunken px-3 py-2.5">
                {formError ? <p className="text-ui font-semibold text-danger" role="alert">{formError}</p> : null}
                <div className="flex items-center gap-2">
                  {/* Cancel sits IN the draft (README §4.5), beside its primary:
                      a create reached from the board's invitation needs a way
                      back to the board that is not the platform gesture. */}
                  <button
                    type="button"
                    data-orchestrator-draft-cancel
                    onClick={onClose}
                    disabled={primary.busy}
                    className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-control border border-border bg-card px-3 text-ui font-semibold text-secondary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
                  >
                    {t("mobile2.seat.draftCancel")}
                  </button>
                  <button
                    type="submit"
                    data-orchestrator-confirm
                    disabled={primary.busy}
                    className="inline-flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-control border border-accent bg-accent px-3 text-body font-semibold text-white shadow-1 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
                  >
                    {primary.busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <Bot className="h-4 w-4" aria-hidden />}
                    <span className="truncate">{t(primary.key)}</span>
                  </button>
                </div>
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
          /* The heading is the sheet's own header (the prototype titles the
             sheet by its mode); what the body owes is the sentence that says
             what a rotation actually does. */
          <p className="shrink-0 text-ui leading-4 text-muted">{t("orchPanel.rotateHint")}</p>
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
          {/* Cancel, in the picture's own word (README §4.5: «the footer Cancel
              / Rotate orchestrator»), and the SAME word the create draft's
              footer carries — one draft, one way out, whichever route opened
              it. The desktop dock keeps «Keep this one»: it sits beside a panel
              that already shows the incumbent, where naming what stays is the
              clearer half. */}
          <button
            type="button"
            data-orchestrator-rotate-cancel
            onClick={onCancel}
            disabled={submitting}
            className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-control border border-border bg-card px-3 text-ui font-semibold text-secondary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
          >
            {t("mobile2.seat.draftCancel")}
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

/**
 * A seated orchestrator, read from the sheet rather than from its own chat
 * (README §4.5): who holds the seat and on what, how much of its window is
 * left, the lineage it replaced, the rules it runs under, and the one row that
 * changes them. Rotate and «Open conversation» are the sheet's footer, at the
 * thumb, so nothing that ACTS on the seat is inside the scroller.
 *
 * There is no working-dir row here, deliberately (README §10 P2-12): the
 * checkout is host detail, and the phone keeps host detail behind
 * `⋯ › Details & host`. The draft below states which directory a successor
 * inherits, where the answer is about to matter (#903).
 */
function LiveView({
  state,
  file,
  incumbent,
  now,
  onEditMandate,
}: {
  state: Extract<OrchestratorPanelState, { kind: "live" }>;
  file: FileEntry | null;
  incumbent: OrchestratorIncumbent | null;
  now: number;
  /** «Edit the mandate» is Rotate by another name — the same draft, opened
      from the rules it edits — because a mandate cannot change under a running
      orchestrator: a successor takes the seat. */
  onEditMandate: () => void;
}) {
  const { t } = useLocale();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <SeatIdentity
        state={state}
        incumbent={incumbent}
        file={file}
        now={now}
        predecessorConversationId={state.seat.predecessorConversationId}
      />
      {state.transition ? <TransitionCard transition={state.transition} /> : null}
      {orchestratorQuietBannerEligible(state, file) ? <Note tone="warning">{t("orchPanel.stalled")}</Note> : null}
      {state.liveness === "resumable" ? <Note tone="quiet">{t("orchPanel.resumable")}</Note> : null}
      <MandateView seat={state.seat} />
      {/* One row, in the prototype's own words: what it does, and what it
          costs. Nothing here rotates on its own — it opens the draft. */}
      <button
        type="button"
        data-orchestrator-edit-mandate
        data-mobile2-open="rotate"
        onClick={onEditMandate}
        className="flex min-h-11 w-full shrink-0 items-center gap-3 rounded-control text-left text-body font-semibold text-primary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      >
        <Pencil className="h-[18px] w-[18px] shrink-0 text-secondary" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t("mobile2.seat.editMandate")}</span>
        <span className="shrink-0 text-label font-medium text-muted">{t("mobile2.seat.editMandateHint")}</span>
      </button>
      <p className="shrink-0 text-caption leading-4 text-muted">{t("mobile2.seat.successorNote")}</p>
      {file ? null : (
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
 * WHO is holding the seat, and on what (README §4.5): the filled engine mark,
 * `model · reasoning` with the seat's own state badge beside it, then account ·
 * plan and how long this conversation has held the seat. Under it the context
 * meter, which — like every meter on the phone — fills with what REMAINS, and
 * the rotation advisory when the window is nearly spent.
 *
 * Account and plan live HERE rather than on the card (README §10 P2-3): they
 * are what the operator checks when they are about to change the seat, and the
 * card's job is to say what the orchestrator is doing right now.
 *
 * The status read answers first; until it has, the board's own card fills the
 * row, so the identity is populated on the first paint instead of waiting out
 * the poll.
 */
function SeatIdentity({
  state,
  incumbent,
  file,
  now,
  predecessorConversationId,
}: {
  state: Extract<OrchestratorPanelState, { kind: "live" }>;
  incumbent: OrchestratorIncumbent | null;
  file: FileEntry | null;
  now: number;
  predecessorConversationId: string | null;
}) {
  const { t } = useLocale();
  const designated = incumbent?.designated ? incumbent : null;
  const engine = designated?.engine ?? (file?.engine === "claude" || file?.engine === "codex" ? file.engine : null);
  const model = designated?.model ?? file?.model ?? null;
  const effort = designated?.effort ?? null;
  const accountId = designated?.accountId ?? null;
  /* The account's own row, for its label and its PLAN — the launch catalog
     carries neither, and the plan is half of what this line says. */
  const accounts = useEngineAccounts(engine === "codex" ? "codex" : "claude");
  const row = accountId ? accounts.accounts.find((candidate) => candidate.id === accountId) ?? null : null;
  const account = row?.label ?? accountId;
  /* Capitalised exactly as the accounts screen does it, so «Max plan» reads
     the same wherever the operator meets it. */
  const planName = row?.plan?.trim() ?? "";
  const plan = planName ? t("mobile2.seat.plan", { plan: planName.charAt(0).toUpperCase() + planName.slice(1) }) : null;
  const context = designated?.context ?? boardContext(file);
  const percent = context?.percent ?? null;
  const left = percent === null ? null : Math.max(0, 100 - percent);
  const window = context?.limit ?? null;
  /* «Holding the seat for 2h»: since the seat ACTIVATED, which is when this
     conversation started answering for the project — a designation that has
     not activated yet is not holding anything. */
  const heldSince = state.seat.activatedAt ? Date.parse(state.seat.activatedAt) : NaN;
  const held = Number.isFinite(heldSince) ? Math.max(0, now - heldSince / 1000) : null;
  /* The card's own reading, so the seat says one thing on the board and the
     same thing in the sheet the board's tap opens. */
  const badge = seatBadgeReading(t, seatCardView(state, { conversationReady: Boolean(file) }), file, now);

  return (
    <div
      data-orchestrator-incumbent
      className="flex shrink-0 flex-col gap-2 rounded-surface border border-border bg-sunken px-3 py-2.5"
      aria-label={t("orchPanel.incumbentAria")}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        {/* The filled engine circle: on the phone it survives only on account
            cards and here (README §5, P3-5). */}
        <span
          data-mobile2-seat-engine={engine ?? "unknown"}
          className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-white ${engine === "codex" ? "bg-codex" : "bg-claude"}`}
          aria-hidden
        >
          {engine === "codex" ? <Command className="h-[15px] w-[15px]" /> : <Sparkle className="h-[15px] w-[15px]" />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            {model ? (
              <span className="min-w-0 truncate text-body font-semibold text-primary">
                {model}
                {effort ? <span className="font-normal text-secondary"> · {effort}</span> : null}
              </span>
            ) : (
              <span className="min-w-0 truncate text-body text-muted">{t("orchPanel.incumbentUnknown")}</span>
            )}
            <SeatBadge tone={badge.tone}>{badge.text}</SeatBadge>
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-label text-secondary">
            {account ? <span className="min-w-0 truncate">{account}</span> : null}
            {account && plan ? <span aria-hidden className="opacity-60">·</span> : null}
            {plan ? <span className="min-w-0 truncate">{plan}</span> : null}
            {(account || plan) && held !== null ? <span aria-hidden className="opacity-60">·</span> : null}
            {held === null ? null : (
              <span className="shrink-0 tabular-nums" data-mobile2-seat-held>{t("mobile2.seat.holding", { age: humanizeDuration(held) })}</span>
            )}
          </span>
        </span>
      </div>

      {/* Context, the phone's one meter semantic: the fill is what is LEFT and
          it is coloured by what is left (README §5, P2-4). */}
      <div className="flex min-w-0 items-center gap-2" data-mobile2-seat-context={left === null ? "unknown" : String(left)}>
        <span className="shrink-0 text-label font-semibold text-muted">{t("mobile2.seat.context")}</span>
        {left === null ? (
          <span className="text-label text-muted">{t("mobile2.seat.contextUnknown")}</span>
        ) : (
          <>
            <MobileMeter left={left} className="max-w-[140px] flex-1" label={t("mobile2.seat.contextAria", { percent: String(left) })} />
            <span className="shrink-0 text-label tabular-nums text-secondary">
              {t("mobile2.seat.contextLeft", { percent: String(left), window: window === null ? "—" : shortTokens(window) })}
            </span>
          </>
        )}
      </div>
      {state.rotation && left !== null ? (
        <p className="text-label leading-4 text-warning" data-orchestrator-rotation={state.rotation.level} role="status">
          {t("mobile2.seat.rotationRecommended", { percent: String(left) })}
        </p>
      ) : null}

      {predecessorConversationId ? (
        <a
          href={"#c=" + encodeURIComponent(predecessorConversationId)}
          data-orchestrator-predecessor={predecessorConversationId}
          title={t("orchPanel.predecessorTitle")}
          className="flex min-h-11 min-w-0 items-center gap-3 rounded-control text-body font-semibold text-primary active:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
        >
          <CornerDownRight className="h-[18px] w-[18px] shrink-0 text-secondary" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t("mobile2.seat.predecessor")}</span>
          <span className="inline-flex shrink-0 items-center gap-0.5 text-label font-medium text-muted">
            {t("mobile2.seat.predecessorOpen")}
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </span>
        </a>
      ) : null}
    </div>
  );
}

/** 176_000 → «176K», the same shortening the desktop's context chip uses. */
function shortTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${millions >= 10 || Number.isInteger(millions) ? Math.round(millions) : Math.round(millions * 10) / 10}M`;
  }
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : `${tokens}`;
}

/**
 * The mandate the seat is running under, as the sheet's own block (README
 * §4.5): the heading names the version, and the text below it is a faded
 * preview — three lines, because the rules are long and the operator is here
 * to check WHICH rules, not to read them again. It expands in place, and it is
 * the text the rotate draft opens prefilled with.
 */
function MandateView({ seat }: { seat: OrchestratorSeat }) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const heading = seat.promptVersion === null
    ? t("mobile2.seat.mandateHeadingCustom")
    : orchestratorMandateStale(seat.promptVersion)
      ? t("mobile2.seat.mandateHeadingStale", { version: seat.promptVersion, current: ORCHESTRATOR_PROMPT_VERSION })
      : t("mobile2.seat.mandateHeading", { version: seat.promptVersion });
  return (
    <div className="flex shrink-0 flex-col gap-1" data-orchestrator-mandate-view={expanded ? "expanded" : "preview"}>
      <p className="text-label font-semibold text-muted">{heading}</p>
      <button
        type="button"
        data-orchestrator-mandate-preview
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
        className="w-full rounded-control bg-canvas px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <span
          className={`block whitespace-pre-wrap break-words text-ui leading-5 text-muted ${expanded ? "max-h-56 overflow-y-auto" : "line-clamp-3"}`}
        >
          {seat.mandate}
        </span>
      </button>
    </div>
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
