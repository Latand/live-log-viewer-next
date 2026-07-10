import fs from "node:fs";
import path from "node:path";

import { freshSpecFor, resumeSpecFor } from "@/lib/agent/cli";
import { deliverToTranscriptHost } from "@/lib/agent/transcriptHost";
import { accountForSpawn } from "@/lib/accounts/codex";
import { resolveSpawnedTranscriptPath } from "@/lib/agent/spawnedTranscript";
import { headCwd } from "@/lib/agent/transcript";
import { isNativeCodexSubagentTranscript } from "@/lib/scanner/codexNative";
import { spawnAgentWithPrompt } from "@/lib/tmux";
import type { FileEntry } from "@/lib/types";

import { forgetHeadlessReview, headlessReviewStatus, startHeadlessReview } from "./exec";
import {
  fallbackReviewFromTranscript,
  lastAssistantMessage,
  parseFindings,
  readFindingsFile,
  type ParsedFindings,
} from "./findings";
import { relayPrompt, reviewerPrompt } from "./prompts";
import { atomicWriteText, findingsPathFor, loadFlows, loadPresets, saveFlows } from "./store";
import type { Flow, FlowPreset, FlowState, Round } from "./types";

const TERMINAL_STATES = new Set<FlowState>(["approved", "done_comment", "needs_decision", "closed"]);
const READY_RE = /^REVIEW_READY:\s*(.*)$/m;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const store = globalThis as unknown as { __llvFlowTick?: boolean };
const relayStartedThisProcess = new Set<string>();

interface TickResult {
  flows: Flow[];
  changed: boolean;
}

export function isoNow(): string {
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

export function lastRound(flow: Flow): Round | null {
  return flow.rounds.at(-1) ?? null;
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

export function newRound(flow: Flow, triggeredBy: Round["triggeredBy"], readyNote: string | null): Round {
  return {
    n: flow.rounds.length + 1,
    reviewerPath: null,
    sessionId: null,
    reviewerPane: null,
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

function markNeedsDecision(flow: Flow, detail: string): void {
  flow.state = "needs_decision";
  flow.stateDetail = detail;
}

function roundKey(flow: Flow, round: Round): string {
  return `${flow.id}:${round.n}`;
}

export async function sendToImplementer(flow: Flow, entriesByPath: Map<string, FileEntry>, text: string): Promise<void> {
  const entry = entriesByPath.get(flow.implementerPath);
  if (!entry) throw new Error("implementer transcript is missing from scanner");
  const spec = resumeSpecFor(entry.root, entry.path, { model: entry.launchModel ?? entry.model, effort: entry.effort });
  if (!spec) throw new Error("implementer session cannot be resumed");
  const outcome = await deliverToTranscriptHost({ entry, spec, payload: text });
  if (!outcome.ok) throw new Error(outcome.error);
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

function isNativeCodexSubagentEntry(entry: FileEntry): boolean {
  return entry.root === "codex-sessions" && entry.path.endsWith(".jsonl") && isNativeCodexSubagentTranscript(entry.path, entry.size);
}

function maybeClaimReviewerPathByHeuristic(flow: Flow, entries: FileEntry[], round: Round): boolean {
  if (round.reviewerPath) return false;
  const started = unixMs(round.startedAt) / 1000 - 5;
  const engine = flow.roles.reviewer.engine;
  const candidates = entries
    .filter(
      (entry) =>
        entry.engine === engine &&
        entry.path !== flow.implementerPath &&
        entry.mtime >= started &&
        !isNativeCodexSubagentEntry(entry) &&
        headCwd(entry.path) === flow.cwd,
    )
    .sort((a, b) => b.mtime - a.mtime);
  const hit = candidates[0];
  if (!hit) return false;
  round.reviewerPath = hit.path;
  return true;
}

function applyVerdict(flow: Flow, round: Round, parsed: ParsedFindings): void {
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
  const account = flow.roles.reviewer.engine === "codex" ? accountForSpawn() : null;
  flow.state = "reviewing";
  flow.stateDetail = null;
  if (flow.reviewerMode === "pane") {
    const spec = freshSpecFor(flow.roles.reviewer.engine, flow.cwd, {
      model: flow.roles.reviewer.model,
      effort: flow.roles.reviewer.effort,
      codexHome: account?.home,
    });
    const startedAtMs = Date.now();
    const pane = await spawnAgentWithPrompt(spec, prompt);
    /* The pane handle makes cancel-round reliable even while the reviewer's
       transcript is still unattributed (codex, or an early stop click). */
    round.reviewerPane = { paneId: pane.paneId, windowName: spec.windowName };
    const transcript = await resolveSpawnedTranscriptPath({
      engine: flow.roles.reviewer.engine,
      knownTranscript: spec.transcript ?? null,
      panePid: pane.panePid ?? null,
      cwd: flow.cwd,
      startedAtMs,
      codexSessionsDir: account?.sessionsDir,
    });
    if (transcript) round.reviewerPath = transcript;
    if (!round.reviewerPath && pane.panePid) round.error = null;
    return;
  }
  const launched = startHeadlessReview(
    flow.id,
    round.n,
    flow.roles.reviewer,
    flow.cwd,
    prompt,
    undefined,
    account ? { home: account.home, managed: account.kind === "managed" } : null,
  );
  if (launched.pid) round.reviewerPid = launched.pid;
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
  } else if (flow.roundLimit > 0 && flow.rounds.length >= flow.roundLimit) {
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
    const status = headlessReviewStatus(flow.id, round.n, round, flow.roles.reviewer.engine);
    /* A restart can land here with the round already launched (state was
       persisted before launchReviewer finished). The detached reviewer is
       still out there — adopt it instead of spawning a duplicate. */
    if (round.spawnStartedAt && flow.reviewerMode === "headless" && status) {
      flow.state = "reviewing";
      flow.stateDetail = null;
      return JSON.stringify(flow) !== before;
    }
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
      const status = headlessReviewStatus(flow.id, round.n, round, flow.roles.reviewer.engine);
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
        forgetHeadlessReview(flow.id, round.n, round.reviewerPid ?? null);
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
      markNeedsDecision(flow, "relay was interrupted; it may have been delivered twice");
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
