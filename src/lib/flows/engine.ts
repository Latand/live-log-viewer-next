import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parseReview, VERDICT_LINE_RE } from "@/lib/review";
import { tailRecords } from "@/lib/scanner/activity";
import { recordValue, recordsValue, stringValue } from "@/lib/scanner/json";
import { resolveTarget, resumeSpecFor, sendText, sendToResumedAgent, spawnAgentWithPrompt, freshSpecFor } from "@/lib/tmux";
import type { FileEntry } from "@/lib/types";

import { forgetHeadlessReview, headlessReviewStatus, startHeadlessReview } from "./exec";
import {
  atomicWriteText,
  findingsPathFor,
  loadFlows,
  loadPresets,
  normalizeFindings,
  saveFlows,
} from "./store";
import type {
  CreateFlowRequest,
  Flow,
  FlowPreset,
  FlowState,
  PatchFlowRequest,
  ReviewVerdict,
  RoleConfig,
  Round,
} from "./types";

const TERMINAL_STATES = new Set<FlowState>(["approved", "done_comment", "needs_decision", "closed"]);
const READY_RE = /^REVIEW_READY:\s*(.*)$/m;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const store = globalThis as unknown as { __llvFlowTick?: boolean };
const relayStartedThisProcess = new Set<string>();

interface TickResult {
  flows: Flow[];
  changed: boolean;
}

function isoNow(): string {
  return new Date().toISOString();
}

function unixMs(value: string | null): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function cloneFlows(flows: Flow[]): Flow[] {
  return flows.map((flow) => ({
    ...flow,
    roles: {
      implementer: { ...flow.roles.implementer },
      reviewer: { ...flow.roles.reviewer },
    },
    rounds: flow.rounds.map((round) => ({ ...round })),
  }));
}

function lastRound(flow: Flow): Round | null {
  return flow.rounds.at(-1) ?? null;
}

function lastAssistantMessage(entry: FileEntry): { text: string; ts: number } | null {
  const records = tailRecords(entry.path, entry.size);
  for (const obj of records.reverse()) {
    const ts = Date.parse(String(obj.timestamp ?? "")) || entry.mtime * 1000;
    if (entry.root === "codex-sessions") {
      const payload = recordValue(obj.payload) ?? {};
      const type = stringValue(payload.type);
      if (type === "agent_message") return { text: stringValue(payload.message) ?? "", ts };
      if (type === "message" && payload.role === "assistant") {
        const text = recordsValue(payload.content)
          .map((part) => stringValue(part.text) ?? stringValue(part.input_text) ?? "")
          .join("\n")
          .trim();
        if (text) return { text, ts };
      }
    }
    if (entry.root === "claude-projects" && obj.type === "assistant") {
      const text = recordsValue(recordValue(obj.message)?.content)
        .filter((part) => part.type === "text")
        .map((part) => stringValue(part.text) ?? "")
        .join("\n")
        .trim();
      if (text) return { text, ts };
    }
  }
  return null;
}

function detectReadyMarker(flow: Flow, entry: FileEntry): string | null {
  /* Only a finished turn counts. Both CLIs emit interim narration mid-turn,
     and the marker line can appear there while the implementer is still
     committing — reviewing that snapshot would cover a half-done diff. */
  if (entry.activity === "live" || entry.activityReason === "jsonl_turn_open" || entry.activityReason === "jsonl_turn_stalled") {
    return null;
  }
  const message = lastAssistantMessage(entry);
  if (!message) return null;
  const lastStarted = Math.max(...flow.rounds.map((round) => unixMs(round.startedAt)), unixMs(flow.createdAt));
  if (message.ts <= lastStarted) return null;
  return message.text.match(READY_RE)?.[1]?.trim() ?? null;
}

function parseFindings(text: string): { verdict: ReviewVerdict; findingsCount: number; content: string } | null {
  const verdict = text.match(VERDICT_LINE_RE)?.[1] as ReviewVerdict | undefined;
  if (!verdict) return null;
  const review = parseReview(text, null);
  return {
    verdict,
    findingsCount: review?.findings.length ?? 0,
    content: normalizeFindings(verdict, text),
  };
}

function readFindingsFile(round: Round): { verdict: ReviewVerdict; findingsCount: number; content: string } | null {
  if (!round.findingsPath) return null;
  try {
    return parseFindings(fs.readFileSync(round.findingsPath, "utf8"));
  } catch {
    return null;
  }
}

function fallbackReviewFromTranscript(round: Round, entriesByPath: Map<string, FileEntry>): { verdict: ReviewVerdict; findingsCount: number; content: string } | null {
  if (!round.reviewerPath) return null;
  const entry = entriesByPath.get(round.reviewerPath);
  if (!entry) return null;
  const message = lastAssistantMessage(entry);
  if (!message) return null;
  return parseFindings(message.text);
}

function newRound(flow: Flow, triggeredBy: Round["triggeredBy"], readyNote: string | null): Round {
  return {
    n: flow.rounds.length + 1,
    reviewerPath: null,
    sessionId: null,
    findingsPath: null,
    triggeredBy,
    readyNote,
    verdict: null,
    findingsCount: null,
    startedAt: isoNow(),
    spawnStartedAt: null,
    relayStartedAt: null,
    reviewedAt: null,
    relayedAt: null,
    error: null,
  };
}

function kickoffPrompt(): string {
  return [
    "You are now in an implement-review loop controlled by the local log viewer.",
    "",
    "Work normally in this long-lived implementer session. When the work is ready for a fresh independent review, end your final assistant message with a line that starts exactly with:",
    "REVIEW_READY: <one-line note>",
    "Do not print the REVIEW_READY marker now and never quote it at the start of a line when acknowledging these instructions — print it only when the work is actually ready for review.",
    "",
    "Every review round will use a fresh reviewer who sees the full diff from the captured base ref, with no history from earlier rounds. If the reviewer sends findings back, respond to each finding before the next marker using:",
    "FIXED",
    "or",
    "REJECTED — <reason>",
    "",
    "Give concrete arguments for rejections because the next reviewer will be fresh and blind to previous discussion.",
  ].join("\n");
}

function reviewerPrompt(flow: Flow, round: Round): string {
  return [
    "You are the reviewer in an implement-review loop.",
    "",
    `Working directory: ${flow.cwd}`,
    `Review scope: git diff ${flow.baseRef}...HEAD plus uncommitted changes in the same working tree.`,
    round.readyNote ? `Implementer ready note: ${round.readyNote}` : "Implementer ready note: none provided.",
    "",
    "Read-only requirement: inspect files and commands as needed, but do not edit files, write notebooks, commit, stage, or mutate the working tree.",
    "",
    "Output exactly this format:",
    "VERDICT: APPROVE | REQUEST_CHANGES | COMMENT",
    "",
    "Then write findings in Markdown. For each finding include severity, file, line, title, and explanation. Use REQUEST_CHANGES for required fixes, COMMENT for non-blocking notes, and APPROVE only when no blocking issues remain.",
  ].join("\n");
}

function relayPrompt(round: Round, findings: string): string {
  return [
    "Review round findings are below. Address every finding before the next review marker.",
    "",
    findings.trim(),
    "",
    "For each finding, respond with FIXED or REJECTED — <reason>. When the work is reviewable again, end your final assistant message with:",
    "REVIEW_READY: <one-line note>",
  ].join("\n");
}

function markNeedsDecision(flow: Flow, detail: string): void {
  flow.state = "needs_decision";
  flow.stateDetail = detail;
}

function roundKey(flow: Flow, round: Round): string {
  return `${flow.id}:${round.n}`;
}

async function sendToImplementer(flow: Flow, entriesByPath: Map<string, FileEntry>, text: string): Promise<void> {
  const entry = entriesByPath.get(flow.implementerPath);
  if (!entry) throw new Error("implementer transcript is missing from scanner");
  if (entry.pid !== null) {
    const target = await resolveTarget(entry.pid);
    if (target) {
      await sendText(target, text);
      return;
    }
  }
  const spec = resumeSpecFor(entry.root, entry.path);
  if (!spec) throw new Error("implementer session cannot be resumed");
  await sendToResumedAgent(entry.path, spec, text);
}

function sessionIdFromHeadlessStdout(stdout: string): string | null {
  const direct = stdout.match(/session id:?\s*([0-9a-f-]{36})/i)?.[1];
  if (direct && UUID_RE.test(direct)) return direct;
  return stdout.split("\n").slice(0, 40).join("\n").match(UUID_RE)?.[0] ?? null;
}

function maybeClaimReviewerPathBySession(entries: FileEntry[], round: Round, sessionId: string | null): boolean {
  if (round.reviewerPath || !sessionId) return false;
  const hit = entries.find((entry) => path.basename(entry.path).includes(sessionId));
  if (!hit) return false;
  round.reviewerPath = hit.path;
  return true;
}

function maybeClaimReviewerPathByHeuristic(flow: Flow, entries: FileEntry[], round: Round): boolean {
  if (round.reviewerPath) return false;
  const started = unixMs(round.startedAt) / 1000 - 5;
  const engine = flow.roles.reviewer.engine;
  const candidates = entries
    .filter((entry) => entry.engine === engine && entry.path !== flow.implementerPath && entry.mtime >= started && entryCwdFromHead(entry) === flow.cwd)
    .sort((a, b) => b.mtime - a.mtime);
  const hit = candidates[0];
  if (!hit) return false;
  round.reviewerPath = hit.path;
  return true;
}

function applyVerdict(flow: Flow, round: Round, parsed: { verdict: ReviewVerdict; findingsCount: number; content: string }): void {
  const filePath = round.findingsPath ?? findingsPathFor(flow.id, round.n);
  atomicWriteText(filePath, parsed.content);
  round.findingsPath = filePath;
  round.verdict = parsed.verdict;
  round.findingsCount = parsed.findingsCount;
  round.reviewedAt = isoNow();
  if (flow.mode === "manual") {
    flow.state = "relay_pending";
  } else {
    flow.state = "relaying";
  }
  flow.stateDetail = null;
}

async function launchReviewer(flow: Flow, round: Round): Promise<void> {
  const prompt = reviewerPrompt(flow, round);
  flow.state = "reviewing";
  flow.stateDetail = null;
  if (flow.reviewerMode === "pane") {
    const spec = freshSpecFor(flow.roles.reviewer.engine, flow.cwd, {
      model: flow.roles.reviewer.model,
      effort: flow.roles.reviewer.effort,
      readOnly: true,
    });
    const pane = await spawnAgentWithPrompt(spec, prompt);
    if (spec.transcript) round.reviewerPath = spec.transcript;
    if (!round.reviewerPath && pane.panePid) round.error = null;
    return;
  }
  const launched = startHeadlessReview(flow.id, round.n, flow.roles.reviewer, flow.cwd, prompt);
  if (launched.sessionId) round.sessionId = launched.sessionId;
  if (launched.reviewerPath) round.reviewerPath = launched.reviewerPath;
}

async function relayFindings(flow: Flow, entriesByPath: Map<string, FileEntry>, round: Round): Promise<void> {
  if (!round.findingsPath) throw new Error("round has no findings artifact");
  const findings = fs.readFileSync(round.findingsPath, "utf8");
  flow.state = "relaying";
  await sendToImplementer(flow, entriesByPath, relayPrompt(round, findings));
  round.relayedAt = isoNow();
  if (round.verdict === "APPROVE") {
    flow.state = "approved";
    flow.closedAt = isoNow();
  } else if (round.verdict === "COMMENT") {
    flow.state = "done_comment";
  } else if (flow.rounds.length >= flow.roundLimit) {
    markNeedsDecision(flow, "round limit reached");
  } else {
    flow.state = "fixing";
    flow.stateDetail = null;
  }
}

async function tickFlow(
  flow: Flow,
  entries: FileEntry[],
  entriesByPath: Map<string, FileEntry>,
  persistCheckpoint: () => void,
): Promise<boolean> {
  const before = JSON.stringify(flow);
  if (flow.state === "closed" || flow.state === "paused") return false;
  const implementer = entriesByPath.get(flow.implementerPath);
  if (!implementer) {
    const pausedFrom = flow.state;
    flow.state = "paused";
    flow.pausedState = pausedFrom;
    flow.stateDetail = "implementer transcript is missing";
    return JSON.stringify(flow) !== before;
  }

  if (flow.state === "waiting_ready" || flow.state === "fixing") {
    const note = detectReadyMarker(flow, implementer);
    if (note !== null) {
      flow.rounds.push(newRound(flow, "marker", note));
      flow.state = flow.mode === "manual" ? "spawn_pending" : "spawning";
      flow.stateDetail = null;
    }
    return JSON.stringify(flow) !== before;
  }

  const round = lastRound(flow);
  if (!round) return JSON.stringify(flow) !== before;

  if (flow.state === "spawning") {
    const status = headlessReviewStatus(flow.id, round.n);
    if (round.spawnStartedAt && !status && round.reviewerPath === null) {
      markNeedsDecision(flow, "reviewer spawn was interrupted by a restart");
      return JSON.stringify(flow) !== before;
    }
    try {
      round.spawnStartedAt = isoNow();
      persistCheckpoint();
      await launchReviewer(flow, round);
    } catch (error) {
      round.error = error instanceof Error ? error.message : String(error);
      markNeedsDecision(flow, round.error);
    }
    return JSON.stringify(flow) !== before;
  }

  if (flow.state === "reviewing") {
    const fileVerdict = readFindingsFile(round);
    if (fileVerdict) {
      applyVerdict(flow, round, fileVerdict);
      return JSON.stringify(flow) !== before;
    }
    if (flow.reviewerMode === "headless") {
      const status = headlessReviewStatus(flow.id, round.n);
      /* Persist the id the moment any source yields it (the JSON.stringify
         diff in tickFlow flushes it to flows.json): after that the transcript
         claim is deterministic and survives restarts. The banner parse stays
         as a backstop for --json format drift; the cwd+mtime heuristic runs
         only while no id is known at all. */
      if (!round.sessionId) {
        round.sessionId = status?.sessionId ?? sessionIdFromHeadlessStdout(status?.stdout ?? "");
      }
      maybeClaimReviewerPathBySession(entries, round, round.sessionId ?? null);
      if (!round.reviewerPath && !round.sessionId) maybeClaimReviewerPathByHeuristic(flow, entries, round);
      if (status?.status === "running") return JSON.stringify(flow) !== before;
      if (status) {
        forgetHeadlessReview(flow.id, round.n);
        const parsed = parseFindings(status.finalOutput);
        if (parsed) {
          applyVerdict(flow, round, parsed);
        } else {
          const rawPath = round.findingsPath ?? findingsPathFor(flow.id, round.n);
          atomicWriteText(rawPath, status.finalOutput || status.stdout || status.stderr);
          round.findingsPath = rawPath;
          round.error = status.status === "timeout" ? "reviewer timed out" : status.stderr.trim() || "reviewer verdict was unparseable";
          markNeedsDecision(flow, round.error);
        }
        return JSON.stringify(flow) !== before;
      }
      const fallback = fallbackReviewFromTranscript(round, entriesByPath);
      if (fallback) {
        applyVerdict(flow, round, fallback);
      } else {
        markNeedsDecision(flow, "reviewer process is missing after server restart");
      }
      return JSON.stringify(flow) !== before;
    }
    maybeClaimReviewerPathByHeuristic(flow, entries, round);
    if (round.reviewerPath) {
      const reviewer = entriesByPath.get(round.reviewerPath);
      const fallback = fallbackReviewFromTranscript(round, entriesByPath);
      if (fallback) {
        applyVerdict(flow, round, fallback);
      } else if (reviewer && reviewer.activity !== "live" && reviewer.activity !== "stalled") {
        markNeedsDecision(flow, "reviewer verdict was unparseable");
      }
    }
    return JSON.stringify(flow) !== before;
  }

  if (flow.state === "relaying") {
    const relayKey = roundKey(flow, round);
    if (round.relayStartedAt && round.relayedAt === null && !relayStartedThisProcess.has(relayKey)) {
      markNeedsDecision(flow, "relay was interrupted — можливо, доставлено двічі");
      return JSON.stringify(flow) !== before;
    }
    try {
      round.relayStartedAt = isoNow();
      relayStartedThisProcess.add(relayKey);
      persistCheckpoint();
      await relayFindings(flow, entriesByPath, round);
    } catch (error) {
      round.error = error instanceof Error ? error.message : String(error);
      flow.state = "paused";
      flow.pausedState = "relaying";
      flow.stateDetail = round.error;
    }
    return JSON.stringify(flow) !== before;
  }

  return JSON.stringify(flow) !== before;
}

export async function tickFlows(entries: FileEntry[]): Promise<TickResult> {
  if (store.__llvFlowTick) {
    const flows = cloneFlows(loadFlows());
    annotateFlowEntries(entries, flows);
    return { flows, changed: false };
  }
  store.__llvFlowTick = true;
  const flows = cloneFlows(loadFlows());
  try {
    const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
    let changed = false;
    for (const flow of flows) {
      if (TERMINAL_STATES.has(flow.state)) continue;
      if (await tickFlow(flow, entries, entriesByPath, () => saveFlows(flows))) changed = true;
      if (changed) saveFlows(flows);
    }
    annotateFlowEntries(entries, flows);
    if (changed) saveFlows(flows);
    return { flows, changed };
  } finally {
    store.__llvFlowTick = false;
  }
}

export function annotateFlowEntries(entries: FileEntry[], flows: Flow[]): void {
  for (const entry of entries) delete entry.flow;
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const flow of flows) {
    const implementer = byPath.get(flow.implementerPath);
    if (implementer) implementer.flow = { flowId: flow.id, flowRole: "implementer", round: null };
    for (const round of flow.rounds) {
      if (!round.reviewerPath) continue;
      const reviewer = byPath.get(round.reviewerPath);
      if (reviewer) reviewer.flow = { flowId: flow.id, flowRole: "reviewer", round: round.n };
    }
  }
}

export function getFlowsWithPresets(): { flows: Flow[]; presets: FlowPreset[] } {
  return { flows: loadFlows(), presets: loadPresets() };
}

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

export function resolveBaseRef(cwd: string, baseMode: Flow["baseMode"]): { ok: true; sha: string } | { ok: false; error: string } {
  const args =
    baseMode === "head"
      ? ["rev-parse", "HEAD"]
      : ["merge-base", "HEAD", defaultBranch(cwd) ?? "origin/main"];
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    return { ok: false, error: (res.stderr || res.stdout || "failed to resolve git base ref").trim() };
  }
  const sha = res.stdout.trim();
  return sha ? { ok: true, sha } : { ok: false, error: "git returned an empty base ref" };
}

function defaultBranch(cwd: string): string | null {
  const remote = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd, encoding: "utf8" });
  if (remote.status === 0 && remote.stdout.trim()) return remote.stdout.trim().replace(/^origin\//, "origin/");
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    const res = spawnSync("git", ["rev-parse", "--verify", candidate], { cwd, encoding: "utf8" });
    if (res.status === 0) return candidate;
  }
  return null;
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
  const cwd = cwdFromEntry(entry);
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

function cwdFromEntry(entry: FileEntry): string | null {
  return entryCwdFromHead(entry);
}

function entryCwdFromHead(entry: FileEntry): string | null {
  const records = headRecords(entry.path);
  for (const obj of records) {
    const direct = typeof obj.cwd === "string" ? obj.cwd : null;
    const payload = recordValue(obj.payload);
    const nested = payload ? stringValue(payload.cwd) : null;
    const cwd = direct ?? nested;
    if (cwd) return cwd;
  }
  return null;
}

function headRecords(pathname: string): Record<string, unknown>[] {
  let text = "";
  try {
    const fd = fs.openSync(pathname, "r");
    try {
      const buf = Buffer.alloc(65_536);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      text = buf.toString("utf8", 0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out.push(parsed as Record<string, unknown>);
    } catch {
      /* skip partial header rows */
    }
  }
  return out;
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
      flow.rounds.push(newRound(flow, "button", null));
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
