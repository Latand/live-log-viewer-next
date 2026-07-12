import crypto from "node:crypto";

import { isEngineEffort } from "@/lib/agent/efforts";
import { isCodexLaunchModel, normalizeClaudeLaunchModel } from "@/lib/agent/models";
import { agentRegistry } from "@/lib/agent/registry";
import { headCwd } from "@/lib/agent/transcript";
import { livePaneTarget } from "@/lib/delivery";
import { isShellCommand } from "@/lib/status";
import { killPane, paneInfo } from "@/lib/tmux";
import type { FileEntry } from "@/lib/types";

import { isoNow, lastRound, newRound, sendToImplementer } from "./engine";
import { clearHeadlessReviewArtifacts, forgetHeadlessReview } from "./exec";
import { resolveBaseRef, resolveFlowMergeIdentity } from "./git";
import { kickoffPrompt } from "./prompts";
import { configuredReviewerFallback, loadFlows, loadPresets, saveFlows } from "./store";
import type { CreateFlowRequest, Flow, PatchFlowRequest, RoleConfig, Round } from "./types";

/**
 * User-facing flow commands: creating a flow from an HTTP request and the
 * PATCH actions (pause/resume/advance/retry/extend/close). The poller-driven
 * transitions live in engine.ts; these are the transitions a human triggers.
 */

function validateRole(value: unknown): RoleConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const role = value as Partial<RoleConfig>;
  if (role.engine !== "claude" && role.engine !== "codex") return null;
  return {
    engine: role.engine,
    model: typeof role.model === "string" && role.model.trim() ? role.model.trim() : null,
    effort: typeof role.effort === "string" && role.effort.trim() ? role.effort.trim() : null,
  };
}

/**
 * Merges a partial role override (issue #118 on-canvas stage controls) onto the
 * flow's current role config, field by field: engine must stay claude/codex,
 * model/effort blank out to the engine default. Returns null on an invalid
 * engine so the caller can 400 instead of silently keeping the old value.
 */
export function applyRoleOverride(current: RoleConfig, patch: unknown): RoleConfig | null {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return null;
  const p = patch as Partial<RoleConfig>;
  const next: RoleConfig = { ...current };
  if (p.engine !== undefined) {
    if (p.engine !== "claude" && p.engine !== "codex") return null;
    next.engine = p.engine;
  }
  if (p.model !== undefined) {
    if (p.model !== null && typeof p.model !== "string") return null;
    next.model = typeof p.model === "string" && p.model.trim() ? p.model.trim() : null;
  }
  if (p.effort !== undefined) {
    if (p.effort !== null && typeof p.effort !== "string") return null;
    next.effort = typeof p.effort === "string" && p.effort.trim() ? p.effort.trim() : null;
  }
  /* Validate the MERGED config through the canonical launch validators, not just
     primitive shapes (issue #118 Finding 3): a claude+gpt / codex+fable / bad
     effort combination must be rejected here rather than persisting and failing at
     the next reviewer launch. */
  if (next.model) {
    if (next.engine === "claude" && !normalizeClaudeLaunchModel(next.model)) return null;
    if (next.engine === "codex" && !isCodexLaunchModel(next.model)) return null;
  }
  if (next.effort && !isEngineEffort(next.engine, next.effort)) return null;
  return next;
}

export function rolesFromRequest(req: CreateFlowRequest): Record<"implementer" | "reviewer", RoleConfig> | null {
  const presets = loadPresets();
  if (req.preset) {
    const preset = presets.find((item) => item.name === req.preset);
    if (!preset) return null;
    return { implementer: { ...preset.implementer }, reviewer: { ...preset.reviewer } };
  }
  const implementer = validateRole(req.roles?.implementer);
  const reviewer = validateRole(req.roles?.reviewer);
  if (!implementer || !reviewer) return null;
  return { implementer, reviewer };
}

export function normalizeFlowSpec(value: unknown): { ok: true; spec?: string } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string") return { ok: false };
  const spec = value.trim();
  return spec ? { ok: true, spec } : { ok: true };
}

export async function createFlowFromRequest(req: CreateFlowRequest, entries: FileEntry[]): Promise<{ flow?: Flow; error?: string; status?: number }> {
  const entry = entries.find((item) => item.path === req.implementerPath);
  if (!entry) return { error: "implementer transcript is unknown", status: 404 };
  if (entry.root !== "claude-projects" && entry.root !== "codex-sessions") {
    return { error: "implementer must be a Claude or Codex session", status: 400 };
  }
  const normalizedSpec = normalizeFlowSpec(req.spec);
  if (!normalizedSpec.ok) {
    return { error: "spec must be a string", status: 400 };
  }
  const roles = rolesFromRequest(req);
  if (!roles) return { error: "invalid flow roles or preset", status: 400 };
  const baseMode = req.baseMode === "merge-base" ? "merge-base" : "head";
  const cwd = headCwd(entry.path);
  if (!cwd) return { error: "could not determine the session working directory", status: 409 };
  const base =
    typeof req.baseRef === "string" && req.baseRef.trim()
      ? { ok: true as const, sha: req.baseRef.trim() }
      : resolveBaseRef(cwd, baseMode);
  if (!base.ok) return { error: base.error, status: 409 };
  const flows = loadFlows();
  const existing = flows.find((flow) => flow.implementerPath === entry.path && flow.closedAt === null && flow.state !== "closed");
  if (existing) return { error: "implementer already has an active flow", status: 409 };
  const flow: Flow = {
    id: crypto.randomUUID().slice(0, 8),
    template: "implement-review-loop",
    project: entry.project,
    cwd,
    implementerPath: entry.path,
    implementerConversationId: entry.conversationId ?? null,
    roles,
    reviewerFallback: roles.reviewer.engine === "codex" ? configuredReviewerFallback() : null,
    baseRef: base.sha,
    ...(normalizedSpec.spec ? { spec: normalizedSpec.spec } : {}),
    baseMode,
    mode: req.mode === "manual" ? "manual" : "auto",
    reviewerMode: req.reviewerMode === "pane" ? "pane" : "headless",
    roundLimit: Number.isInteger(req.roundLimit) && req.roundLimit > 0 ? Math.min(req.roundLimit, 50) : 5,
    state: "waiting_ready",
    pausedState: null,
    stateDetail: null,
    mergeEvidence: (() => {
      const identity = resolveFlowMergeIdentity(cwd);
      return identity ? { ...identity, prNumber: null, mergedAt: null, checkedAt: null, source: null } : null;
    })(),
    kickoffDelivery: null,
    rounds: [],
    createdAt: isoNow(),
    closedAt: null,
  };
  flows.push(flow);
  saveFlows(flows);
  try {
    const deliveryPath = await sendToImplementer(flow, new Map(entries.map((item) => [item.path, item])), kickoffPrompt(flow.spec));
    flow.kickoffDelivery = { path: deliveryPath, deliveredAt: isoNow() };
    saveFlows(flows);
  } catch (error) {
    flow.state = "paused";
    flow.pausedState = "waiting_ready";
    flow.stateDetail = error instanceof Error ? error.message : String(error);
    saveFlows(flows);
  }
  return { flow };
}

/** The transmissible cap for a round's ready note: anything longer is truncated
    here, so producers (e.g. the pipeline's reviewNote) must fit within it. */
export const MAX_FLOW_NOTE_LENGTH = 2_000;

/**
 * The next-round note from a PATCH body as a THREE-state value (issue #118
 * review): `undefined` = the field was omitted, so leave the round's note
 * untouched; `null` = an explicit empty string, so CLEAR the note; a trimmed
 * string = set it. This lets an operator actually erase a previously-set note
 * instead of the old blank-becomes-omitted behavior that silently kept it.
 */
function noteFieldFromRequest(req: PatchFlowRequest): string | null | undefined {
  if (typeof req.note !== "string") return undefined;
  const trimmed = req.note.trim();
  return trimmed ? trimmed.slice(0, MAX_FLOW_NOTE_LENGTH) : null;
}

/**
 * Kills whatever executes the round's review right now: the headless child
 * through its run registry, a pane reviewer through its tmux pane. Best
 * effort — the pane may already be gone. The pane handle captured at spawn
 * is authoritative (it exists before the scanner attributes a transcript);
 * the window-name check guards against pane-id reuse after a tmux server
 * restart. The transcript lookup is the fallback for rounds persisted before
 * the handle existed.
 */
async function stopReviewer(flow: Flow, round: Round): Promise<void> {
  forgetHeadlessReview(flow.id, round.n, round);
  if (flow.reviewerMode !== "pane") return;
  try {
    const pane = round.reviewerPane;
    if (pane) {
      const info = await paneInfo(pane.paneId);
      if (info && info.windowName === pane.windowName && !isShellCommand(info.command)) {
        await killPane(pane.paneId);
      }
    } else if (round.reviewerPath) {
      const currentPath = round.reviewerConversationId?.startsWith("conversation_")
        ? agentRegistry().conversation(round.reviewerConversationId as `conversation_${string}`)?.generations.at(-1)?.path ?? round.reviewerPath
        : agentRegistry().canonicalPath(round.reviewerPath);
      const target = await livePaneTarget(currentPath);
      if (target !== null) await killPane(target);
    }
  } catch {
    /* pane already closed */
  }
}

/**
 * Stops the round's reviewer mid-run. The flow lands in needs_decision,
 * where retry-round (optionally with a user note for the next reviewer) or
 * extend/close already exist.
 */
export async function cancelRound(id: string): Promise<{ flow?: Flow; error?: string; status?: number }> {
  const flows = loadFlows();
  const flow = flows.find((item) => item.id === id);
  if (!flow) return { error: "flow not found", status: 404 };
  const round = lastRound(flow);
  if (flow.state !== "reviewing" || !round) {
    return { error: "no reviewer is running for this flow", status: 409 };
  }
  await stopReviewer(flow, round);
  round.error = "cancelled by user";
  round.terminalAt = isoNow();
  flow.state = "needs_decision";
  flow.stateDetail = "round cancelled by user";
  saveFlows(flows);
  return { flow };
}

/**
 * One-click teardown: whatever the flow is doing, stop the reviewer that may
 * still run and close the loop. The implementer session is untouched — only
 * the reviewer side goes away.
 */
export async function closeFlow(id: string): Promise<{ flow?: Flow; error?: string; status?: number }> {
  const flows = loadFlows();
  const flow = flows.find((item) => item.id === id);
  if (!flow) return { error: "flow not found", status: 404 };
  const round = lastRound(flow);
  if (round && round.verdict === null && !round.error) {
    await stopReviewer(flow, round);
    round.error = "flow closed by user";
    round.terminalAt = isoNow();
  }
  flow.state = "closed";
  flow.closedAt = isoNow();
  flow.stateDetail = null;
  saveFlows(flows);
  return { flow };
}

export function patchFlow(id: string, req: PatchFlowRequest): { flow?: Flow; error?: string; status?: number } {
  const flows = loadFlows();
  const flow = flows.find((item) => item.id === id);
  if (!flow) return { error: "flow not found", status: 404 };
  const round = lastRound(flow);
  if (req.action === "pause") {
    if (flow.state !== "paused" && flow.state !== "closed") {
      flow.pausedState = flow.state;
      flow.state = "paused";
      flow.stateDetail = "paused by user";
    }
  } else if (req.action === "resume") {
    if (flow.state === "paused") {
      flow.state = flow.pausedState && flow.pausedState !== "paused" ? flow.pausedState : "waiting_ready";
      flow.pausedState = null;
      flow.stateDetail = null;
    }
  } else if (req.action === "set-mode") {
    if (req.mode !== "auto" && req.mode !== "manual") return { error: "mode must be auto or manual", status: 400 };
    flow.mode = req.mode;
  } else if (req.action === "advance") {
    const note = noteFieldFromRequest(req);
    if (flow.state === "waiting_ready") {
      /* A brand-new round: an omitted or cleared note both mean "no note". */
      flow.rounds.push(newRound(flow, "button", note ?? null));
      flow.state = flow.mode === "manual" ? "spawn_pending" : "spawning";
    } else if (flow.state === "spawn_pending") {
      /* The round exists but has not spawned yet, so a freshly edited note must
         still reach the next reviewer (issue #118 Finding 4): manual mode creates
         the round at waiting_ready→spawn_pending, then the operator can revise the
         note before the spawn. `undefined` (field omitted) leaves it; a string sets
         it; `null` (explicit empty) clears it (issue #118 review Finding 2). */
      if (note !== undefined && round) round.readyNote = note;
      flow.state = "spawning";
    } else if (flow.state === "relay_pending") {
      flow.state = "relaying";
    } else {
      return { error: "flow cannot advance from its current state", status: 409 };
    }
    flow.stateDetail = null;
  } else if (req.action === "retry-round") {
    if (flow.state !== "needs_decision" || !round) return { error: "flow cannot retry from its current state", status: 409 };
    forgetHeadlessReview(flow.id, round.n, round);
    clearHeadlessReviewArtifacts(flow.id, round.n);
    /* The note travels to the fresh reviewer. An omitted field keeps the round's
       existing note; a string replaces it; an explicit empty clears it. */
    const noteField = noteFieldFromRequest(req);
    Object.assign(round, {
      reviewerPath: null,
      reviewerConversationId: null,
      accountId: null,
      attemptedAccounts: [],
      autoRetryCount: 0,
      sessionId: null,
      reviewerPid: null,
      reviewerIdentity: null,
      reviewerPane: null,
      findingsPath: null,
      verdict: null,
      findingsCount: null,
      /* A retry launches a fresh reviewer, so it re-freezes the current reviewer
         role — this is where a prior set-roles override takes effect. */
      reviewerRole: { ...flow.roles.reviewer },
      readyNote: noteField === undefined ? round.readyNote : noteField,
      reviewHeadSha: null,
      startedAt: isoNow(),
      spawnStartedAt: null,
      launchId: null,
      launchLeaseUntil: null,
      relayStartedAt: null,
      relayDelivery: null,
      reviewedAt: null,
      terminalAt: null,
      relayedAt: null,
      error: null,
    });
    flow.state = flow.mode === "manual" ? "spawn_pending" : "spawning";
    flow.stateDetail = null;
  } else if (req.action === "extend") {
    const add = Number.isInteger(req.rounds) && req.rounds && req.rounds > 0 ? Math.min(req.rounds, 20) : 1;
    /* Extending an unlimited flow is a no-op with the same resume side effect. */
    if (flow.roundLimit > 0) flow.roundLimit += add;
    if (flow.state === "needs_decision") {
      flow.state = "waiting_ready";
      flow.stateDetail = null;
    }
  } else if (req.action === "set-round-limit") {
    const raw = req.rounds;
    if (!Number.isInteger(raw) || raw === undefined || raw < 0 || raw > 50) {
      return { error: "rounds must be an integer 0–50 (0 = unlimited)", status: 400 };
    }
    /* Rounds already run stay counted: the limit never drops below them. */
    flow.roundLimit = raw === 0 ? 0 : Math.max(raw, flow.rounds.length);
    /* A flow parked only because the old limit ran out resumes when the new
       limit allows more rounds; error/cancel parks keep waiting for a human. */
    if (
      flow.state === "needs_decision" &&
      flow.stateDetail === "round limit reached" &&
      (flow.roundLimit === 0 || flow.roundLimit > flow.rounds.length)
    ) {
      flow.state = "waiting_ready";
      flow.stateDetail = null;
    }
  } else if (req.action === "another-round") {
    if (flow.state !== "done_comment") return { error: "flow is not waiting for another round", status: 409 };
    flow.closedAt = null;
    flow.state = "waiting_ready";
    flow.stateDetail = null;
  } else if (req.action === "set-roles") {
    if (flow.state === "closed") return { error: "flow is closed", status: 409 };
    /* Reviewer-only: the implementer is an attached live session that cannot be
       reseated in place, so it is not overridable here (see PatchFlowRequest). */
    const patch = req.roles && typeof req.roles === "object" && !Array.isArray(req.roles) ? req.roles.reviewer : undefined;
    if (patch === undefined) return { error: "reviewer role override is required", status: 400 };
    const merged = applyRoleOverride(flow.roles.reviewer, patch);
    if (!merged) return { error: "invalid reviewer role override", status: 400 };
    flow.roles = { ...flow.roles, reviewer: merged };
    /* Manual mode parks a created-but-unspawned round at spawn_pending with its
       role already frozen (newRound/retry snapshot it). The override must reach
       THAT round too, or the imminent Spawn launches with the old config while the
       UI reports success (issue #118 review). A round already spawning/reviewing
       kept its frozen snapshot — spawnStartedAt is set there, so it is left alone;
       only a genuinely unstarted pending round is re-snapshotted. */
    const pending = flow.state === "spawn_pending" || (flow.state === "paused" && flow.pausedState === "spawn_pending")
      ? round
      : null;
    if (pending && pending.spawnStartedAt == null) pending.reviewerRole = { ...merged };
  }
  /* "close" and "cancel-round" never reach this function — the route sends
     them to closeFlow/cancelRound, which also stop a running reviewer. */
  if (round && flow.state === "spawning") round.error = null;
  saveFlows(flows);
  return { flow };
}
