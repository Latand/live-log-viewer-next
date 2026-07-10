import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { freshSpecFor } from "@/lib/agent/cli";
import { accountManager } from "@/lib/accounts/manager";
import { resolveSpawnedTranscriptPath } from "@/lib/agent/spawnedTranscript";
import { headCwd } from "@/lib/agent/transcript";
import { closeFlow, createFlowFromRequest, patchFlow as patchReviewFlow } from "@/lib/flows/commands";
import { lastAssistantMessage } from "@/lib/flows/findings";
import { loadFlows } from "@/lib/flows/store";
import type { CreateFlowRequest, Flow, RoleConfig } from "@/lib/flows/types";
import { persistHandoffLineage, rememberHandoffChild } from "@/lib/handoffLineage";
import { isNativeCodexSubagentTranscript } from "@/lib/scanner/codexNative";
import { projectForCwd } from "@/lib/scanner/describe";
import { isShellCommand } from "@/lib/status";
import { paneInfo, spawnAgentWithPrompt } from "@/lib/tmux";
import type { FileEntry } from "@/lib/types";

import { realExec, provisionWorktree, runFinish, setupStatus, startSetup, type ExecPort, type SetupStatus } from "./provision";
import { fixerKickoff, prBody, stageKickoff } from "./prompts";
import { buildWorkflow, loadTemplates, loadWorkflows, normalizeStages, saveWorkflows, setupExitPath } from "./store";
import type {
  CreateWorkflowRequest,
  PatchWorkflowRequest,
  ReviewStage,
  Workflow,
  WorkflowStageRun,
  WorkflowState,
  WorkflowTemplate,
} from "./types";

/**
 * The workflow state machine (docs/design/agent-workflows.md). tickWorkflows
 * runs beside tickFlows on the same /api/files poll; every side effect goes
 * through the ports object, so the whole machine tests without tmux, git or
 * a real flow engine.
 */

const TERMINAL_STATES = new Set<WorkflowState>(["approved", "closed"]);
/* Parked states wait for a human PATCH; the poller leaves them alone. */
const PARKED_STATES = new Set<WorkflowState>(["needs_decision", "paused"]);
const STAGE_DONE_RE = /^STAGE_DONE:\s*(.*)$/m;

export interface StageSpawn {
  paneId: string;
  transcript: string | null;
  panePid: number | null;
}

export interface WorkflowPorts {
  exec: ExecPort;
  startSetup(wf: Workflow): { pid: number | null; error?: string };
  setupStatus(wf: Workflow): SetupStatus;
  spawnAgent(role: RoleConfig, cwd: string, prompt: string, accountId?: string | null): Promise<StageSpawn>;
  /** The pane still hosts a non-shell foreground process. */
  paneAgentAlive(paneId: string): Promise<boolean>;
  headCwd(transcriptPath: string): string | null;
  lastMessage(entry: FileEntry): { text: string; ts: number } | null;
  createFlow(req: CreateFlowRequest, entries: FileEntry[]): Promise<{ flow?: Flow; error?: string }>;
  advanceFlow(id: string, note: string): void;
  closeFlow(id: string): Promise<unknown>;
  getFlow(id: string): Flow | null;
  /** Newest flow bound to this implementer, for restart adoption. */
  findFlowByImplementer(implementerPath: string): Flow | null;
  /** Scanner project key of a directory (worktrees resolve to the main repo). */
  projectForCwd(cwd: string): string | null;
  linkChild(childPath: string, parentPath: string): void;
  now(): string;
}

export function defaultPorts(): WorkflowPorts {
  return {
    exec: realExec,
    startSetup,
    setupStatus,
    spawnAgent: async (role, cwd, prompt, accountId) => {
      const account = accountManager.resolveSpawn(role.engine, accountId);
      const spec = freshSpecFor(role.engine, cwd, { model: role.model, effort: role.effort, codexHome: account.engine === "codex" ? account.home : null, claudeConfigDir: account.engine === "claude" ? account.home : null, claudeProjectsDir: account.engine === "claude" ? account.transcriptRoot : null });
      const startedAtMs = Date.now();
      const pane = await spawnAgentWithPrompt(spec, prompt);
      const transcript = await resolveSpawnedTranscriptPath({
        engine: role.engine,
        knownTranscript: spec.transcript ?? null,
        panePid: pane.panePid ?? null,
        cwd,
        startedAtMs,
        codexSessionsDir: account.engine === "codex" ? account.transcriptRoot : null,
      });
      return { paneId: pane.paneId, transcript, panePid: pane.panePid ?? null };
    },
    paneAgentAlive: async (paneId) => {
      const info = await paneInfo(paneId);
      return info !== null && !isShellCommand(info.command);
    },
    headCwd: (transcriptPath) => headCwd(transcriptPath),
    lastMessage: lastAssistantMessage,
    createFlow: createFlowFromRequest,
    advanceFlow: (id, note) => void patchReviewFlow(id, { action: "advance", note }),
    closeFlow,
    getFlow: (id) => loadFlows().find((flow) => flow.id === id) ?? null,
    findFlowByImplementer: (implementerPath) =>
      loadFlows()
        .filter((flow) => flow.implementerPath === implementerPath)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] ?? null,
    projectForCwd,
    linkChild: (child, parent) => {
      rememberHandoffChild(child, parent);
      persistHandoffLineage();
    },
    now: () => new Date().toISOString(),
  };
}

/* Spawns started by this process: a persisted startedAt without a pane and
   without this in-memory mark means the spawn was cut by a restart. */
const spawnsThisProcess = new Set<string>();

function spawnKey(wf: Workflow, run: WorkflowStageRun): string {
  return `${wf.id}:${run.index}`;
}

/** Park the workflow for a human decision, remembering the phase to retry. */
function park(wf: Workflow, detail: string): void {
  wf.pausedState = wf.state;
  wf.state = "needs_decision";
  wf.stateDetail = detail;
}

function currentRun(wf: Workflow): WorkflowStageRun | null {
  return wf.stageRuns[wf.stageIndex] ?? null;
}

function reviewStageOf(wf: Workflow): ReviewStage | null {
  const stage = wf.template.stages.at(-1);
  return stage?.kind === "review-loop" ? stage : null;
}

function unixMs(value: string | null): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/** STAGE_DONE detection, with the same finished-turn guard as REVIEW_READY:
    interim narration mid-turn may carry the marker over a half-done tree. */
function detectStageDone(run: WorkflowStageRun, entry: FileEntry, ports: WorkflowPorts): string | null {
  if (entry.activity === "live" || entry.activityReason === "jsonl_turn_open" || entry.activityReason === "jsonl_turn_stalled") {
    return null;
  }
  const message = ports.lastMessage(entry);
  if (!message) return null;
  if (message.ts <= unixMs(run.startedAt)) return null;
  return message.text.match(STAGE_DONE_RE)?.[1]?.trim() ?? null;
}

/** Transcript paths already owned by this workflow's stages. */
function claimedPaths(wf: Workflow): Set<string> {
  const set = new Set<string>();
  for (const run of wf.stageRuns) if (run.agentPath) set.add(run.agentPath);
  if (wf.fixerPath) set.add(wf.fixerPath);
  return set;
}

function isNativeCodexSubagentEntry(entry: FileEntry): boolean {
  return entry.root === "codex-sessions" && entry.path.endsWith(".jsonl") && isNativeCodexSubagentTranscript(entry.path, entry.size);
}

/**
 * Claims the freshest unowned conversation of the right engine born in the
 * worktree after the spawn — the same heuristic flows use for codex
 * reviewers, whose transcript path is unknowable at spawn time.
 */
function claimTranscript(wf: Workflow, run: WorkflowStageRun, role: RoleConfig, entries: FileEntry[], ports: WorkflowPorts): string | null {
  const started = unixMs(run.startedAt) / 1000 - 5;
  const taken = claimedPaths(wf);
  const hit = entries
    .filter(
      (entry) =>
        entry.engine === role.engine &&
        (entry.root === "claude-projects" || entry.root === "codex-sessions") &&
        !entry.path.includes(path.sep + "subagents" + path.sep) &&
        entry.mtime >= started &&
        !taken.has(entry.path) &&
        !isNativeCodexSubagentEntry(entry) &&
        ports.headCwd(entry.path) === wf.worktreeDir,
    )
    .sort((a, b) => b.mtime - a.mtime)[0];
  return hit?.path ?? null;
}

/** The transcript the freshly claimed agent descends from, for board arrows. */
function lineageParent(wf: Workflow, stageIndex: number): string | null {
  for (let i = stageIndex - 1; i >= 0; i -= 1) {
    const prev = wf.stageRuns[i];
    if (prev?.agentPath) return prev.agentPath;
  }
  return wf.srcPath ?? null;
}

function roleForStage(wf: Workflow, index: number): RoleConfig | null {
  const stage = wf.template.stages[index];
  if (stage?.kind === "implement") return stage.agent;
  if (stage?.kind === "review-loop") return stage.fixer;
  return null;
}

/** Moves past a completed stage: the next implement stage or the review loop. */
function advanceStage(wf: Workflow): void {
  wf.stageIndex += 1;
  const next = wf.template.stages[wf.stageIndex];
  wf.state = next?.kind === "review-loop" ? "reviewing" : "implementing";
  wf.stateDetail = null;
}

async function ensureStageAgent(
  wf: Workflow,
  run: WorkflowStageRun,
  role: RoleConfig,
  prompt: string,
  entries: FileEntry[],
  ports: WorkflowPorts,
  persistCheckpoint: () => void,
): Promise<"spawning" | "waiting" | "ready"> {
  if (!run.startedAt) {
    run.startedAt = ports.now();
    if (!run.accountId) run.accountId = accountManager.resolveSpawn(role.engine).accountId;
    spawnsThisProcess.add(spawnKey(wf, run));
    persistCheckpoint();
    try {
      const spawned = await ports.spawnAgent(role, wf.worktreeDir, prompt, run.accountId);
      run.paneId = spawned.paneId;
      if (spawned.transcript) {
        run.agentPath = spawned.transcript;
        const parent = lineageParent(wf, run.index);
        if (parent) ports.linkChild(spawned.transcript, parent);
      }
    } catch (error) {
      park(wf, error instanceof Error ? error.message : String(error));
    }
    return "spawning";
  }
  if (!run.paneId && !spawnsThisProcess.has(spawnKey(wf, run))) {
    park(wf, "stage agent spawn was interrupted by a restart");
    return "spawning";
  }
  if (!run.agentPath) {
    const claimed = claimTranscript(wf, run, role, entries, ports);
    if (claimed) {
      run.agentPath = claimed;
      const parent = lineageParent(wf, run.index);
      if (parent) ports.linkChild(claimed, parent);
      return "ready";
    }
    if (run.paneId && !(await ports.paneAgentAlive(run.paneId))) {
      park(wf, "stage agent died before its transcript appeared");
    }
    return "waiting";
  }
  return "ready";
}

async function tickProvisioning(wf: Workflow, ports: WorkflowPorts, persistCheckpoint: () => void): Promise<void> {
  if (!wf.baseRef) {
    const res = provisionWorktree(wf, ports.exec);
    if (!res.ok) {
      park(wf, res.error);
      return;
    }
    wf.baseBranch = res.baseBranch;
    wf.baseRef = res.baseRef;
    persistCheckpoint();
  }
  if (wf.template.setup) {
    if (wf.setupPid == null && ports.setupStatus(wf).status !== "done") {
      const started = ports.startSetup(wf);
      if (started.pid == null) {
        park(wf, started.error ?? "setup failed to start");
        return;
      }
      wf.setupPid = started.pid;
      return;
    }
    const status = ports.setupStatus(wf);
    if (status.status === "running") return;
    if (status.status === "failed") {
      park(wf, status.detail);
      return;
    }
  }
  wf.state = "implementing";
  wf.stateDetail = null;
}

async function tickImplementing(
  wf: Workflow,
  entries: FileEntry[],
  entriesByPath: Map<string, FileEntry>,
  ports: WorkflowPorts,
  persistCheckpoint: () => void,
): Promise<void> {
  const run = currentRun(wf);
  const role = roleForStage(wf, wf.stageIndex);
  if (!run || !role) {
    park(wf, "stage index points outside the template");
    return;
  }
  if (run.doneAt) {
    /* The barrier (W1): auto mode advances, manual mode holds the boundary
       gate until the user presses advance. */
    if (wf.mode === "auto") advanceStage(wf);
    return;
  }
  const agent = await ensureStageAgent(wf, run, role, stageKickoff(wf, wf.stageIndex), entries, ports, persistCheckpoint);
  if (agent !== "ready") return;
  const entry = entriesByPath.get(run.agentPath!);
  if (!entry) return; // scanner has not picked the transcript up yet
  const note = detectStageDone(run, entry, ports);
  if (note !== null) {
    run.doneAt = ports.now();
    run.doneNote = note || null;
    if (wf.mode === "auto") advanceStage(wf);
    return;
  }
  if (run.paneId && !(await ports.paneAgentAlive(run.paneId))) {
    park(wf, "stage agent pane died before STAGE_DONE");
  }
}

async function tickReviewing(
  wf: Workflow,
  entries: FileEntry[],
  ports: WorkflowPorts,
  persistCheckpoint: () => void,
): Promise<void> {
  const run = currentRun(wf);
  const stage = reviewStageOf(wf);
  if (!run || !stage) {
    park(wf, "the template has no review-loop stage");
    return;
  }
  if (run.doneAt) {
    if (wf.mode === "auto") {
      wf.state = "finishing";
      wf.stateDetail = null;
    }
    return;
  }
  const agent = await ensureStageAgent(wf, run, stage.fixer, fixerKickoff(wf), entries, ports, persistCheckpoint);
  if (agent !== "ready") return;
  if (!wf.fixerPath) wf.fixerPath = run.agentPath;

  if (!wf.flowId) {
    /* A restart between flow creation and the flowId write leaves an orphaned
       flow bound to the fixer — adopt it instead of colliding on create. */
    const existing = ports.findFlowByImplementer(wf.fixerPath!);
    if (existing) {
      wf.flowId = existing.id;
      return;
    }
    const created = await ports.createFlow(
      {
        implementerPath: wf.fixerPath!,
        roles: { implementer: stage.fixer, reviewer: stage.reviewer },
        baseMode: "head",
        baseRef: wf.baseRef,
        mode: wf.mode,
        reviewerMode: stage.reviewerMode,
        roundLimit: stage.roundLimit,
      },
      entries,
    );
    if (!created.flow) {
      park(wf, `creating the review flow failed: ${created.error ?? "unknown error"}`);
      return;
    }
    wf.flowId = created.flow.id;
    persistCheckpoint();
    /* The stages already produced the work under review, so round 1 starts
       right away instead of waiting for a REVIEW_READY the fixer has no
       reason to print yet. */
    ports.advanceFlow(wf.flowId, `Workflow "${wf.name}": review the full diff from the captured base ref.`);
    return;
  }

  const flow = ports.getFlow(wf.flowId);
  if (!flow) {
    park(wf, "the embedded review flow record disappeared");
    return;
  }
  if (flow.state === "approved") {
    run.doneAt = ports.now();
    run.doneNote = `review approved after ${flow.rounds.length} round(s)`;
    if (wf.mode === "auto") {
      wf.state = "finishing";
      wf.stateDetail = null;
    }
    return;
  }
  if (flow.state === "done_comment") park(wf, "review ended with a COMMENT verdict");
  else if (flow.state === "needs_decision") park(wf, `review loop needs a decision: ${flow.stateDetail ?? "unknown reason"}`);
  else if (flow.state === "closed") park(wf, "the embedded review flow was closed");
}

function tickFinishing(wf: Workflow, ports: WorkflowPorts): void {
  const flow = wf.flowId ? ports.getFlow(wf.flowId) : null;
  const res = runFinish(wf, prBody(wf, flow?.rounds ?? []), ports.exec);
  if (!res.ok) {
    park(wf, res.error);
    return;
  }
  wf.prUrl = res.prUrl;
  wf.state = "approved";
  wf.stateDetail = null;
  wf.closedAt = ports.now();
}

async function tickWorkflow(
  wf: Workflow,
  entries: FileEntry[],
  entriesByPath: Map<string, FileEntry>,
  ports: WorkflowPorts,
  persistCheckpoint: () => void,
): Promise<boolean> {
  const before = JSON.stringify(wf);
  if (wf.state === "provisioning") await tickProvisioning(wf, ports, persistCheckpoint);
  else if (wf.state === "implementing") await tickImplementing(wf, entries, entriesByPath, ports, persistCheckpoint);
  else if (wf.state === "reviewing") await tickReviewing(wf, entries, ports, persistCheckpoint);
  else if (wf.state === "finishing") tickFinishing(wf, ports);
  return JSON.stringify(wf) !== before;
}

const store = globalThis as unknown as { __llvWorkflowTick?: boolean };

interface TickResult {
  workflows: Workflow[];
  changed: boolean;
}

export async function tickWorkflows(entries: FileEntry[], ports: WorkflowPorts = defaultPorts()): Promise<TickResult> {
  if (store.__llvWorkflowTick) return { workflows: loadWorkflows(), changed: false };
  store.__llvWorkflowTick = true;
  try {
    const workflows = loadWorkflows();
    const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
    let changed = false;
    for (const wf of workflows) {
      if (TERMINAL_STATES.has(wf.state) || PARKED_STATES.has(wf.state)) continue;
      if (await tickWorkflow(wf, entries, entriesByPath, ports, () => saveWorkflows(workflows))) changed = true;
      if (changed) saveWorkflows(workflows);
    }
    if (changed) saveWorkflows(workflows);
    return { workflows, changed };
  } finally {
    store.__llvWorkflowTick = false;
  }
}

/** Trimmed user note from a PATCH body, or null when absent/blank. */
function noteFromRequest(req: PatchWorkflowRequest): string | null {
  return typeof req.note === "string" && req.note.trim() ? req.note.trim().slice(0, 2000) : null;
}

function resetRun(run: WorkflowStageRun): void {
  Object.assign(run, { agentPath: null, paneId: null, startedAt: null, doneAt: null, doneNote: null });
}

/** The phase a parked workflow belongs to; live states answer for themselves. */
function phaseOf(wf: Workflow): WorkflowState {
  return wf.state === "needs_decision" || wf.state === "paused" ? (wf.pausedState ?? "provisioning") : wf.state;
}

export async function patchWorkflow(
  id: string,
  req: PatchWorkflowRequest,
  ports: WorkflowPorts = defaultPorts(),
): Promise<{ workflow?: Workflow; error?: string; status?: number }> {
  const workflows = loadWorkflows();
  const wf = workflows.find((item) => item.id === id);
  if (!wf) return { error: "workflow not found", status: 404 };

  if (req.action === "pause") {
    if (wf.state !== "paused" && !TERMINAL_STATES.has(wf.state)) {
      if (wf.state !== "needs_decision") wf.pausedState = wf.state;
      wf.state = "paused";
      wf.stateDetail = "paused by user";
    }
  } else if (req.action === "resume") {
    if (wf.state === "paused" || wf.state === "needs_decision") {
      wf.state = wf.pausedState && !PARKED_STATES.has(wf.pausedState) ? wf.pausedState : "provisioning";
      wf.pausedState = null;
      wf.stateDetail = null;
    }
  } else if (req.action === "advance") {
    const phase = phaseOf(wf);
    if (TERMINAL_STATES.has(wf.state) || phase === "finishing") {
      return { error: "workflow cannot advance from its current state", status: 409 };
    }
    if (phase === "provisioning") {
      /* Skip a stuck setup; a workflow without a worktree has nowhere to go. */
      if (!wf.baseRef) return { error: "workflow has no worktree yet — retry provisioning instead", status: 409 };
      wf.state = "implementing";
    } else {
      const run = currentRun(wf);
      if (!run) return { error: "workflow has no current stage", status: 409 };
      if (!run.doneAt) {
        run.doneAt = ports.now();
        run.doneNote = noteFromRequest(req) ?? run.doneNote ?? "advanced manually";
      }
      if (phase === "reviewing") {
        /* Skipping past a still-running review also stops its reviewer. */
        const flow = wf.flowId ? ports.getFlow(wf.flowId) : null;
        if (flow && flow.closedAt === null && flow.state !== "closed") await ports.closeFlow(flow.id);
        wf.state = "finishing";
      } else {
        advanceStage(wf);
      }
    }
    wf.pausedState = null;
    wf.stateDetail = null;
  } else if (req.action === "retry-stage") {
    const phase = phaseOf(wf);
    if (TERMINAL_STATES.has(wf.state)) return { error: "workflow is finished", status: 409 };
    if (phase === "provisioning") {
      wf.setupPid = null;
      try {
        fs.rmSync(setupExitPath(wf.id), { force: true });
      } catch {
        /* a stale exit file only matters if it survives */
      }
    } else if (phase === "implementing" || phase === "reviewing") {
      const run = currentRun(wf);
      if (run) resetRun(run);
      if (phase === "reviewing") {
        const flow = wf.flowId ? ports.getFlow(wf.flowId) : null;
        if (flow && flow.closedAt === null && flow.state !== "closed") await ports.closeFlow(flow.id);
        wf.flowId = null;
        wf.fixerPath = null;
      }
    }
    wf.state = phase;
    wf.pausedState = null;
    wf.stateDetail = null;
  } else if (req.action === "close") {
    const flow = wf.flowId ? ports.getFlow(wf.flowId) : null;
    if (flow && flow.closedAt === null && flow.state !== "closed") await ports.closeFlow(flow.id);
    /* Panes and the worktree stay for inspection (W10); removal is manual. */
    wf.state = "closed";
    wf.pausedState = null;
    wf.stateDetail = null;
    wf.closedAt = ports.now();
  }

  saveWorkflows(workflows);
  return { workflow: wf };
}

export function createWorkflowFromRequest(
  req: CreateWorkflowRequest,
  ports: WorkflowPorts = defaultPorts(),
): { workflow?: Workflow; error?: string; status?: number } {
  const task = typeof req.task === "string" ? req.task.trim() : "";
  if (!task) return { error: "task brief is required", status: 400 };
  const repoDir = typeof req.repoDir === "string" ? req.repoDir.trim() : "";
  if (!repoDir) return { error: "repoDir is required", status: 400 };
  const gitCheck = ports.exec("git", ["rev-parse", "--git-dir"], repoDir);
  if (gitCheck.code !== 0) return { error: `not a git repository: ${repoDir}`, status: 400 };

  let template: WorkflowTemplate;
  if (req.template) {
    const named = loadTemplates().find((item) => item.name === req.template);
    if (!named) return { error: `unknown workflow template: ${req.template}`, status: 400 };
    template = named;
  } else {
    const normalized = normalizeStages(req.stages);
    if ("error" in normalized) return { error: normalized.error, status: 400 };
    template = {
      name: "ad-hoc",
      stages: normalized.stages,
      finish: req.finish === "merge" ? "merge" : "pr",
      ...(typeof req.setup === "string" && req.setup.trim() ? { setup: req.setup.trim() } : {}),
      ...(typeof req.verify === "string" && req.verify.trim() ? { verify: req.verify.trim() } : {}),
    };
  }

  const wf = buildWorkflow({
    id: crypto.randomUUID().slice(0, 8),
    name: template.name,
    task,
    /* The scanner's own project key: agents born in the sibling worktree
       resolve to the main repo's project, so the strip must land there too. */
    project: ports.projectForCwd(repoDir) ?? path.basename(repoDir),
    repoDir,
    template,
    mode: req.mode === "manual" ? "manual" : "auto",
    now: ports.now(),
  });
  if (typeof req.src === "string" && req.src.trim()) wf.srcPath = req.src.trim();
  const workflows = loadWorkflows();
  workflows.push(wf);
  saveWorkflows(workflows);
  return { workflow: wf };
}

export function getWorkflowsWithTemplates(): { workflows: Workflow[]; templates: WorkflowTemplate[] } {
  return { workflows: loadWorkflows(), templates: loadTemplates() };
}
