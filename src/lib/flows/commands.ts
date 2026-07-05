import crypto from "node:crypto";

import { headCwd } from "@/lib/agent/transcript";
import { livePaneTarget } from "@/lib/delivery";
import { killPane } from "@/lib/tmux";
import type { FileEntry } from "@/lib/types";

import { isoNow, lastRound, newRound, sendToImplementer } from "./engine";
import { forgetHeadlessReview } from "./exec";
import { resolveBaseRef } from "./git";
import { kickoffPrompt } from "./prompts";
import { loadFlows, loadPresets, saveFlows } from "./store";
import type { CreateFlowRequest, Flow, PatchFlowRequest, RoleConfig } from "./types";

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

export async function createFlowFromRequest(req: CreateFlowRequest, entries: FileEntry[]): Promise<{ flow?: Flow; error?: string; status?: number }> {
  const entry = entries.find((item) => item.path === req.implementerPath);
  if (!entry) return { error: "implementer transcript is unknown", status: 404 };
  if (entry.root !== "claude-projects" && entry.root !== "codex-sessions") {
    return { error: "implementer must be a Claude or Codex session", status: 400 };
  }
  const roles = rolesFromRequest(req);
  if (!roles) return { error: "invalid flow roles or preset", status: 400 };
  const baseMode = req.baseMode === "merge-base" ? "merge-base" : "head";
  const cwd = headCwd(entry.path);
  if (!cwd) return { error: "не вдалося визначити робочу директорію сесії", status: 409 };
  const base = resolveBaseRef(cwd, baseMode);
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
    roles,
    baseRef: base.sha,
    baseMode,
    mode: req.mode === "manual" ? "manual" : "auto",
    reviewerMode: req.reviewerMode === "pane" ? "pane" : "headless",
    roundLimit: Number.isInteger(req.roundLimit) && req.roundLimit > 0 ? Math.min(req.roundLimit, 50) : 5,
    state: "waiting_ready",
    pausedState: null,
    stateDetail: null,
    rounds: [],
    createdAt: isoNow(),
    closedAt: null,
  };
  flows.push(flow);
  saveFlows(flows);
  try {
    await sendToImplementer(flow, new Map(entries.map((item) => [item.path, item])), kickoffPrompt());
  } catch (error) {
    flow.state = "paused";
    flow.pausedState = "waiting_ready";
    flow.stateDetail = error instanceof Error ? error.message : String(error);
    saveFlows(flows);
  }
  return { flow };
}

/** Trimmed user note from a PATCH body, or null when absent/blank. */
function noteFromRequest(req: PatchFlowRequest): string | null {
  return typeof req.note === "string" && req.note.trim() ? req.note.trim().slice(0, 2000) : null;
}

/**
 * Stops the round's reviewer mid-run: the headless child gets killed through
 * its run registry, a pane reviewer loses its tmux pane. The flow lands in
 * needs_decision, where retry-round (optionally with a user note for the
 * next reviewer) or extend/close already exist.
 */
export async function cancelRound(id: string): Promise<{ flow?: Flow; error?: string; status?: number }> {
  const flows = loadFlows();
  const flow = flows.find((item) => item.id === id);
  if (!flow) return { error: "flow not found", status: 404 };
  const round = lastRound(flow);
  if (flow.state !== "reviewing" || !round) {
    return { error: "no reviewer is running for this flow", status: 409 };
  }
  forgetHeadlessReview(flow.id, round.n);
  if (flow.reviewerMode === "pane" && round.reviewerPath) {
    /* Best-effort: the pane may already be gone, or the scanner may not have
       attributed a pid yet — the cancel still stands either way. */
    try {
      const target = await livePaneTarget(round.reviewerPath);
      if (target !== null) await killPane(target);
    } catch {
      /* pane already closed */
    }
  }
  round.error = "cancelled by user";
  flow.state = "needs_decision";
  flow.stateDetail = "round cancelled by user";
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
    if (flow.state === "waiting_ready") {
      flow.rounds.push(newRound(flow, "button", noteFromRequest(req)));
      flow.state = flow.mode === "manual" ? "spawn_pending" : "spawning";
    } else if (flow.state === "spawn_pending") {
      flow.state = "spawning";
    } else if (flow.state === "relay_pending") {
      flow.state = "relaying";
    } else {
      return { error: "flow cannot advance from its current state", status: 409 };
    }
    flow.stateDetail = null;
  } else if (req.action === "retry-round") {
    if (flow.state !== "needs_decision" || !round) return { error: "flow cannot retry from its current state", status: 409 };
    forgetHeadlessReview(flow.id, round.n);
    Object.assign(round, {
      reviewerPath: null,
      sessionId: null,
      findingsPath: null,
      verdict: null,
      findingsCount: null,
      /* A user note travels to the fresh reviewer as the round's ready note. */
      readyNote: noteFromRequest(req) ?? round.readyNote,
      startedAt: isoNow(),
      spawnStartedAt: null,
      relayStartedAt: null,
      reviewedAt: null,
      relayedAt: null,
      error: null,
    });
    flow.state = flow.mode === "manual" ? "spawn_pending" : "spawning";
    flow.stateDetail = null;
  } else if (req.action === "extend") {
    const add = Number.isInteger(req.rounds) && req.rounds && req.rounds > 0 ? Math.min(req.rounds, 20) : 1;
    flow.roundLimit += add;
    if (flow.state === "needs_decision") {
      flow.state = "waiting_ready";
      flow.stateDetail = null;
    }
  } else if (req.action === "another-round") {
    if (flow.state !== "done_comment") return { error: "flow is not waiting for another round", status: 409 };
    flow.closedAt = null;
    flow.state = "waiting_ready";
    flow.stateDetail = null;
  } else if (req.action === "close") {
    flow.state = "closed";
    flow.closedAt = isoNow();
    flow.stateDetail = null;
  }
  if (round && flow.state === "spawning") round.error = null;
  saveFlows(flows);
  return { flow };
}
