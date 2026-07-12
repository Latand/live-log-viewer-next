import fs from "node:fs";
import path from "node:path";

import { freshSpecFor, resumeSpecFor } from "@/lib/agent/cli";
import { accountManager } from "@/lib/accounts/manager";
import type { AccountContext } from "@/lib/accounts/contracts";
import { deliverToTranscriptHost } from "@/lib/agent/transcriptHost";
import { agentRegistry } from "@/lib/agent/registry";
import { resolveSpawnedTranscriptPath } from "@/lib/agent/spawnedTranscript";
import { headCwd } from "@/lib/agent/transcript";
import { isNativeCodexSubagentTranscript } from "@/lib/scanner/codexNative";
import { isShellCommand } from "@/lib/status";
import { killPane, paneInfo, spawnAgentWithPrompt } from "@/lib/tmux";
import type { FileEntry } from "@/lib/types";

import { clearHeadlessReviewArtifacts, forgetHeadlessReview, headlessReviewStatus, startHeadlessReview } from "./exec";
import {
  fallbackReviewFromTranscript,
  lastAssistantMessage,
  parseFindings,
  readFindingsFile,
  type ParsedFindings,
} from "./findings";
import { relayPrompt, reviewerPrompt } from "./prompts";
import { atomicWriteText, findingsPathFor, loadFlows, loadPresets, saveFlows } from "./store";
import type { Flow, FlowPreset, FlowState, RoleConfig, Round } from "./types";
import { chooseHeadlessReviewer, rateLimitStateDetail } from "./reviewerPolicy";

const TERMINAL_STATES = new Set<FlowState>(["approved", "done_comment", "needs_decision", "closed"]);
const READY_RE = /^REVIEW_READY:\s*(.*)$/m;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const store = globalThis as unknown as { __llvFlowTick?: boolean };
const relayStartedThisProcess = new Set<string>();
const MAX_HEADLESS_NO_VERDICT_RETRIES = 1;

class ReviewerAccountsExhaustedError extends Error {
  constructor(readonly resetsAt: number | null) {
    super("reviewer rate limited; all accounts exhausted");
    this.name = "ReviewerAccountsExhaustedError";
  }
}

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
    reviewerFallback: flow.reviewerFallback ? { ...flow.reviewerFallback } : null,
    rounds: flow.rounds.map((round) => ({
      ...round,
      reviewerRole: round.reviewerRole ? { ...round.reviewerRole } : null,
      attemptedAccounts: [...(round.attemptedAccounts ?? [])],
    })),
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

/** The reviewer role a round runs under: its frozen snapshot when present,
    falling back to the live flow role for rounds persisted before the snapshot
    existed. Every engine read of the reviewer engine/model/effort goes through
    here so a mid-flight set-roles cannot retarget an in-flight round (#118). */
export function reviewerRoleFor(flow: Flow, round: Round): RoleConfig {
  return round.reviewerRole ?? flow.roles.reviewer;
}

export function newRound(flow: Flow, triggeredBy: Round["triggeredBy"], readyNote: string | null): Round {
  return {
    n: flow.rounds.length + 1,
    reviewerPath: null,
    accountId: null,
    attemptedAccounts: [],
    autoRetryCount: 0,
    sessionId: null,
    /* Freeze the reviewer role now, so a later set-roles only affects the round
       after this one (#118); prepareReviewerLaunch re-freezes it at launch to pick
       up an override applied before the spawn. */
    reviewerRole: { ...flow.roles.reviewer },
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

function currentConversationPath(conversationId: string | null | undefined, fallback: string): string {
  if (conversationId?.startsWith("conversation_")) {
    return agentRegistry().conversation(conversationId as `conversation_${string}`)?.generations.at(-1)?.path ?? fallback;
  }
  return agentRegistry().canonicalPath(fallback);
}

export async function sendToImplementer(flow: Flow, entriesByPath: Map<string, FileEntry>, text: string): Promise<void> {
  const entry = entriesByPath.get(currentConversationPath(flow.implementerConversationId, flow.implementerPath));
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
  const engine = reviewerRoleFor(flow, round).engine;
  const candidates = entries
    .filter(
      (entry) =>
        entry.engine === engine &&
        entry.path !== currentConversationPath(flow.implementerConversationId, flow.implementerPath) &&
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

/**
 * Did the reviewer launch we just performed actually land on disk? After the
 * post-spawn checkpoint, our handle (pane id / headless pid) is on the round IF
 * we still own the launch. If a concurrent close/pause/retry/cancel took the flow
 * over during the await, the tick's merge dropped our handle — so the disk round
 * no longer carries it, and the worker we started is now an orphan we must stop.
 */
export function reviewerLaunchPersisted(diskFlow: Flow | undefined, round: Round): boolean {
  if (!diskFlow) return false;
  const diskRound = diskFlow.rounds.find((item) => item.n === round.n);
  if (!diskRound) return false;
  if (round.reviewerPane) return diskRound.reviewerPane?.paneId === round.reviewerPane.paneId;
  if (round.reviewerPid != null) return diskRound.reviewerPid === round.reviewerPid;
  /* Transcript-only launch (no pane/pid handle yet): treat a close as lost. */
  return diskFlow.state !== "closed";
}

/**
 * Clear the abandoned launch's spawn markers on disk so a resume/retry re-spawns
 * a fresh reviewer instead of parking as "interrupted" (issue #118 review): a
 * pause that raced the launch leaves the round with spawnStartedAt set but no
 * live reviewer, which the spawning branch would otherwise read as an interrupted
 * restart. Synchronous load-modify-save, so no patchFlow interleaves.
 */
export function abandonLaunch(flowId: string, roundNumber: number): void {
  const flows = loadFlows();
  const flow = flows.find((item) => item.id === flowId);
  const round = flow?.rounds.find((item) => item.n === roundNumber);
  if (!round) return;
  round.spawnStartedAt = null;
  round.reviewerPane = null;
  round.reviewerPath = null;
  round.reviewerPid = null;
  round.sessionId = null;
  saveFlows(flows);
}

/** Best-effort kill of a pane reviewer we spawned but can no longer own. The
    window-name check guards against pane-id reuse; a shell there means the agent
    already exited. */
async function stopOrphanPane(round: Round): Promise<void> {
  const pane = round.reviewerPane;
  if (!pane) return;
  try {
    const info = await paneInfo(pane.paneId);
    if (info && info.windowName === pane.windowName && !isShellCommand(info.command)) await killPane(pane.paneId);
  } catch {
    /* pane already gone */
  }
}

interface PreparedReviewerLaunch {
  role: Flow["roles"]["reviewer"];
  account: AccountContext;
}

/* Rate-limit-aware account + role selection (issue #117): pane reviewers use the
   flow's reviewer role, headless reviewers pick an account excluding ones already
   attempted this round, parking the flow when every account is exhausted. Freezes
   round.reviewerRole here at launch, re-picking up an override applied before the
   spawn (over the newRound snapshot). */
function prepareReviewerLaunch(flow: Flow, round: Round): PreparedReviewerLaunch {
  if (flow.reviewerMode === "pane") {
    const role = flow.roles.reviewer;
    const account = accountManager.resolveSpawn(role.engine, round.accountId);
    round.accountId = account.accountId;
    round.reviewerRole = { ...role };
    return { role, account };
  }
  const decision = chooseHeadlessReviewer(
    flow.roles.reviewer,
    flow.reviewerFallback,
    round.attemptedAccounts ?? [],
    (engine, requestedId, excludedIds) => accountManager.resolveHeadlessSpawn(engine, requestedId, excludedIds),
  );
  if (decision.kind === "exhausted") throw new ReviewerAccountsExhaustedError(decision.resetsAt);
  if (decision.kind === "unavailable") throw new Error("no authenticated reviewer account is available");
  const { role, account } = decision;
  round.reviewerRole = { ...role };
  round.accountId = account.accountId;
  const accountKey = `${account.engine}:${account.accountId}`;
  round.attemptedAccounts = [...new Set([...(round.attemptedAccounts ?? []), accountKey])];
  return { role, account };
}

async function launchReviewer(flow: Flow, round: Round, prepared: PreparedReviewerLaunch, persistCheckpoint: () => void): Promise<void> {
  const prompt = reviewerPrompt(flow, round);
  const { role, account } = prepared;
  flow.state = "reviewing";
  flow.stateDetail = null;
  if (flow.reviewerMode === "pane") {
    const spec = freshSpecFor(role.engine, flow.cwd, {
      model: role.model,
      effort: role.effort,
      codexHome: account.engine === "codex" ? account.home : null,
      claudeConfigDir: account.engine === "claude" ? account.home : null,
      claudeProjectsDir: account.engine === "claude" ? account.transcriptRoot : null,
    });
    const startedAtMs = Date.now();
    const pane = await spawnAgentWithPrompt(spec, prompt);
    /* The pane handle makes cancel-round reliable even while the reviewer's
       transcript is still unattributed (codex, or an early stop click). */
    round.reviewerPane = { paneId: pane.paneId, windowName: spec.windowName };
    const transcript = await resolveSpawnedTranscriptPath({
      engine: role.engine,
      knownTranscript: spec.transcript ?? null,
      panePid: pane.panePid ?? null,
      cwd: flow.cwd,
      startedAtMs,
      codexSessionsDir: account.engine === "codex" ? account.transcriptRoot : null,
    });
    if (transcript) round.reviewerPath = transcript;
    if (!round.reviewerPath && pane.panePid) round.error = null;
    /* Persist the pane handle NOW so a close that races the tail of this spawn can
       find and stop it. If a concurrent close/pause/retry took the flow over, the
       merge dropped our handle — the pane is an orphan, so kill it, and let a
       resume/retry re-spawn cleanly rather than parking as interrupted. */
    persistCheckpoint();
    const paneDisk = loadFlows().find((item) => item.id === flow.id);
    if (!reviewerLaunchPersisted(paneDisk, round)) {
      await stopOrphanPane(round);
      if (paneDisk && paneDisk.state !== "closed") abandonLaunch(flow.id, round.n);
    }
    return;
  }
  const launched = startHeadlessReview(
    flow.id,
    round.n,
    role,
    flow.cwd,
    prompt,
    undefined,
    account.engine === "codex" ? { home: account.home, managed: account.kind === "managed" } : null,
    account.engine === "claude" ? { home: account.home, projectsDir: account.transcriptRoot, managed: account.kind === "managed" } : null,
  );
  if (launched.pid) round.reviewerPid = launched.pid;
  if (launched.sessionId) round.sessionId = launched.sessionId;
  if (launched.reviewerPath) round.reviewerPath = launched.reviewerPath;
  /* Same ownership guard as the pane branch: persist the pid, and if a concurrent
     close/pause/retry took the flow over, terminate the orphan (forgetHeadlessReview
     SIGTERM/SIGKILLs the detached group) and clear the abandoned spawn markers so
     resume/retry re-spawns fresh. */
  persistCheckpoint();
  const headlessDisk = loadFlows().find((item) => item.id === flow.id);
  if (!reviewerLaunchPersisted(headlessDisk, round)) {
    forgetHeadlessReview(flow.id, round.n, round.reviewerPid ?? null);
    if (headlessDisk && headlessDisk.state !== "closed") abandonLaunch(flow.id, round.n);
  }
}

function retryHeadlessRound(flow: Flow, round: Round): void {
  forgetHeadlessReview(flow.id, round.n, round.reviewerPid ?? null);
  clearHeadlessReviewArtifacts(flow.id, round.n);
  Object.assign(round, {
    reviewerPath: null,
    reviewerConversationId: null,
    reviewerRole: null,
    accountId: null,
    sessionId: null,
    reviewerPid: null,
    reviewerPane: null,
    findingsPath: null,
    verdict: null,
    findingsCount: null,
    autoRetryCount: (round.autoRetryCount ?? 0) + 1,
    startedAt: isoNow(),
    spawnStartedAt: null,
    relayStartedAt: null,
    reviewedAt: null,
    relayedAt: null,
    error: null,
  });
  flow.state = "spawning";
  flow.stateDetail = `reviewer produced no verdict; retrying automatically (${round.autoRetryCount}/${MAX_HEADLESS_NO_VERDICT_RETRIES})`;
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
  } else {
    relayFixOrPark(flow);
  }
}

/**
 * The post-relay fix-or-park transition, decided against the FRESH persisted round
 * limit rather than the tick clone's (issue #118 review). An Extend / Set-Limit
 * that raced this awaited delivery survives the merge as operator-owned config, so
 * reading the stale clone value could still park an increased-limit flow as "round
 * limit reached" or let a lowered-limit flow start another round. Re-reads disk
 * synchronously right before the decision, so it matches what the merge persists.
 */
export function relayFixOrPark(flow: Flow): void {
  const roundLimit = loadFlows().find((item) => item.id === flow.id)?.roundLimit ?? flow.roundLimit;
  flow.roundLimit = roundLimit;
  if (roundLimit > 0 && flow.rounds.length >= roundLimit) {
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
  flow.implementerPath = currentConversationPath(flow.implementerConversationId, flow.implementerPath);
  for (const round of flow.rounds) {
    if (round.reviewerPath) round.reviewerPath = currentConversationPath(round.reviewerConversationId, round.reviewerPath);
  }
  if (flow.state === "closed" || flow.state === "paused") return JSON.stringify(flow) !== before;
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
    const status = headlessReviewStatus(flow.id, round.n, round, reviewerRoleFor(flow, round).engine);
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
      const prepared = prepareReviewerLaunch(flow, round);
      round.spawnStartedAt = isoNow();
      persistCheckpoint();
      /* launchReviewer persists again after spawning (for the ownership/orphan
         check), so no extra checkpoint is needed here. */
      await launchReviewer(flow, round, prepared, persistCheckpoint);
    } catch (error) {
      if (error instanceof ReviewerAccountsExhaustedError) {
        round.error = null;
        markNeedsDecision(flow, rateLimitStateDetail(error.resetsAt));
      } else {
        round.error = error instanceof Error ? error.message : String(error);
        markNeedsDecision(flow, round.error);
      }
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
      const status = headlessReviewStatus(flow.id, round.n, round, reviewerRoleFor(flow, round).engine);
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
        } else if ((round.autoRetryCount ?? 0) < MAX_HEADLESS_NO_VERDICT_RETRIES) {
          retryHeadlessRound(flow, round);
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

/** The disk state a tick started from, per flow, so its later save can tell an
    operator's concurrent lifecycle change apart from the tick's own progress. */
export type FlowTickBase = { snapshot: string; state: FlowState; roundsLen: number; closedAt: string | null };

export function flowTickBase(flows: Flow[]): Map<string, FlowTickBase> {
  return new Map(flows.map((flow) => [flow.id, {
    /* Full pre-tick JSON so persistTickFlows can tell "the tick changed nothing"
       apart from a real tick delta and never write a stale clone over a
       concurrent operator edit. */
    snapshot: JSON.stringify(flow),
    state: flow.state,
    roundsLen: flow.rounds.length,
    closedAt: flow.closedAt,
  }]));
}

/**
 * Persists the tick's result by MERGING it into the freshest on-disk snapshot,
 * never overwriting the registry with the stale clone (issue #118 review). The
 * tick clones flows at start and then awaits reviewer launch/relay; during that
 * window an operator can close/pause/resume/retry/set-roles a flow or create a
 * new one. So, starting from disk:
 *   - a flow the tick never held (created concurrently) is kept as-is;
 *   - a flow the tick did NOT change is kept from disk verbatim, so a concurrent
 *     operator edit (e.g. set-roles updating a spawn_pending round's frozen
 *     reviewerRole) is never clobbered by the tick's stale clone;
 *   - a flow whose disk state/rounds/closedAt diverged from the tick's base was
 *     taken over by the operator — the operator wins (a close is never reopened);
 *   - otherwise the tick's result lands, but operator-owned fields are taken from
 *     disk: top-level roles/roundLimit/mode, and each unstarted round's
 *     reviewerRole (the tick never edits an unspawned round's snapshot — only
 *     set-roles does), so a config change without a lifecycle change survives.
 * Fully synchronous, so no patchFlow can interleave between the read and write.
 */
export function persistTickFlows(flows: Flow[], base: Map<string, FlowTickBase>): void {
  const tickById = new Map(flows.map((flow) => [flow.id, flow] as const));
  const merged = loadFlows().map((diskFlow) => {
    const tick = tickById.get(diskFlow.id);
    if (!tick) return diskFlow;
    const start = base.get(diskFlow.id);
    if (!start) return diskFlow;
    /* The tick touched nothing on this flow → whatever is on disk now wins. */
    if (JSON.stringify(tick) === start.snapshot) return diskFlow;
    const takenOver =
      diskFlow.state !== start.state ||
      diskFlow.rounds.length !== start.roundsLen ||
      diskFlow.closedAt !== start.closedAt;
    if (takenOver) return diskFlow;
    /* Fence an unstarted round's reviewer snapshot to the disk value ONLY when the
       tick did not itself change it (comparing to the pre-tick base): then a
       difference on disk is a concurrent set-roles that must survive. When the tick
       DID change it (e.g. issue #117 retry nulls it to re-pick an account), the
       tick's value wins. */
    const baseFlow = JSON.parse(start.snapshot) as Flow;
    const rounds = tick.rounds.map((round, index) => {
      const diskRound = diskFlow.rounds[index];
      const baseRound = baseFlow.rounds[index];
      const tickKeptRole = JSON.stringify(round.reviewerRole ?? null) === JSON.stringify(baseRound?.reviewerRole ?? null);
      return diskRound && round.spawnStartedAt == null && tickKeptRole && diskRound.reviewerRole !== undefined
        ? { ...round, reviewerRole: diskRound.reviewerRole }
        : round;
    });
    return { ...tick, rounds, roles: diskFlow.roles, roundLimit: diskFlow.roundLimit, mode: diskFlow.mode };
  });
  saveFlows(merged);
}

export async function tickFlows(entries: FileEntry[]): Promise<TickResult> {
  if (store.__llvFlowTick) {
    const flows = cloneFlows(loadFlows());
    annotateFlowEntries(entries, flows);
    return { flows, changed: false };
  }
  store.__llvFlowTick = true;
  const flows = cloneFlows(loadFlows());
  const base = flowTickBase(flows);
  try {
    const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
    let changed = false;
    for (const flow of flows) {
      if (TERMINAL_STATES.has(flow.state)) continue;
      if (await tickFlow(flow, entries, entriesByPath, () => persistTickFlows(flows, base))) changed = true;
      if (changed) persistTickFlows(flows, base);
    }
    annotateFlowEntries(entries, flows);
    if (changed) persistTickFlows(flows, base);
    return { flows, changed };
  } finally {
    store.__llvFlowTick = false;
  }
}

export function annotateFlowEntries(entries: FileEntry[], flows: Flow[]): void {
  for (const entry of entries) delete entry.flow;
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const flow of flows) {
    const implementer = byPath.get(currentConversationPath(flow.implementerConversationId, flow.implementerPath));
    if (implementer) implementer.flow = { flowId: flow.id, flowRole: "implementer", round: null };
    for (const round of flow.rounds) {
      if (!round.reviewerPath) continue;
      const reviewer = byPath.get(currentConversationPath(round.reviewerConversationId, round.reviewerPath));
      if (reviewer) reviewer.flow = { flowId: flow.id, flowRole: "reviewer", round: round.n };
    }
  }
}

export function getFlowsWithPresets(): { flows: Flow[]; presets: FlowPreset[] } {
  return { flows: loadFlows(), presets: loadPresets() };
}
