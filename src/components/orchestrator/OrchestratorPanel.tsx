"use client";

import { Bot, LoaderCircle, RotateCcw, TriangleAlert, X } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { AgentLaunchControls, useAgentLaunchDraft } from "@/components/draft/AgentLaunchControls";
import { applySpawnedConversationSnapshot } from "@/hooks/useFiles";
import { requestFilesRefresh } from "@/lib/filesEvents";
import { useLocale } from "@/lib/i18n";
import {
  ORCHESTRATOR_PROMPT_VERSION,
  ORCHESTRATOR_SPAWN_CONFIG,
  ORCHESTRATOR_SYSTEM_PROMPT,
} from "@/lib/orchestrator/prompt";
import type { FileEntry } from "@/lib/types";

import {
  classifySpawnResponse,
  createSpawnAttempt,
  provisionalSpawnFile,
  type SpawnResponseBody,
} from "../draftSpawn";
import { OrchestratorConversation } from "./OrchestratorConversation";
import {
  classifySeatFailure,
  deriveOrchestratorPanelState,
  newSeatRequestId,
  type OrchestratorPanelState,
  type RotationHint,
  type SeatSubmitFailure,
  type SeatTransition,
} from "./seatState";
import { useOrchestratorSeat } from "./useOrchestratorSeat";
import { useSeatHostDead } from "./useSeatHostDead";

const storageKey = (project: string, name: string) => `llvOrchestratorDraft:${project}:${name}`;

function readDraftField(project: string, name: string): string {
  if (typeof window === "undefined") return "";
  try {
    return window.sessionStorage.getItem(storageKey(project, name)) ?? "";
  } catch {
    return "";
  }
}

function writeDraftField(project: string, name: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    if (value) window.sessionStorage.setItem(storageKey(project, name), value);
    else window.sessionStorage.removeItem(storageKey(project, name));
  } catch {
    /* private mode */
  }
}

/**
 * The per-project orchestrator surface (PRD #976 slice A).
 *
 * ONE panel, SIX states, every one of them designed (`./seatState`):
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
 *    (`OrchestratorConversation`), with the liveness and the rotation advisory
 *    stated in its own header row.
 *
 * Confirm goes to `POST /api/orchestrator/seat` — designate and inject, one
 * durable intent, idempotent on `clientRequestId` — and never to raw
 * `/api/spawn`, which would mint a worker with no seat behind it.
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
  const { status, failed, refresh } = useOrchestratorSeat(project);
  const [submitting, setSubmitting] = useState(false);
  /* The guard has to be SYNCHRONOUS: two clicks in one event batch both read
     the same render's `submitting`, so a state flag alone lets the second one
     through. The seat route would still converge them onto one designation
     (same key), but the second reply would land as a spurious in-progress
     error over a perfectly good create. */
  const inFlight = useRef(false);
  const [submitFailure, setSubmitFailure] = useState<SeatSubmitFailure | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [mandate, setMandateState] = useState(() => readDraftField(project, "mandate") || ORCHESTRATOR_SYSTEM_PROMPT);

  const launch = useAgentLaunchDraft({
    storage: {
      read: (name) => readDraftField(project, name),
      write: (name, value) => writeDraftField(project, name, value),
    },
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
  const file = useMemo(
    () => (seatConversationId
      ? files.find((entry) => entry.conversationId === seatConversationId)
        ?? files.find((entry) => entry.path === status?.seat?.path)
        ?? null
      : null),
    [files, seatConversationId, status?.seat?.path],
  );
  const hostDead = useSeatHostDead(file);
  const state = deriveOrchestratorPanelState({ status, statusFailed: failed, submitting, submitFailure, file, hostDead });

  /** `replayRequestId` re-posts an EXISTING durable intent by its own key — the
      seat command then completes that intent with ITS original mandate, so the
      text sent here cannot become a second variant. */
  const confirm = useCallback(async (replayRequestId?: string | null) => {
    if (inFlight.current) return;
    const text = mandate.trim();
    if (!text) {
      setFormError(t("orchPanel.mandateRequired"));
      return;
    }
    inFlight.current = true;
    setFormError(null);
    /* ONE key per draft submission, not per click (issue #977 acceptance): it is
       minted on the first confirm and persisted, so a double-click, a reload
       mid-POST and an ambiguous retry all replay onto the same durable intent
       instead of designating twice. Cleared only once the attempt is terminal —
       a corrected mandate must arrive under a NEW key, because the seat command
       completes the ORIGINAL intent when a pending key is replayed. */
    const stored = replayRequestId || readDraftField(project, "requestId");
    const clientRequestId = stored || newSeatRequestId();
    if (readDraftField(project, "requestId") !== clientRequestId) writeDraftField(project, "requestId", clientRequestId);
    setSubmitting(true);
    setSubmitFailure(null);
    const at = Date.now();
    try {
      const response = await fetch("/api/orchestrator/seat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project,
          mandate: text,
          clientRequestId,
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
        }),
      });
      const body = (await response.json().catch(() => null)) as (SpawnResponseBody & { code?: string }) | null;
      if (response.ok && body?.ok !== false) {
        writeDraftField(project, "requestId", "");
        /* Instant attach (issue #919's path): the receipt already names the
           durable conversation, so the panel opens the live window now instead
           of waiting a poll for the files feed to catch up. */
        const outcome = classifySpawnResponse(response.status, response.ok, body);
        if (outcome.kind === "launched") {
          const provisional = provisionalSpawnFile(
            createSpawnAttempt(clientRequestId, at, {
              engine: launch.engine,
              model: launch.model,
              cwd: projectCwd ?? "",
              effort: launch.effort,
              fast: launch.engine === "codex" && launch.speed ? launch.speed === "fast" : null,
              accountId: launch.launchAccountId,
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
      } else {
        const failure = classifySeatFailure(response.status, body);
        /* A terminal refusal is durably recorded server-side; the next attempt
           carries a fresh key so an edited mandate is the one delivered. */
        if (failure?.kind === "terminal") writeDraftField(project, "requestId", "");
        setSubmitFailure(failure);
      }
    } catch {
      /* Transport loss proves nothing: the seat may well have been designated,
         so the key is KEPT and the retry replays onto the same receipt. */
      setSubmitFailure({ kind: "ambiguous", error: t("orchPanel.transportLost") });
    } finally {
      inFlight.current = false;
      setSubmitting(false);
      await refresh();
    }
  }, [mandate, project, projectCwd, launch, refresh, t]);

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col bg-card"
      data-orchestrator-panel={project}
      data-orchestrator-state={state.kind}
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
          {!submitting && state.clientRequestId ? (
            <>
              <p className="max-w-[300px] text-ui text-muted">{t("orchPanel.creatingStuck")}</p>
              <SecondaryButton onClick={() => void confirm(state.clientRequestId)}>
                {t("orchPanel.creatingResume")}
              </SecondaryButton>
            </>
          ) : null}
        </Centered>
      ) : state.kind === "live" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {state.transition ? <TransitionBanner transition={state.transition} /> : null}
          {state.rotation ? <RotationBanner rotation={state.rotation} /> : null}
          {state.liveness === "stalled" ? (
            <p className="shrink-0 border-b border-border bg-warning-soft px-3 py-1.5 text-ui text-warning" role="status">
              {t("orchPanel.stalled")}
            </p>
          ) : null}
          {file ? (
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
          state={state}
          mandate={mandate}
          edited={mandate !== ORCHESTRATOR_SYSTEM_PROMPT}
          formError={formError}
          submitting={submitting}
          projectName={projectName}
          projectCwd={projectCwd}
          launch={launch}
          onMandate={setMandate}
          onRestore={() => setMandate(ORCHESTRATOR_SYSTEM_PROMPT)}
          onConfirm={() => void confirm()}
        />
      )}
    </section>
  );
}

/**
 * The create draft, and the surface an `intent-error` lands ON. Keeping them one
 * column is the point: a failed designation shows what went wrong directly above
 * the mandate that caused it, so «read the error, fix the text, try again» is
 * one place and one gesture instead of a dead-end error screen.
 */
function OrchestratorDraft({
  state,
  mandate,
  edited,
  formError,
  submitting,
  projectName,
  projectCwd,
  launch,
  onMandate,
  onRestore,
  onConfirm,
}: {
  state: Extract<OrchestratorPanelState, { kind: "draft" } | { kind: "intent-error" }>;
  mandate: string;
  edited: boolean;
  formError: string | null;
  submitting: boolean;
  projectName: string;
  projectCwd?: string;
  launch: ReturnType<typeof useAgentLaunchDraft>;
  onMandate: (value: string) => void;
  onRestore: () => void;
  onConfirm: () => void;
}) {
  const { t } = useLocale();
  const errored = state.kind === "intent-error";
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
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
                <RotateCcw className="h-3 w-3" aria-hidden /> {t("orchPanel.restoreDefault")}
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
          {projectCwd ? (
            <p className="truncate font-mono text-caption text-muted" title={projectCwd}>
              {t("orchPanel.cwd", { cwd: projectCwd })}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-border bg-sunken px-4 py-3">
        {formError ? (
          <p className="text-ui font-semibold text-danger" role="alert">{formError}</p>
        ) : null}
        <button
          type="submit"
          data-orchestrator-confirm
          disabled={submitting}
          className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-control border border-accent bg-accent px-3 text-body font-semibold text-white shadow-1 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
        >
          {submitting ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : <Bot className="h-4 w-4" aria-hidden />}
          {t(errored ? "orchPanel.confirmRetry" : "orchPanel.confirm")}
        </button>
      </div>
    </form>
  );
}

function StateBadge({ state }: { state: OrchestratorPanelState }) {
  const { t } = useLocale();
  const tone = state.kind === "live"
    ? state.liveness === "dead"
      ? "border-danger/40 bg-danger-soft text-danger"
      : state.liveness === "stalled"
        ? "border-warning/45 bg-warning-soft text-warning"
        : "border-success/45 bg-success-soft text-success"
    : state.kind === "intent-error"
      ? "border-danger/40 bg-danger-soft text-danger"
      : state.kind === "creating"
        ? "border-accent/45 bg-accent-soft text-accent"
        : "border-border bg-canvas text-muted";
  const label = state.kind === "live"
    ? t(state.liveness === "dead"
      ? "orchPanel.badgeDead"
      : state.liveness === "stalled"
        ? "orchPanel.badgeStalled"
        : state.liveness === "resolving"
          ? "orchPanel.badgeResolving"
          : "orchPanel.badgeLive")
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

/** The advisory, and NOTHING else: rotation happens only when the operator asks
    for it, and the ask itself lands in slice B (#978). */
function RotationBanner({ rotation }: { rotation: RotationHint }) {
  const { t } = useLocale();
  return (
    <div className="shrink-0 border-b border-warning/45 bg-warning-soft px-3 py-1.5" role="status" data-orchestrator-rotation={rotation.level}>
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
