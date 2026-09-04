"use client";

import { Bot, ChevronRight, LoaderCircle, RotateCw, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { applySpawnedConversationSnapshot } from "@/hooks/useFiles";
import { refreshRuntime } from "@/hooks/useRuntime";
import { requestFilesRefresh } from "@/lib/filesEvents";
import { useLocale } from "@/lib/i18n";
import { ORCHESTRATOR_PROMPT_VERSION, ORCHESTRATOR_SYSTEM_PROMPT } from "@/lib/orchestrator/prompt";
import { derivedSpawnTitle } from "@/lib/title";
import type { FileEntry } from "@/lib/types";

import {
  classifySpawnResponse,
  createSpawnAttempt,
  provisionalSpawnFile,
  type SpawnResponseBody,
} from "../draftSpawn";
import { draftWorkingDirectory } from "../projectModel";
import {
  classifySeatFailure,
  deriveOrchestratorPanelState,
  newSeatRequestId,
  seatBindPending,
  seatRequestSettled,
  type SeatSubmitFailure,
} from "../orchestrator/seatState";
import { useOrchestratorIncumbent } from "../orchestrator/useOrchestratorIncumbent";
import { useOrchestratorSeat, type OrchestratorSeatRead } from "../orchestrator/useOrchestratorSeat";
import { useSeatConfirm } from "../orchestrator/useSeatConfirm";
import { incumbentHostLive } from "../orchestrator/incumbent";
import { useSeatBindingFeedback } from "../orchestrator/useSeatBindingFeedback";
import { useSeatSurface } from "../orchestrator/useSeatSurface";
import { MobileMeter } from "./MobileMeter";
import { MobileOrchestratorSheet, SeatBadge, seatBadgeReading, type SeatConfirmPayload, type SeatRotateFlow } from "./MobileOrchestratorSheet";
import { nowFragment } from "./mobileBoardModel";
import { useMobileNav, useMobileNavStore } from "./mobileNav";
import { readSeatDraftField, seatFlowStorage, writeSeatDraftField } from "./orchestratorDraftStorage";
import { seatCardView } from "./orchestratorRowState";

/**
 * Why the sheet is open. `handoff` arms the landing: the sheet was opened to
 * CHANGE which conversation holds the seat — the create flow, or a rotation —
 * so when a seat other than `from` goes live the phone lands IN that
 * conversation instead of leaving the operator on a sheet about it. A sheet
 * opened deliberately on a live seat to read it, or to reach its controls, is
 * not armed.
 */
interface SheetOpening {
  handoff: boolean;
  /** The conversation the armed handoff is replacing: null for a create (any
      live seat lands), the incumbent's id for a rotation (only the successor
      lands — the incumbent stays live for the whole draft). */
  from: string | null;
}

/** The seat's mark: the phone's one avatar-shaped element, and it stands for
    a role rather than for a person. */
function SeatMark() {
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-soft text-accent" aria-hidden>
      <Bot className="h-[18px] w-[18px]" />
    </span>
  );
}

/**
 * The phone's orchestrator seat card (PRD #976 slice C, issue #979; mobile v2
 * lane 6, docs/design/mobile-v2/README.md §4.1, §4.5).
 *
 * The operator picked a pinned orchestrator over a separate near-fullscreen
 * window: *«maybe a pin of the orchestrator conversation in the conversation
 * list… and of course a separate one per project»*. Mobile v2 keeps that
 * decision and gives it the room a phone actually has: the seat is the FIRST
 * CARD on the board rather than a chip in a strip that had 38 vw to spend, so
 * the state word never truncates and the card can say what the orchestrator is
 * doing right now.
 *
 * The card is: the mark, «Orchestrator» with a state badge, a now line (what
 * the seat is doing this minute) and the context meter, which — like every
 * meter on the phone — fills with what REMAINS. Over a vacancy the same card
 * is the invitation: «No orchestrator» and one accent line into the create
 * draft. Account and plan are not here; they are one tap away in the sheet
 * (README §10 P2-3), because a card that lists them says less about the thing
 * the operator opened the board to see.
 *
 * A tap does one of two things, and which one is the whole design:
 *
 *  - a LIVE seat opens its conversation in the standard conversation screen
 *    (`onOpenConversation`), with the composer the phone already has. No second
 *    mobile chat surface exists, by decision.
 *  - every other state opens the seat sheet, which is the only surface that
 *    can act on it: create, resume a stuck designation, read a terminal error,
 *    re-read an unavailable seat.
 *
 * A live seat gets a SECOND target beside it (issue #1347): its ⚙. The desktop
 * dock carries these in the incumbent header — who holds the seat, Rotate, and
 * the draft that adjusts the seat's settings — and the phone had none of it:
 * the row's tap opened the chat and nothing else, so an operator on a phone
 * could not find where rotation lived. Nothing here is a long-press, a menu, or
 * an overflow that touch never reveals.
 *
 * Confirm goes to `POST /api/orchestrator/seat`, rotation to `POST
 * /api/orchestrator/rotate` (`../orchestrator/useSeatConfirm`, the dock's own
 * discipline), never to raw `/api/spawn` — and each carries ONE
 * `clientRequestId` per submission: minted on the first confirm, persisted
 * under the same keys the desktop dock uses, replayed by a retry, and released
 * only once the seat read says where it landed. A phone drops its connection
 * mid-POST far more often than a desktop does, so this is the path that decides
 * whether a lost reply costs a second orchestrator.
 */
export function MobileSeatCard({
  project,
  projectName,
  files,
  seat,
  now,
  onOpenConversation,
}: {
  project: string;
  projectName: string;
  files: readonly FileEntry[];
  /** The parent's seat read, when it already has one. The phone board above
      this card must know which transcript holds the seat (the seat is the card,
      never also a row in the list), and that read is a 6 s poll — a second
      instance for the same key doubles every phone's seat traffic for one
      answer. Given a read, this card starts none of its own: the hook called
      with a null project issues no request and sets no interval. */
  seat?: OrchestratorSeatRead;
  /** Epoch seconds, the board's own clock: the badge's elapsed time ticks with
      the rows beside it rather than on a second clock of its own. */
  now?: number;
  /** Pins the seat's conversation as the focused pane — the standard mobile
      conversation surface, composer included. */
  onOpenConversation: (file: FileEntry) => void;
}) {
  const { t } = useLocale();
  const nav = useMobileNavStore();
  const navState = useMobileNav();
  const projectCwd = useMemo(() => draftWorkingDirectory(files, project), [files, project]);
  const ownSeat = useOrchestratorSeat(seat ? null : project, projectCwd || undefined);
  const { status, failed, refresh } = seat ?? ownSeat;
  const [submitting, setSubmitting] = useState(false);
  /* The guard is SYNCHRONOUS: two taps in one event batch both read the same
     render's `submitting`, so a state flag alone lets the second through. The
     seat route would still converge them onto one designation (same key), but
     the second reply would land as a spurious in-progress error over a
     perfectly good create. */
  const inFlight = useRef(false);
  const [submitFailure, setSubmitFailure] = useState<SeatSubmitFailure | null>(null);
  /* WHY the open sheet is open. WHETHER it is open is the navigation store's
     answer (§3.3): the seat and its draft are sheets over the board, so the
     platform back gesture and the bar's ‹ close them exactly as they close
     every other sheet, and neither adds a history entry. */
  const [arm, setArm] = useState<SheetOpening | null>(null);
  /* WHICH of the card's two sheets, when one is open: `seat` reads the seat as
     a bottom sheet, `rotate` is the fullscreen draft that replaces it. */
  const openName = navState.sheet === "seat" || navState.sheet === "rotate" ? navState.sheet : null;
  const sheetOpen = openName !== null;
  /* The conversation the open rotate draft is replacing. Non-null IS the rotate
     mode, and matching it against the current seat is what closes the draft the
     moment the successor lands — no completion callback, no stale flag. */
  const [rotateFrom, setRotateFrom] = useState<string | null>(null);
  /* Opening the rotate draft is a read first: see `openRotate`. */
  const [rotateOpening, setRotateOpening] = useState(false);

  const openSheet = useCallback((name: "seat" | "rotate", opening: SheetOpening) => {
    setArm(opening);
    nav.openSheet(name);
  }, [nav]);
  const closeSheet = useCallback(() => {
    setArm(null);
    nav.closeSheet();
  }, [nav]);
  useEffect(() => {
    /* A back gesture, or another surface opening its own sheet, took this one
       down without going through `closeSheet`. The arming goes with it. */
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- the sheet closed from outside this card */
    if (!sheetOpen && arm !== null) setArm(null);
  }, [sheetOpen, arm]);

  const seatConversationId = status?.seat?.conversationId ?? null;
  const seated = Boolean(seatConversationId && status?.exists);
  /* The incumbent's wear and parameters are a question only while the sheet
     is showing them or a rotate draft is about to prefill from them: the card
     itself carries the board's own reading, so a phone that never opens the
     sheet never pays for the slower status poll. */
  const { incumbent: read, stale: readStale, refresh: refreshIncumbent } = useOrchestratorIncumbent(project, seated && sheetOpen);
  /* A reading is only about the conversation it names: right after a rotation
     the seat has already advanced to the successor while this slower poll still
     describes the predecessor. */
  const incumbent = read && read.conversationId === seatConversationId ? read : null;
  const currentPath = incumbent?.transcriptPath ?? null;
  const seatPath = status?.seat?.path ?? null;
  const file = useMemo(
    () => (seatConversationId
      ? files.find((entry) => entry.conversationId === seatConversationId)
        /* The registry's current generation for the id (#1182), then the path
           the seat recorded at activation, as hints of decreasing freshness. */
        ?? files.find((entry) => currentPath !== null && entry.path === currentPath)
        ?? files.find((entry) => entry.path === seatPath)
        ?? null
      : null),
    [files, seatConversationId, currentPath, seatPath],
  );
  const surface = useSeatSurface(file);
  const unboundForMs = useSeatBindingFeedback({
    project,
    conversationId: seatConversationId,
    active: seated && openName === "seat",
    pending: seatBindPending(file, surface),
    hasReading: incumbent !== null,
    stale: readStale,
    refreshIncumbent,
  });

  /* The rotate flow, on the dock's own Rotate keys: a rotation half-written on
     one surface continues — and replays the same durable intent — on the other. */
  const rotateStorage = useMemo(() => seatFlowStorage("Rotate", project), [project]);
  const rotate = useSeatConfirm({ url: "/api/orchestrator/rotate", project, storage: rotateStorage, field: "requestId", status, refresh });

  const state = deriveOrchestratorPanelState({
    status,
    statusFailed: failed,
    /* Only one of the two flows can be in play — the create draft exists only
       without a seat, the rotate draft only with one — so their outcomes fold
       into the one derivation without ever masking each other. */
    submitting: submitting || rotate.submitting,
    submitFailure: submitFailure ?? rotate.failure,
    file,
    surface,
    incumbent,
    hostLive: !readStale && incumbentHostLive(incumbent),
    unboundForMs,
  });
  const view = seatCardView(state, { conversationReady: Boolean(file) });

  /* A rotation whose outcome is not yet settled KEEPS the draft, even after the
     incumbent's card is closed underneath it — its retained key is reachable
     only from this flow. Settled, the draft gives way: to the successor's live
     view, or to the create draft over a real vacancy. */
  const rotateUnsettled = rotate.submitting
    || (rotate.failure !== null && !seatRequestSettled(status, rotate.failure.clientRequestId));
  const rotatingLive = state.kind === "live" && rotateFrom !== null && rotateFrom === state.conversationId;
  const rotatingVacant = state.kind !== "live" && rotateFrom !== null && rotateUnsettled && status?.seat != null;
  const rotating = rotatingLive || rotatingVacant;
  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- the draft closes itself when the seat it was replacing is no longer the seat */
    if (rotateFrom !== null && !rotating) setRotateFrom(null);
  }, [rotateFrom, rotating]);

  /* A key kept through an unknown outcome is released the moment the seat read
     says where it landed. Held any longer it becomes a trap: the seat command
     answers a replay of a COMPLETED intent with the old seat, so the next
     genuinely new draft would post, succeed, and create nothing. */
  useEffect(() => {
    if (inFlight.current) return;
    const stored = readSeatDraftField(project, "requestId");
    if (stored && seatRequestSettled(status, stored)) writeSeatDraftField(project, "requestId", "");
  }, [project, status]);

  const confirm = useCallback(async (payload: SeatConfirmPayload) => {
    if (inFlight.current) return;
    inFlight.current = true;
    /* ONE key per draft submission, not per tap: minted on the first confirm
       and persisted, so a double tap, a reload mid-POST and an ambiguous retry
       all replay onto the same durable intent instead of designating twice.
       Cleared only once the attempt is terminal — a corrected mandate must
       arrive under a NEW key, because the seat command completes the ORIGINAL
       intent when a pending key is replayed. */
    const stored = payload.replayRequestId || readSeatDraftField(project, "requestId");
    const clientRequestId = stored || newSeatRequestId();
    if (readSeatDraftField(project, "requestId") !== clientRequestId) writeSeatDraftField(project, "requestId", clientRequestId);
    setSubmitting(true);
    setSubmitFailure(null);
    const at = Date.now();
    const text = payload.mandate.trim();
    try {
      const response = await fetch("/api/orchestrator/seat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project,
          mandate: text,
          clientRequestId,
          engine: payload.engine,
          ...(payload.model ? { model: payload.model } : {}),
          ...(payload.effort ? { effort: payload.effort } : {}),
          ...(payload.engine === "codex" && payload.speed ? { fast: payload.speed === "fast" } : {}),
          ...(payload.accountId ? { accountId: payload.accountId } : {}),
          ...(projectCwd ? { cwd: projectCwd } : {}),
          /* Only an UNEDITED mandate is a version of the approved prompt; an
             edited one is bespoke and records no version. */
          ...(text === ORCHESTRATOR_SYSTEM_PROMPT.trim() ? { promptVersion: ORCHESTRATOR_PROMPT_VERSION } : {}),
        }),
      });
      const body = (await response.json().catch(() => null)) as (SpawnResponseBody & { code?: string }) | null;
      /* Only a READABLE receipt settles the submission. Every 2xx the seat route
         emits carries `ok: true`; a 2xx that does not is a truncated body, a
         proxy's own page, or a shape this client does not understand — and none
         of them say where the intent landed. Treating those as success (and
         releasing the key on them) is precisely how one create becomes two
         orchestrators on a phone, which drops its connection mid-reply far more
         often than mid-request. */
      if (response.ok && body?.ok === true) {
        writeSeatDraftField(project, "requestId", "");
        /* Instant attach (issue #919's path): the receipt already names the
           durable conversation, so the card goes live — and the sheet hands off
           to the focused pane — now, instead of waiting a poll for the files
           feed to catch up. */
        const outcome = classifySpawnResponse(response.status, response.ok, body);
        if (outcome.kind === "launched") {
          const provisional = provisionalSpawnFile(
            createSpawnAttempt(clientRequestId, at, {
              title: derivedSpawnTitle("orchestrator", text, project),
              engine: payload.engine,
              model: payload.model,
              cwd: projectCwd,
              effort: payload.effort,
              fast: payload.engine === "codex" && payload.speed ? payload.speed === "fast" : null,
              accountId: payload.accountId,
              ["prompt"]: text,
              images: [],
              src: "",
            }),
            outcome,
            project,
          );
          if (provisional) applySpawnedConversationSnapshot(provisional);
        }
        requestFilesRefresh();
      } else if (response.ok) {
        /* Accepted, unreadable: the same standing as transport loss, so it takes
           the same route through — the key is KEPT and the retry replays the one
           durable intent. The seat read retires both the key and this banner as
           soon as the server says where that submission landed. */
        setSubmitFailure({
          kind: "ambiguous",
          error: typeof body?.error === "string" && body.error ? body.error : t("orchPanel.transportLost"),
          clientRequestId,
        });
      } else {
        const failure = classifySeatFailure(response.status, body, clientRequestId);
        /* A terminal refusal is durably recorded server-side; the next attempt
           carries a fresh key so an edited mandate is the one delivered. */
        if (failure?.kind === "terminal") writeSeatDraftField(project, "requestId", "");
        setSubmitFailure(failure);
      }
    } catch {
      /* Transport loss proves nothing: the seat may well have been designated,
         so the key is KEPT and the retry replays onto the same receipt. */
      setSubmitFailure({ kind: "ambiguous", error: t("orchPanel.transportLost"), clientRequestId });
    } finally {
      inFlight.current = false;
      setSubmitting(false);
      await refresh();
    }
  }, [project, projectCwd, refresh, t]);

  const openConversation = useCallback(() => {
    if (file) onOpenConversation(file);
  }, [file, onOpenConversation]);

  /**
   * Open the rotate draft — on the incumbent's OWN parameters.
   *
   * «The same draft, prefilled» is true only if those parameters are in hand
   * when the form MOUNTS: the shared launch module reads its defaults once, in
   * its initializers, so a draft opened before the status read answered would
   * prefill the generic orchestrator defaults and never correct itself. So the
   * read comes first and the button says it is working.
   */
  const openRotate = useCallback(async () => {
    const from = status?.seat?.conversationId ?? null;
    if (!from) {
      /* No seat to replace: the same draft, in create mode — what the board's
         invitation opens, reached here from a sheet that outlived its seat. */
      openSheet("rotate", { handoff: true, from: null });
      return;
    }
    setRotateOpening(true);
    try {
      await refreshIncumbent();
    } finally {
      setRotateOpening(false);
      setRotateFrom(from);
      /* The draft is its own sheet (§3.3): it REPLACES the seat sheet rather
         than stacking over it, so one close returns to the board and the
         platform's back gesture never lands between the two. */
      nav.openSheet("rotate");
    }
  }, [status?.seat?.conversationId, refreshIncumbent, nav, openSheet]);

  const rotateFlow: SeatRotateFlow = {
    open: rotating,
    seat: rotatingLive && state.kind === "live" ? state.seat : rotatingVacant ? status?.seat ?? null : null,
    vacated: rotatingVacant,
    opening: rotateOpening,
    submitting: rotate.submitting,
    failure: rotate.failure,
    onOpen: () => void openRotate(),
    onCancel: () => {
      setRotateFrom(null);
      openSheet("seat", { handoff: false, from: null });
    },
    onConfirm: (input) => {
      /* Arm the landing on the SUCCESSOR: the incumbent stays live under the
         draft for as long as the rotation takes, and must not be what lands. */
      setArm({ handoff: true, from: rotateFrom });
      void rotate.submit(input);
    },
  };

  /* The draft, opened by something other than the card — the board's footer
     invitation, a route restored onto it — is armed the way the card's own tap
     would have armed it. The landing belongs to the seat, not to the control
     that happened to ask for it. */
  const armed: SheetOpening | null = useMemo(
    () => arm ?? (openName === "rotate" ? { handoff: state.kind !== "live", from: rotateFrom } : null),
    [arm, openName, state.kind, rotateFrom],
  );

  /* The landing: the seat this sheet was opened to change now holds a
     conversation other than the one it was replacing, so the phone goes there. */
  const liveConversationId = state.kind === "live" ? state.conversationId : null;
  useEffect(() => {
    if (!armed?.handoff || liveConversationId === null || !file) return;
    if (armed.from !== null && armed.from === liveConversationId) return;
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- the handoff out of the sheet, once per created or rotated seat */
    setArm(null);
    setRotateFrom(null);
    nav.closeSheet();
    onOpenConversation(file);
  }, [armed, liveConversationId, file, nav, onOpenConversation]);

  const clock = now ?? Date.now() / 1000;
  /* The one reading, shared with the sheet this card's ⚙ opens. */
  const badge = seatBadgeReading(t, view, file, clock);
  /* What the seat is doing this minute, in its own words (README §10 P2-3):
     the plan step it published, else the goal it declared. Never a guess. */
  const nowLine = view.badge === "conversation" && file ? nowFragment(file) : null;
  /* Every meter on the phone fills with what REMAINS (README §5, P2-4). */
  const contextLeft = view.badge === "conversation" && typeof file?.ctx?.pct === "number"
    ? Math.max(0, 100 - file.ctx.pct)
    : null;

  /* WHICH sheet the card's own tap opens. A state that can only be ACTED on —
     a vacancy, and a designation that failed over one — opens the draft, which
     is the surface that creates or retries; every other state opens the seat's
     reading, which is where its own way forward lives. */
  const tapSheet: "seat" | "rotate" = state.kind === "draft" || state.kind === "intent-error" ? "rotate" : "seat";

  const rowAria = [
    view.shape === "invitation"
      ? t("orchMobile.rowCreateAria")
      : view.tap === "conversation"
        ? t("mobile2.seat.openAria", { state: badge.text })
        : t("orchMobile.rowStatusAria", { state: badge.text }),
    view.rotation ? t(view.rotation === "strongly_recommend" ? "orchPanel.rotationStrong" : "orchPanel.rotation") : "",
  ].filter(Boolean).join(" · ");

  const sheet = openName !== null ? (
    <MobileOrchestratorSheet
      project={project}
      projectName={projectName}
      projectCwd={projectCwd || undefined}
      sheet={openName}
      state={state}
      status={status}
      file={file}
      incumbent={incumbent}
      pendingMandate={status?.pending?.mandate ?? ""}
      viewerMcpRegistered={status?.viewerMcpRegistered === true}
      submitting={submitting}
      now={clock}
      rotate={rotateFlow}
      onConfirm={(payload) => void confirm(payload)}
      onRecheck={() => {
        void refresh();
        void refreshIncumbent();
        requestFilesRefresh();
        void refreshRuntime();
      }}
      onOpenConversation={() => {
        closeSheet();
        openConversation();
      }}
      onClose={closeSheet}
    />
  ) : null;

  return (
    <div
      className="flex w-full items-center gap-1 rounded-[12px] bg-card py-1.5 pl-3 pr-1 shadow-1"
      data-mobile2-seat-card={project}
      data-mobile2-seat-state={view.state}
      data-mobile2-seat-shape={view.shape}
      data-mobile2-seat-tap={view.tap}
      {...(view.rotation ? { "data-mobile2-seat-rotation": view.rotation } : {})}
      {...(view.transition ? { "data-mobile2-seat-transition": view.transition } : {})}
    >
      <button
        type="button"
        data-mobile2-seat-open
        {...(view.tap === "sheet" ? { "data-mobile2-open": tapSheet } : {})}
        onClick={() => {
          if (view.tap === "conversation") {
            openConversation();
            return;
          }
          openSheet(tapSheet, { handoff: state.kind !== "live", from: null });
        }}
        aria-label={rowAria}
        {...(view.tap === "sheet" ? { "aria-haspopup": "dialog" as const } : {})}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-[8px] px-0.5 py-1 text-left active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      >
        <SeatMark />
        {view.shape === "invitation" ? (
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-body font-semibold leading-tight text-primary">{t("mobile2.seat.none")}</span>
            <span data-mobile2-seat-invitation className="flex min-w-0 items-center text-ui font-semibold leading-tight text-accent">
              <span className="truncate">{t("mobile2.seat.create")}</span>
              <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
            </span>
          </span>
        ) : (
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate text-body font-semibold leading-tight text-primary">{t("mobile2.seat.title")}</span>
              <SeatBadge tone={badge.tone}>{badge.text}</SeatBadge>
              {view.rotation ? <RotateCw className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden /> : null}
            </span>
            {nowLine ? (
              <span data-mobile2-seat-now className="min-w-0 truncate text-label leading-tight text-secondary">{nowLine}</span>
            ) : null}
            {contextLeft === null ? null : (
              <MobileMeter left={contextLeft} label={t("mobile2.seat.contextAria", { percent: String(contextLeft) })} />
            )}
          </span>
        )}
      </button>
      {/* The seat's ⚙ (issue #1347): visible beside the card whenever the
          card's own tap is the conversation, so the one surface that opens the
          chat also shows where rotation and the seat's settings live. */}
      {view.tap === "conversation" ? (
        <button
          type="button"
          data-mobile2-open="seat"
          data-mobile2-seat-controls
          onClick={() => openSheet("seat", { handoff: false, from: null })}
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          aria-label={t("orchMobile.controlsAria")}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] text-secondary active:bg-sunken active:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <SlidersHorizontal className="h-[18px] w-[18px]" aria-hidden />
        </button>
      ) : null}
      {/* A designation riding ALONGSIDE the incumbent gets its own control: the
          card's tap still opens the chat, because a failed rotation must never
          be the thing that takes the conversation away. */}
      {view.transition ? (
        <button
          type="button"
          data-mobile2-seat-transition-open
          onClick={() => openSheet("seat", { handoff: false, from: null })}
          aria-haspopup="dialog"
          aria-label={t(view.transition === "error" ? "orchMobile.transitionAria" : "orchMobile.pendingAria")}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {view.transition === "error"
            ? <TriangleAlert className="h-[18px] w-[18px] text-danger" aria-hidden />
            : <LoaderCircle className="h-[18px] w-[18px] animate-spin text-accent" aria-hidden />}
        </button>
      ) : null}

      {sheet}
    </div>
  );
}
