"use client";

import { Bot, LoaderCircle, RotateCw, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { applySpawnedConversationSnapshot } from "@/hooks/useFiles";
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
import { engineBadge } from "../utils";
import {
  classifySeatFailure,
  deriveOrchestratorPanelState,
  newSeatRequestId,
  seatRequestSettled,
  type SeatSubmitFailure,
} from "../orchestrator/seatState";
import { useOrchestratorIncumbent } from "../orchestrator/useOrchestratorIncumbent";
import { useOrchestratorSeat, type OrchestratorSeatRead } from "../orchestrator/useOrchestratorSeat";
import { useSeatConfirm } from "../orchestrator/useSeatConfirm";
import { useSeatSurface } from "../orchestrator/useSeatSurface";
import { MobileOrchestratorSheet, type SeatConfirmPayload, type SeatRotateFlow } from "./MobileOrchestratorSheet";
import { readSeatDraftField, seatFlowStorage, writeSeatDraftField } from "./orchestratorDraftStorage";
import { ROW_STATE_LABEL, ROW_TONE, orchestratorRowView } from "./orchestratorRowState";

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

/**
 * The phone's pinned orchestrator row (PRD #976 slice C, issue #979).
 *
 * The operator picked this over a separate near-fullscreen window: *«maybe a
 * pin of the orchestrator conversation in the conversation list… and of course
 * a separate one per project»*. So this is a PINNED SLOT at the head of the
 * conversation strip — the phone's conversation list — and it is deliberately
 * NOT one of the strip's scrolling chips: a pinned thing that scrolls out of
 * view under a long board is not pinned, and the row must survive whatever the
 * board's own ordering does. It rides inside the strip row that
 * `./chatBudget` already budgets (`PERSISTENT_CHROME.focusStrip`), so the
 * chat-first contract — the transcript keeps 60% of the viewport — is
 * unchanged: this adds no new persistent row.
 *
 * A tap does one of two things, and which one is the whole design:
 *
 *  - a LIVE seat opens its conversation in the standard `MobileFocusView`
 *    (`onOpenConversation`), with the composer the phone already has. No second
 *    mobile chat surface exists, by decision.
 *  - every other state opens the fullscreen sheet, which is the only surface
 *    that can act on it: create, resume a stuck designation, read a terminal
 *    error, re-read an unavailable seat.
 *
 * A live seat gets a SECOND target beside the chip (issue #1347): its controls.
 * The desktop dock carries them in the incumbent header — who holds the seat,
 * Rotate, and the draft that adjusts the seat's settings — and the phone had
 * none of it: the row's tap opened the chat and nothing else, so an operator
 * on a phone could not find where rotation lived. The controls open the same
 * sheet on its live view; nothing there is a long-press, a menu, or an overflow
 * that touch never reveals.
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
export function MobileOrchestratorRow({
  project,
  projectName,
  files,
  seat,
  onOpenConversation,
}: {
  project: string;
  projectName: string;
  files: readonly FileEntry[];
  /** The parent's seat read, when it already has one. The phone board above
      this row must know which transcript holds the seat (the seat is the card,
      never also a row in the list), and that read is a 6 s poll — a second
      instance for the same key doubles every phone's seat traffic for one
      answer. Given a read, this row starts none of its own: the hook called
      with a null project issues no request and sets no interval. */
  seat?: OrchestratorSeatRead;
  /** Pins the seat's conversation as the focused pane — the standard mobile
      conversation surface, composer included. */
  onOpenConversation: (file: FileEntry) => void;
}) {
  const { t } = useLocale();
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
  const [sheet, setSheet] = useState<SheetOpening | null>(null);
  /* The conversation the open rotate draft is replacing. Non-null IS the rotate
     mode, and matching it against the current seat is what closes the draft the
     moment the successor lands — no completion callback, no stale flag. */
  const [rotateFrom, setRotateFrom] = useState<string | null>(null);
  /* Opening the rotate draft is a read first: see `openRotate`. */
  const [rotateOpening, setRotateOpening] = useState(false);

  const seatConversationId = status?.seat?.conversationId ?? null;
  const seated = Boolean(seatConversationId && status?.exists);
  /* The incumbent's wear and parameters are a question only while the sheet
     is showing them or a rotate draft is about to prefill from them: the row
     itself carries the board's own reading, so a phone that never opens the
     sheet never pays for the slower status poll. */
  const { incumbent: read, refresh: refreshIncumbent } = useOrchestratorIncumbent(project, seated && sheet !== null);
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
  });
  const view = orchestratorRowView(state, { conversationReady: Boolean(file) });

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
           durable conversation, so the row goes live — and the sheet hands off
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
    if (!from) return;
    setRotateOpening(true);
    try {
      await refreshIncumbent();
    } finally {
      setRotateOpening(false);
      setRotateFrom(from);
    }
  }, [status?.seat?.conversationId, refreshIncumbent]);

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
      setSheet({ handoff: false, from: null });
    },
    onConfirm: (input) => {
      /* Arm the landing on the SUCCESSOR: the incumbent stays live under the
         draft for as long as the rotation takes, and must not be what lands. */
      setSheet({ handoff: true, from: rotateFrom });
      void rotate.submit(input);
    },
  };

  /* The landing: the seat this sheet was opened to change now holds a
     conversation other than the one it was replacing, so the phone goes there. */
  const liveConversationId = state.kind === "live" ? state.conversationId : null;
  useEffect(() => {
    if (!sheet?.handoff || liveConversationId === null || !file) return;
    if (sheet.from !== null && sheet.from === liveConversationId) return;
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- the handoff out of the sheet, once per created or rotated seat */
    setSheet(null);
    setRotateFrom(null);
    onOpenConversation(file);
  }, [sheet, liveConversationId, file, onOpenConversation]);

  const tone = ROW_TONE[view.state];
  const stateWord = t(ROW_STATE_LABEL[view.state]);
  const incumbentLabel = file?.model?.trim() || (file ? engineBadge(file).label : "");
  /* A healthy seat says who it is and lets the dot carry «fine»; anything else
     spells the state out in words beside it — colour is never the only carrier. */
  const label = view.state === "draft"
    ? t("orchMobile.create")
    : !incumbentLabel
      ? stateWord
      : view.state === "live"
        ? incumbentLabel
        : `${incumbentLabel} · ${stateWord}`;
  const rowAria = [
    view.state === "draft"
      ? t("orchMobile.rowCreateAria")
      : view.tap === "conversation"
        ? t("orchMobile.rowLiveAria", { model: incumbentLabel || t("orchPanel.title"), state: stateWord })
        : t("orchMobile.rowStatusAria", { state: stateWord }),
    view.rotation ? t(view.rotation === "strongly_recommend" ? "orchPanel.rotationStrong" : "orchPanel.rotation") : "",
  ].filter(Boolean).join(" · ");

  return (
    <div
      className="flex shrink-0 items-center gap-1 border-r border-border px-1.5"
      data-orchestrator-row={project}
      data-orchestrator-row-state={view.state}
      data-orchestrator-row-tap={view.tap}
      {...(view.rotation ? { "data-orchestrator-row-rotation": view.rotation } : {})}
      {...(view.transition ? { "data-orchestrator-row-transition": view.transition } : {})}
    >
      <button
        type="button"
        data-orchestrator-row-open
        onClick={() => {
          if (view.tap === "conversation") {
            openConversation();
            return;
          }
          setSheet({ handoff: state.kind !== "live", from: null });
        }}
        aria-label={rowAria}
        title={rowAria}
        {...(view.tap === "sheet" ? { "aria-haspopup": "dialog" as const } : {})}
        className={`inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${tone.chip}`}
      >
        <Bot className="h-4 w-4 shrink-0" aria-hidden />
        <span className="max-w-[38vw] truncate">{label}</span>
        {view.state === "draft" ? null : (
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot} ${view.state === "creating" ? "animate-pulse" : ""}`} aria-hidden />
        )}
        {view.rotation ? <RotateCw className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden /> : null}
      </button>
      {/* The seat's controls (issue #1347): visible beside the chip whenever the
          chip's own tap is the conversation, so the one row that opens the
          chat also shows where rotation and the seat's settings live. */}
      {view.tap === "conversation" ? (
        <button
          type="button"
          data-orchestrator-row-controls
          onClick={() => setSheet({ handoff: false, from: null })}
          aria-haspopup="dialog"
          aria-label={t("orchMobile.controlsAria")}
          title={t("orchMobile.controlsAria")}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-control border border-border bg-canvas text-muted hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <SlidersHorizontal className="h-4 w-4" aria-hidden />
        </button>
      ) : null}
      {/* A designation riding ALONGSIDE the incumbent gets its own control: the
          row's tap still opens the chat, because a failed rotation must never be
          the thing that takes the conversation away. */}
      {view.transition ? (
        <button
          type="button"
          data-orchestrator-row-transition-open
          onClick={() => setSheet({ handoff: false, from: null })}
          aria-haspopup="dialog"
          aria-label={t(view.transition === "error" ? "orchMobile.transitionAria" : "orchMobile.pendingAria")}
          title={t(view.transition === "error" ? "orchMobile.transitionAria" : "orchMobile.pendingAria")}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-control border border-border bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {view.transition === "error"
            ? <TriangleAlert className="h-4 w-4 text-danger" aria-hidden />
            : <LoaderCircle className="h-4 w-4 animate-spin text-accent" aria-hidden />}
        </button>
      ) : null}

      {sheet ? (
        <MobileOrchestratorSheet
          project={project}
          projectName={projectName}
          projectCwd={projectCwd || undefined}
          state={state}
          status={status}
          file={file}
          incumbent={incumbent}
          pendingMandate={status?.pending?.mandate ?? ""}
          viewerMcpRegistered={status?.viewerMcpRegistered === true}
          submitting={submitting}
          rotate={rotateFlow}
          onConfirm={(payload) => void confirm(payload)}
          onRecheck={() => void refresh()}
          onOpenConversation={() => {
            setSheet(null);
            openConversation();
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </div>
  );
}
