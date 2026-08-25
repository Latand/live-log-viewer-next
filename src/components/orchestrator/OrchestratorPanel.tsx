"use client";

import { Bot, LoaderCircle, RefreshCw, RotateCcw, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  AgentLaunchControls,
  useAgentLaunchDraft,
  useLaunchAccountCatalog,
  type LaunchAccountCatalog,
  type LaunchDraftStorage,
} from "@/components/draft/AgentLaunchControls";
import { useLocale, type MessageKey } from "@/lib/i18n";
import {
  ORCHESTRATOR_PROMPT_VERSION,
  ORCHESTRATOR_SPAWN_CONFIG,
  ORCHESTRATOR_SYSTEM_PROMPT,
} from "@/lib/orchestrator/prompt";
import type { OrchestratorSeat } from "@/lib/orchestrator/seats";
import type { FileEntry } from "@/lib/types";

import { IncumbentHeader } from "./IncumbentHeader";
import type { OrchestratorIncumbent } from "./incumbent";
import { OrchestratorConversation } from "./OrchestratorConversation";
import {
  deriveOrchestratorPanelState,
  deriveRotateDraftState,
  orchestratorQuietBannerEligible,
  seatRequestSettled,
  type OrchestratorPanelState,
  type OrchestratorSeatStatus,
  type RotationHint,
  type SeatLiveness,
  type SeatTransition,
} from "./seatState";
import { useOrchestratorIncumbent } from "./useOrchestratorIncumbent";
import { useOrchestratorSeat } from "./useOrchestratorSeat";
import { useSeatConfirm, type SeatConfirmFlow } from "./useSeatConfirm";
import { useSeatSurface } from "./useSeatSurface";

/** Create and rotate keep SEPARATE drafts: they are different decisions about
    different orchestrators, and a half-written rotation must never overwrite the
    create draft the operator would need if the seat were vacated. */
const storageKey = (flow: string, project: string, name: string) => `llvOrchestrator${flow}:${project}:${name}`;

function readField(flow: string, project: string, name: string): string {
  if (typeof window === "undefined") return "";
  try {
    return window.sessionStorage.getItem(storageKey(flow, project, name)) ?? "";
  } catch {
    return "";
  }
}

function writeField(flow: string, project: string, name: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    if (value) window.sessionStorage.setItem(storageKey(flow, project, name), value);
    else window.sessionStorage.removeItem(storageKey(flow, project, name));
  } catch {
    /* private mode */
  }
}

const readDraftField = (project: string, name: string) => readField("Draft", project, name);
const writeDraftField = (project: string, name: string, value: string) => writeField("Draft", project, name, value);

/** One flow's persistence, as the shared launch module's own storage seam. */
const flowStorage = (flow: string, project: string): LaunchDraftStorage => ({
  read: (name) => readField(flow, project, name),
  write: (name, value) => writeField(flow, project, name, value),
});

/**
 * The per-project orchestrator surface (PRD #976 slices A and B).
 *
 * ONE panel, every state designed (`./seatState`):
 *
 *  - `draft` — the same launch pickers every other draft offers, plus the
 *    default mandate in a textarea the operator edits freely. The edited text
 *    IS what gets delivered; there is no second «mandate» concept anywhere in
 *    the UI, and no cwd field — the project's own root is the cwd.
 *  - `creating` — the durable receipt, while the seat intent settles.
 *  - `intent-error` — the stored terminal error, ABOVE the draft it came from,
 *    so the operator can read it, fix the mandate, and retry in place. Never
 *    hidden, never a dead end.
 *  - `live` / `stalled/dead` / `rotation-recommended` — the real conversation
 *    (`OrchestratorConversation`), under a header row that finally names the
 *    INCUMBENT (`./IncumbentHeader`): engine, model, account, context fullness.
 *  - `rotate` — the same draft form again, prefilled from the incumbent, over
 *    the conversation it is replacing. The server composes the handoff; a
 *    rotation that fails leaves the incumbent exactly where it was.
 *
 * Confirm goes to `POST /api/orchestrator/seat`, rotation to `POST
 * /api/orchestrator/rotate` — one durable intent each, idempotent on
 * `clientRequestId` (`./useSeatConfirm`) — and never to raw `/api/spawn`, which
 * would mint a worker with no seat behind it.
 *
 * NOTHING here rotates on its own. The recommendation is words; the button is
 * the only rotation in the product.
 */
export function OrchestratorPanel({
  project,
  projectName,
  projectCwd,
  files,
  onClose,
}: {
  project: string;
  projectName: string;
  projectCwd?: string;
  files: readonly FileEntry[];
  onClose: () => void;
}) {
  const { t } = useLocale();
  const { status, failed, refresh } = useOrchestratorSeat(project, projectCwd);
  const [formError, setFormError] = useState<string | null>(null);
  const [mandate, setMandateState] = useState(() => readDraftField(project, "mandate") || ORCHESTRATOR_SYSTEM_PROMPT);
  /* The conversation the open rotate draft is replacing. Non-null IS the rotate
     mode, and matching it against the current seat is what closes the draft the
     moment the successor lands — no completion callback, no stale flag. */
  const [rotateFrom, setRotateFrom] = useState<string | null>(null);
  /* Opening the rotate draft is a read first: see `openRotate`. */
  const [rotateOpening, setRotateOpening] = useState(false);

  /* ONE account catalog for both drafts: they offer the same accounts, and the
     rotate draft must not re-fetch `/api/accounts` every time it opens. */
  const catalog = useLaunchAccountCatalog();
  const draftStorage = useMemo(() => flowStorage("Draft", project), [project]);
  const rotateStorage = useMemo(() => flowStorage("Rotate", project), [project]);
  const launch = useAgentLaunchDraft({
    storage: draftStorage,
    catalog,
    initialEngine: ORCHESTRATOR_SPAWN_CONFIG.engine,
    initialModel: ORCHESTRATOR_SPAWN_CONFIG.model,
    initialEffort: ORCHESTRATOR_SPAWN_CONFIG.effort,
  });

  const setMandate = (value: string) => {
    setMandateState(value);
    /* Stored only while it differs from the default: an untouched draft should
       follow the approved prompt forward rather than pin yesterday's copy. */
    writeDraftField(project, "mandate", value === ORCHESTRATOR_SYSTEM_PROMPT ? "" : value);
  };

  const seatConversationId = status?.seat?.conversationId ?? null;
  const seated = Boolean(seatConversationId && status?.exists);
  const file = useMemo(
    () => (seatConversationId
      ? files.find((entry) => entry.conversationId === seatConversationId)
        ?? files.find((entry) => entry.path === status?.seat?.path)
        ?? null
      : null),
    [files, seatConversationId, status?.seat?.path],
  );
  const surface = useSeatSurface(file);
  /* The incumbent's wear is only a question while there IS an incumbent; a
     project sitting on its draft asks nothing. */
  const { incumbent: read, refresh: refreshIncumbent } = useOrchestratorIncumbent(project, seated);
  /* A reading is only about the conversation it names. Right after a rotation
     the seat has already advanced to the successor while this slower poll still
     describes the predecessor — showing that as «the incumbent» would put the
     retired orchestrator's model and context in the successor's header. */
  const incumbent = read && read.conversationId === seatConversationId ? read : null;
  useEffect(() => {
    if (seated) void refreshIncumbent();
  }, [seatConversationId, seated, refreshIncumbent]);

  const create = useSeatConfirm({ url: "/api/orchestrator/seat", project, storage: draftStorage, field: "requestId", status, refresh });
  const rotate = useSeatConfirm({ url: "/api/orchestrator/rotate", project, storage: rotateStorage, field: "requestId", status, refresh });

  const state = deriveOrchestratorPanelState({
    status,
    statusFailed: failed,
    /* Only one of the two flows can be in play — the create draft exists only
       without a seat, the rotate draft only with one — so their outcomes fold
       into the one derivation without ever masking each other. */
    submitting: create.submitting || rotate.submitting,
    submitFailure: create.failure ?? rotate.failure,
    file,
    surface,
    incumbent,
  });
  /**
   * A rotation whose outcome is not yet settled KEEPS the panel, even after the
   * incumbent's card is closed underneath it (`exists: false`).
   *
   * Vacancy is real and the panel does return to the draft (PRD decision 4),
   * once the rotation in the air has settled. Handing the surface to the
   * create draft there strands the rotation: its retained key is reachable only
   * from this flow, and the create draft's retry posts a DIFFERENT key at the
   * seat route, which refuses over a seat that is still designated. So the
   * rotate draft stays until its own outcome is known, and then gives way.
   */
  const rotateUnsettled = rotate.submitting
    || (rotate.failure !== null && !seatRequestSettled(status, rotate.failure.clientRequestId));
  const rotatingLive = state.kind === "live" && rotateFrom !== null && rotateFrom === state.conversationId;
  const rotatingVacant = state.kind !== "live" && rotateFrom !== null && rotateUnsettled && status?.seat != null;
  const rotating = rotatingLive || rotatingVacant;

  /** `replayRequestId` re-posts an EXISTING durable intent by its own key — the
      seat command then completes that intent with ITS original mandate, so the
      text sent here cannot become a second variant. */
  const confirmCreate = (replayRequestId?: string | null) => {
    const text = mandate.trim();
    if (!text) {
      setFormError(t("orchPanel.mandateRequired"));
      return;
    }
    setFormError(null);
    void create.submit({
      body: {
        project,
        mandate: text,
        engine: launch.engine,
        ...(launch.model ? { model: launch.model } : {}),
        ...(launch.effort ? { effort: launch.effort } : {}),
        ...(launch.engine === "codex" && launch.speed ? { fast: launch.speed === "fast" } : {}),
        ...(launch.launchAccountId ? { accountId: launch.launchAccountId } : {}),
        /* The project's own root, resolved by the shell — the operator never
           types a directory for their own project's orchestrator. Absent, the
           seat route resolves the project's newest checkout itself. */
        ...(projectCwd ? { cwd: projectCwd } : {}),
        /* Only an UNEDITED mandate is a version of the approved prompt; an
           edited one is bespoke and records no version. */
        ...(text === ORCHESTRATOR_SYSTEM_PROMPT.trim() ? { promptVersion: ORCHESTRATOR_PROMPT_VERSION } : {}),
        /* The seat OUTLIVES its conversation: closing the card leaves the
           record designated, and a plain spawn over a designated seat is
           refused as an accidental rotation. That refusal is right in general
           and wrong here — this draft exists BECAUSE the operator closed that
           conversation (PRD decision 4), so it says what it means and the
           «returns to draft» promise is one the button can keep. */
        ...(state.kind === "draft" && state.vacated ? { replaceIncumbent: true } : {}),
      },
      launch: { draft: launch, cwd: projectCwd ?? "", firstMessage: text },
    }, replayRequestId);
  };

  /**
   * Open the rotate draft — on the incumbent's OWN parameters.
   *
   * «The same draft, prefilled» (PRD decision 4) is true only if those
   * parameters are in hand when the form MOUNTS: the shared launch module reads
   * its defaults once, in its initializers, so a draft opened before the status
   * read answered prefills the generic orchestrator defaults and never corrects
   * itself. So the read comes first and the button says it is working.
   */
  const openRotate = async (conversationId: string) => {
    setRotateOpening(true);
    try {
      await refreshIncumbent();
    } finally {
      setRotateOpening(false);
      setRotateFrom(conversationId);
    }
  };

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col bg-card"
      data-orchestrator-panel={project}
      data-orchestrator-state={state.kind}
      data-orchestrator-mode={rotating ? "rotate" : "default"}
      aria-label={t("orchPanel.regionAria", { project: projectName })}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent" aria-hidden>
          <Bot className="h-4 w-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body font-semibold text-primary">{t("orchPanel.title")}</span>
          <span className="truncate text-caption text-muted" title={projectName}>{projectName}</span>
        </span>
        <StateBadge state={state} />
        <button
          type="button"
          onClick={onClose}
          aria-label={t("orchPanel.close")}
          title={t("orchPanel.close")}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </header>

      {state.kind === "loading" ? (
        <Centered>
          <LoaderCircle className="h-5 w-5 animate-spin text-muted" aria-hidden />
          <p className="text-ui text-muted" role="status">{t("orchPanel.loading")}</p>
        </Centered>
      ) : state.kind === "unavailable" ? (
        <Centered>
          <TriangleAlert className="h-6 w-6 text-warning" aria-hidden />
          <p className="max-w-[280px] text-body font-semibold text-primary" role="alert">{t("orchPanel.unavailable")}</p>
          <p className="max-w-[280px] text-ui text-muted">{t("orchPanel.unavailableHint")}</p>
          <SecondaryButton onClick={() => void refresh()}>{t("orchPanel.recheck")}</SecondaryButton>
        </Centered>
      ) : rotatingVacant && status?.seat ? (
        /* The seat's card was closed while this rotation was still in the air.
           The rotation is the live question, so it keeps the surface — with the
           vacancy stated above it — until it says where it landed. */
        <div className="flex min-h-0 flex-1 flex-col">
          <p className="shrink-0 border-b border-border bg-sunken px-3 py-1.5 text-ui text-secondary" role="status">
            {t("orchPanel.rotateVacated")}
          </p>
          <RotateDraft
            project={project}
            projectName={projectName}
            seat={status.seat}
            incumbent={incumbent}
            file={file}
            projectCwd={projectCwd}
            catalog={catalog}
            flow={rotate}
            status={status}
            onCancel={() => setRotateFrom(null)}
          />
        </div>
      ) : state.kind === "creating" ? (
        <Centered>
          <LoaderCircle className="h-5 w-5 animate-spin text-accent" aria-hidden />
          <p className="text-body font-semibold text-primary" role="status">{t("orchPanel.creating")}</p>
          <p className="max-w-[300px] text-ui text-muted">{t("orchPanel.creatingHint")}</p>
          {state.launchId ? (
            <p className="max-w-full truncate font-mono text-caption text-muted" title={state.launchId}>
              {t("orchPanel.receipt", { launchId: state.launchId })}
            </p>
          ) : null}
          {/* A designation is durably pending with nothing of ours on the wire:
              the request that accepted it died, and only a re-post of its OWN
              key converges it. Without this the panel spins forever with no
              action — so the way through is offered, and it cannot duplicate. */}
          {!create.submitting && state.clientRequestId ? (
            <>
              <p className="max-w-[300px] text-ui text-muted">{t("orchPanel.creatingStuck")}</p>
              <SecondaryButton onClick={() => confirmCreate(state.clientRequestId)}>
                {t("orchPanel.creatingResume")}
              </SecondaryButton>
            </>
          ) : null}
        </Centered>
      ) : state.kind === "live" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <IncumbentHeader
            incumbent={incumbent}
            file={file}
            catalog={catalog}
            predecessorConversationId={state.seat.predecessorConversationId}
            rotating={rotating}
            opening={rotateOpening}
            onRotate={() => void openRotate(state.conversationId)}
          />
          {/* The transition banner is how a designation in flight — or one that
              failed — reaches an operator who is NOT looking at the draft. With
              the rotate draft open it would say the same thing twice, once with
              a retry and once without, so the draft's own block is the one. */}
          {state.transition && !rotating ? <TransitionBanner transition={state.transition} /> : null}
          {state.rotation ? <RotationBanner rotation={state.rotation} /> : null}
          {rotating ? null : (
            <>
              {orchestratorQuietBannerEligible(state, file) ? (
                <p className="shrink-0 border-b border-border bg-warning-soft px-3 py-1.5 text-ui text-warning" role="status">
                  {t("orchPanel.stalled")}
                </p>
              ) : null}
              {/* Finished, and resumable IN PLACE: the composer below picks this
                  same conversation back up (§4 `resume`), so the operator is told
                  to type rather than left reading a green «live» badge on a
                  stopped agent. */}
              {state.liveness === "resumable" ? (
                <p className="shrink-0 border-b border-border bg-sunken px-3 py-1.5 text-ui text-secondary" role="status">
                  {t("orchPanel.resumable")}
                </p>
              ) : null}
            </>
          )}
          {rotating ? (
            <RotateDraft
              project={project}
              projectName={projectName}
              seat={state.seat}
              incumbent={incumbent}
              file={file}
              projectCwd={projectCwd}
              catalog={catalog}
              flow={rotate}
              status={status}
              onCancel={() => setRotateFrom(null)}
            />
          ) : file ? (
            <OrchestratorConversation file={file} />
          ) : (
            <Centered>
              <LoaderCircle className="h-5 w-5 animate-spin text-muted" aria-hidden />
              <p className="text-body font-semibold text-primary" role="status">{t("orchPanel.resolving")}</p>
              <p className="max-w-[300px] text-ui text-muted">{t("orchPanel.resolvingHint")}</p>
              <a
                href={"#c=" + encodeURIComponent(state.conversationId)}
                className="text-ui font-semibold text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                {t("orchPanel.openOnBoard")}
              </a>
            </Centered>
          )}
        </div>
      ) : (
        <OrchestratorDraft
          mode="create"
          state={state}
          mandate={mandate}
          edited={mandate !== ORCHESTRATOR_SYSTEM_PROMPT}
          formError={formError}
          submitting={create.submitting}
          projectName={projectName}
          cwd={projectCwd}
          launch={launch}
          viewerMcpRegistered={status?.viewerMcpRegistered === true}
          onMandate={setMandate}
          onRestore={() => setMandate(ORCHESTRATOR_SYSTEM_PROMPT)}
          onConfirm={() => confirmCreate()}
        />
      )}
    </section>
  );
}

/**
 * The rotate draft (PRD #976 decision 4): the SAME form, prefilled with the
 * incumbent's own parameters, over the conversation it would replace.
 *
 * Mounted only while it is open, which is what makes «prefilled» true: the
 * launch draft reads its initial engine/model/effort/account through the
 * injected storage, so the incumbent's values are the defaults and the
 * operator's edits are what persist over them.
 *
 * The handoff is NOT composed here. `POST /api/orchestrator/rotate` hands the
 * successor its predecessor's transcript path and the project's open tasks; the
 * text in this textarea is the MANDATE, and duplicating the handoff into it
 * would deliver the same instructions twice in two wordings.
 */
function RotateDraft({
  project,
  projectName,
  seat,
  incumbent,
  file,
  projectCwd,
  catalog,
  flow,
  status,
  onCancel,
}: {
  project: string;
  projectName: string;
  seat: OrchestratorSeat;
  incumbent: OrchestratorIncumbent | null;
  file: FileEntry | null;
  projectCwd?: string;
  catalog: LaunchAccountCatalog | null;
  flow: SeatConfirmFlow;
  status: OrchestratorSeatStatus | null;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const [formError, setFormError] = useState<string | null>(null);
  const [mandate, setMandateState] = useState(() => readField("Rotate", project, "mandate") || seat.mandate);
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
      read: (name) => readField("Rotate", project, name) || (inherited[name] ?? ""),
      write: (name, value) => writeField("Rotate", project, name, value),
    },
    catalog,
    initialEngine: ORCHESTRATOR_SPAWN_CONFIG.engine,
    initialModel: ORCHESTRATOR_SPAWN_CONFIG.model,
    initialEffort: ORCHESTRATOR_SPAWN_CONFIG.effort,
  });
  const state = deriveRotateDraftState({ status, submitFailure: flow.failure });
  /* The successor inherits the predecessor's checkout unless the operator says
     otherwise — so the rotate body carries no cwd at all, and the row below
     states which directory that is (issue #903). */
  const cwd = (incumbent?.cwd ?? null) ?? projectCwd;

  const confirm = () => {
    const text = mandate.trim();
    if (!text) {
      setFormError(t("orchPanel.mandateRequired"));
      return;
    }
    setFormError(null);
    void flow.submit({
      body: {
        project,
        mandate: text,
        engine: launch.engine,
        ...(launch.model ? { model: launch.model } : {}),
        ...(launch.effort ? { effort: launch.effort } : {}),
        ...(launch.engine === "codex" && launch.speed ? { fast: launch.speed === "fast" } : {}),
        ...(launch.launchAccountId ? { accountId: launch.launchAccountId } : {}),
      },
      launch: { draft: launch, cwd: cwd ?? "", firstMessage: text },
    });
  };

  return (
    <OrchestratorDraft
      mode="rotate"
      state={state}
      mandate={mandate}
      edited={mandate !== seat.mandate}
      formError={formError}
      submitting={flow.submitting}
      projectName={projectName}
      cwd={cwd}
      launch={launch}
      viewerMcpRegistered={status?.viewerMcpRegistered === true}
      onMandate={(value) => {
        setMandateState(value);
        writeField("Rotate", project, "mandate", value === seat.mandate ? "" : value);
      }}
      onRestore={() => {
        setMandateState(seat.mandate);
        writeField("Rotate", project, "mandate", "");
      }}
      onConfirm={confirm}
      onCancel={onCancel}
    />
  );
}

/**
 * The create draft, the rotate draft, and the surface an `intent-error` lands
 * ON. Keeping them one column is the point: a failed designation shows what went
 * wrong directly above the mandate that caused it, so «read the error, fix the
 * text, try again» is one place and one gesture instead of a dead-end error
 * screen — and a rotation that fails behaves exactly like a create that fails.
 */
function OrchestratorDraft({
  mode,
  state,
  mandate,
  edited,
  formError,
  submitting,
  projectName,
  cwd,
  launch,
  viewerMcpRegistered,
  onMandate,
  onRestore,
  onConfirm,
  onCancel,
}: {
  mode: "create" | "rotate";
  state: Extract<OrchestratorPanelState, { kind: "draft" } | { kind: "intent-error" }>;
  mandate: string;
  edited: boolean;
  formError: string | null;
  submitting: boolean;
  projectName: string;
  cwd?: string;
  launch: ReturnType<typeof useAgentLaunchDraft>;
  viewerMcpRegistered: boolean;
  onMandate: (value: string) => void;
  onRestore: () => void;
  onConfirm: () => void;
  onCancel?: () => void;
}) {
  const { t } = useLocale();
  const errored = state.kind === "intent-error";
  const rotate = mode === "rotate";
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      data-orchestrator-draft={mode}
      onSubmit={(event) => {
        event.preventDefault();
        onConfirm();
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        {errored ? (
          <div
            className="shrink-0 rounded-surface border border-danger/40 bg-danger-soft px-3 py-2.5"
            role="alert"
            data-orchestrator-intent-error
          >
            {/* A failed ROTATION says something different from a failed create,
                and the difference matters: the incumbent is still running. «Nothing
                is running» would be a lie exactly when the operator is deciding
                whether to try again. */}
            <p className="flex items-center gap-1.5 text-ui font-semibold text-danger">
              <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />
              {t(state.retry === "same"
                ? rotate ? "orchPanel.rotateErrorUnknownTitle" : "orchPanel.errorUnknownTitle"
                : rotate ? "orchPanel.rotateErrorTitle" : "orchPanel.errorTitle")}
            </p>
            <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words font-sans text-ui leading-4 text-secondary">
              {state.error}
            </pre>
            <p className="mt-1 text-caption text-muted">
              {t(state.retry === "same"
                ? rotate ? "orchPanel.rotateErrorUnknownHint" : "orchPanel.errorUnknownHint"
                : rotate ? "orchPanel.rotateErrorHint" : "orchPanel.errorHint")}
            </p>
          </div>
        ) : (
          <div className="shrink-0">
            <h2 className="text-title font-semibold text-primary">
              {t(rotate ? "orchPanel.rotateHeading" : "orchPanel.draftTitle")}
            </h2>
            <p className="mt-1 text-ui leading-4 text-muted">
              {rotate
                ? t("orchPanel.rotateHint")
                : t(state.kind === "draft" && state.vacated ? "orchPanel.draftHintVacated" : "orchPanel.draftHint", { project: projectName })}
            </p>
          </div>
        )}

        <p
          className="shrink-0 rounded-control border border-border bg-canvas px-3 py-2 font-mono text-caption text-secondary"
          data-viewer-mcp-status={viewerMcpRegistered ? "registered" : "missing"}
          role="status"
        >
          {t(viewerMcpRegistered ? "orchPanel.viewerMcpRegistered" : "orchPanel.viewerMcpMissing")}
        </p>

        <div className="shrink-0">
          <AgentLaunchControls draft={launch} disabled={submitting} stacked />
        </div>

        <div className="flex min-h-[220px] flex-1 flex-col gap-1">
          <div className="flex min-h-6 items-center gap-2">
            <label className="text-label font-semibold text-muted" htmlFor="orchestrator-mandate">
              {t("orchPanel.mandate")}
            </label>
            {edited ? (
              <button
                type="button"
                onClick={onRestore}
                disabled={submitting}
                className="inline-flex items-center gap-1 rounded-control border border-border bg-canvas px-2 py-0.5 text-caption font-semibold text-muted hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
              >
                <RotateCcw className="h-3 w-3" aria-hidden /> {t(rotate ? "orchPanel.restoreIncumbent" : "orchPanel.restoreDefault")}
              </button>
            ) : null}
            <span className="ml-auto shrink-0 text-caption text-muted">{t("orchPanel.mandateSent")}</span>
          </div>
          <textarea
            id="orchestrator-mandate"
            data-orchestrator-mandate
            value={mandate}
            disabled={submitting}
            onChange={(event) => onMandate(event.target.value)}
            spellCheck={false}
            /* The mandate is PROSE the agent reads, so it is sans (design
               system §1.1 mono rule) — the only mono here is the cwd below,
               which is a path. */
            className="min-h-[200px] w-full flex-1 resize-none rounded-surface border border-border bg-sunken px-3 py-2.5 text-ui leading-[1.45] text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
          />
          {cwd ? (
            <p className="truncate font-mono text-caption text-muted" title={cwd}>
              {t(rotate ? "orchPanel.cwdInherited" : "orchPanel.cwd", { cwd })}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-border bg-sunken px-4 py-3">
        {formError ? (
          <p className="text-ui font-semibold text-danger" role="alert">{formError}</p>
        ) : null}
        <div className="flex items-center gap-2">
          {onCancel ? (
            <button
              type="button"
              data-orchestrator-rotate-cancel
              onClick={onCancel}
              disabled={submitting}
              className="inline-flex h-9 shrink-0 items-center justify-center rounded-control border border-border bg-card px-3 text-ui font-semibold text-secondary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
            >
              {t("orchPanel.rotateCancel")}
            </button>
          ) : null}
          <button
            type="submit"
            data-orchestrator-confirm
            disabled={submitting}
            className="inline-flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-control border border-accent bg-accent px-3 text-body font-semibold text-white shadow-1 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
          >
            {submitting
              ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
              : rotate
                ? <RefreshCw className="h-4 w-4" aria-hidden />
                : <Bot className="h-4 w-4" aria-hidden />}
            <span className="truncate">
              {t(errored ? "orchPanel.confirmRetry" : rotate ? "orchPanel.rotateConfirm" : "orchPanel.confirm")}
            </span>
          </button>
        </div>
      </div>
    </form>
  );
}

const QUIET_BADGE = "border-border bg-canvas text-muted";
const DANGER_BADGE = "border-danger/40 bg-danger-soft text-danger";

/** One row per liveness, so a tone can never drift from the word beside it —
    and green is claimed ONLY by a conversation that is actually hosted. */
const LIVENESS_BADGE: Record<SeatLiveness, { tone: string; key: MessageKey }> = {
  live: { tone: "border-success/45 bg-success-soft text-success", key: "orchPanel.badgeLive" },
  stalled: { tone: "border-warning/45 bg-warning-soft text-warning", key: "orchPanel.badgeStalled" },
  resumable: { tone: QUIET_BADGE, key: "orchPanel.badgeResumable" },
  dead: { tone: DANGER_BADGE, key: "orchPanel.badgeDead" },
  resolving: { tone: QUIET_BADGE, key: "orchPanel.badgeResolving" },
};

function StateBadge({ state }: { state: OrchestratorPanelState }) {
  const { t } = useLocale();
  const live = state.kind === "live" ? LIVENESS_BADGE[state.liveness] : null;
  const tone = live
    ? live.tone
    : state.kind === "intent-error"
      ? DANGER_BADGE
      : state.kind === "creating"
        ? "border-accent/45 bg-accent-soft text-accent"
        : QUIET_BADGE;
  const label = live
    ? t(live.key)
    : t(state.kind === "creating"
      ? "orchPanel.badgeCreating"
      : state.kind === "intent-error"
        ? "orchPanel.badgeFailed"
        : state.kind === "draft"
          ? "orchPanel.badgeNone"
          : "orchPanel.badgeReading");
  return (
    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-caption font-semibold ${tone}`}>{label}</span>
  );
}

function TransitionBanner({ transition }: { transition: SeatTransition }) {
  const { t } = useLocale();
  if (transition.kind === "creating") {
    return (
      <p className="flex shrink-0 items-center gap-1.5 border-b border-border bg-accent-soft px-3 py-1.5 text-ui text-accent" role="status">
        <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
        {t("orchPanel.transitionPending")}
      </p>
    );
  }
  return (
    <div
      className="shrink-0 border-b border-danger/40 bg-danger-soft px-3 py-1.5"
      role="alert"
      data-orchestrator-intent-error
    >
      <p className="flex items-center gap-1.5 text-ui font-semibold text-danger">
        <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {t("orchPanel.transitionFailed")}
      </p>
      <p className="mt-0.5 whitespace-pre-wrap break-words text-caption leading-4 text-secondary">{transition.error}</p>
    </div>
  );
}

/**
 * The advisory, and NOTHING else. It says what the server recommends and why;
 * the Rotate button in the header above is the only thing that acts, and only
 * when the operator presses it. Reaching a threshold has never rotated anything
 * and does not start here.
 */
function RotationBanner({ rotation }: { rotation: RotationHint }) {
  const { t } = useLocale();
  const summary = rotation.reasons.map((reason) => (
    reason === "context"
      ? t("orchPanel.rotationContext", { percent: String(rotation.contextPercent ?? 0) })
      : t("orchPanel.rotationDead")
  )).join(" · ");
  return (
    <div className="shrink-0 border-b border-warning/45 bg-warning-soft px-3 py-1.5" role="status" data-orchestrator-rotation={rotation.level}>
      <p className="text-ui font-semibold text-warning">
        {t(rotation.level === "strongly_recommend" ? "orchPanel.rotationStrong" : "orchPanel.rotation")}
      </p>
      {summary ? <p className="mt-0.5 text-caption leading-4 text-secondary">{summary}</p> : null}
      {/* The server's own reasons, verbatim: each names the threshold it crossed
          and whether the number behind it is an estimate. Re-wording them here is
          how the panel and `get_orchestrator` would start disagreeing. */}
      {rotation.notes?.length ? (
        <ul className="mt-0.5 list-disc pl-3.5 text-caption leading-4 text-muted marker:text-muted/60">
          {rotation.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-8 text-center">{children}</div>
  );
}

function SecondaryButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center gap-1.5 rounded-control border border-border bg-card px-3 text-ui font-semibold text-primary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      {children}
    </button>
  );
}
