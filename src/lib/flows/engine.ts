import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { freshSpecFor, resumeSpecFor } from "@/lib/agent/cli";
import { accountManager } from "@/lib/accounts/manager";
import { projectAccountRefusalDetail } from "@/lib/accounts/projectBindings";
import type { AccountContext } from "@/lib/accounts/contracts";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { deliverToTranscriptHost } from "@/lib/agent/transcriptHost";
import { agentRegistry, type AgentRegistry, type RegistryConversation, type SpawnBeginResult, type SpawnReceipt, type TmuxHostEvidence } from "@/lib/agent/registry";
import { sessionKeyFromTranscript, sessionKeyId } from "@/lib/agent/sessionKey";
import { resolveSpawnedTranscriptPath } from "@/lib/agent/spawnedTranscript";
import { headCwd } from "@/lib/agent/transcript";
import { isNativeCodexSubagentTranscript } from "@/lib/scanner/codexNative";
import { enqueueStructuredMessage } from "@/lib/runtime/structuredMessageDelivery";
import type { AccountPark } from "@/lib/runtime/accountPark";
import { recoverDeadStructuredConversation } from "@/lib/runtime/structuredRecovery";
import { isShellCommand } from "@/lib/status";
import { cleanTitle, durableSemanticTitle, firstPromptLine, semanticTitle } from "@/lib/title";
import { killPane, paneInfo, spawnAgentWithPrompt, TmuxDeliveryUncertainError } from "@/lib/tmux";
import type { FileEntry } from "@/lib/types";

import {
  clearHeadlessReviewArtifacts,
  forgetHeadlessReview,
  headlessReviewStatus,
  startHeadlessReview,
  type HeadlessReviewLaunch,
} from "./exec";
import { resolveCleanFlowHead, resolveFlowRemoteHead } from "./git";
import {
  fallbackReviewFromTranscript,
  lastAssistantMessage,
  parseFindings,
  readFindingsFile,
  type ParsedFindings,
} from "./findings";
import { relayPrompt, reviewerPrompt } from "./prompts";
import { atomicWriteText, findingsPathFor, loadFlows, loadFlowsForTick, loadPresets, patchFlowRows, saveFlows } from "./store";
import type { Flow, FlowPreset, FlowState, RelayDeliveryTransport, RoleConfig, Round } from "./types";
import { chooseHeadlessReviewer, rateLimitStateDetail } from "./reviewerPolicy";

const TERMINAL_STATES = new Set<FlowState>(["approved", "done_comment", "needs_decision", "closed"]);
const READY_RE = /^REVIEW_READY:\s*(.*)$/m;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const store = globalThis as unknown as {
  __llvFlowTick?: boolean;
  __llvFlowRelayLeases?: Map<string, Promise<void>>;
};
const relayStartedThisProcess = new Set<string>();
const relayLeases = store.__llvFlowRelayLeases ??= new Map<string, Promise<void>>();
let sendRelay: typeof sendToImplementer;
const MAX_HEADLESS_NO_VERDICT_RETRIES = 1;
const MAX_RELAY_DELIVERY_RETRIES = 3;
const RELAY_RETRY_BACKOFF_MS = [1_000, 5_000, 30_000] as const;
/** How long a structured relay may sit accepted-but-unsettled before the round
    is declared undelivered and re-sent (#1065). The transport's accept only
    means the runtime host took the operation; the delivery journal reports
    whether the implementer actually received it. */
const RELAY_SETTLEMENT_TIMEOUT_MS = 180_000;
const REVIEWER_LAUNCH_LEASE_MS = 60_000;
const SYNTHETIC_LAUNCH_LOSS_DETAILS = new Set([
  "reviewer tracking was lost before a verdict could be recovered",
  "reviewer launch tracking is unavailable",
  "reviewer process is missing after server restart",
  "reviewer spawn was interrupted by a restart",
]);

class ReviewerAccountsExhaustedError extends Error {
  constructor(readonly resetsAt: number | null) {
    super("reviewer rate limited; all accounts exhausted");
    this.name = "ReviewerAccountsExhaustedError";
  }
}

class UnsafeInterruptedRelayRetryError extends Error {
  constructor() {
    super("interrupted relay cannot retry safely because the implementer has no idempotent structured delivery");
    this.name = "UnsafeInterruptedRelayRetryError";
  }
}

class StructuredRelayDeliveryUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuredRelayDeliveryUncertainError";
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
    hostClaim: flow.hostClaim ? { ...flow.hostClaim } : null,
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
    reviewerBindingId: crypto.randomUUID(),
    accountId: null,
    attemptedAccounts: [],
    autoRetryCount: 0,
    sessionId: null,
    reviewerPid: null,
    reviewerIdentity: null,
    /* Freeze the reviewer role now, so a later set-roles only affects the round
       after this one (#118); prepareReviewerLaunch re-freezes it at launch to pick
       up an override applied before the spawn. */
    reviewerRole: { ...flow.roles.reviewer },
    reviewerPane: null,
    findingsPath: null,
    triggeredBy,
    readyNote,
    reviewHeadSha: null,
    verdict: null,
    findingsCount: null,
    startedAt: isoNow(),
    spawnStartedAt: null,
    launchId: null,
    launchLeaseUntil: null,
    relayStartedAt: null,
    relayRetryCount: 0,
    relayDeliveryAttempt: 0,
    relayDeliveryTransport: null,
    relayRetryAt: null,
    relayRetryRequiresIdempotency: false,
    relayDelivery: null,
    relayPendingSettlement: null,
    relayHold: null,
    reviewedAt: null,
    terminalAt: null,
    relayedAt: null,
    error: null,
  };
}

export function reserveReviewerSpawn(
  flow: Flow,
  round: Round,
  role: RoleConfig,
  accountId: string | null,
  registry: AgentRegistry = agentRegistry(),
): Exclude<SpawnBeginResult, { kind: "conflict" }> {
  const implementer = flow.implementerConversationId?.startsWith("conversation_")
    ? registry.conversation(flow.implementerConversationId as `conversation_${string}`)
    : null;
  const owner = implementer ?? registry.ensureConversation(flow.roles.implementer.engine, flow.implementerPath, null);
  flow.implementerConversationId = owner.id;
  const parentPath = owner.generations.at(-1)?.path ?? flow.implementerPath;
  registry.rememberMembership(owner.id, {
    kind: "flow",
    containerId: flow.id,
    role: "implementer",
    slot: "implementer",
    stageId: null,
    stageOrder: 0,
    round: null,
    parentConversationId: null,
  });
  const reviewerBindingId = round.reviewerBindingId ?? crypto.randomUUID();
  round.reviewerBindingId = reviewerBindingId;
  const correlation = crypto.createHash("sha256")
    .update(`${flow.id}:${round.n}:${reviewerBindingId}`)
    .digest("hex")
    .slice(0, 24);
  const clientAttemptId = `flow_${flow.id}_${correlation}`;
  const reservedTitle = durableSemanticTitle(
    registry.spawnReceiptForClientAttempt(clientAttemptId)?.launchProfile.title,
    120,
  );
  const flowTitle = firstPromptLine(flow.spec ?? "", 80)
    ?? durableSemanticTitle(owner.generations.at(-1)?.launchProfile.title, 80)
    ?? semanticTitle(flow.project, 80)
    ?? "Review flow";
  const reviewerTitle = reservedTitle ?? cleanTitle(`${flowTitle} · review round ${round.n}`, 120);
  const begun = registry.beginSpawnRequest({
    engine: role.engine,
    cwd: flow.cwd,
    accountId,
    accountPin: accountId !== null,
    parentConversationId: owner.id,
    parentSessionKey: sessionKeyFromTranscript(owner.engine, parentPath),
    parentArtifactPath: parentPath,
    role: "reviewer",
    reviewsConversationId: owner.id,
    /* Container origin (#393): the flow controller initiates reviewer rounds,
       not the implementer — the implementer is only the lineage parent. */
    origin: { kind: "container", container: "flow", containerId: flow.id, creatorConversationId: null },
    launchProfile: emptyLaunchProfile({
      cwd: flow.cwd,
      parentConversationId: owner.id,
      title: reviewerTitle,
    }),
    memberships: [{
      kind: "flow",
      containerId: flow.id,
      role: "reviewer",
      slot: `reviewer:${round.n}:${reviewerBindingId}`,
      stageId: null,
      stageOrder: 1,
      round: round.n,
      parentConversationId: owner.id,
    }],
    clientAttemptId,
    requestDigest: crypto.createHash("sha256").update(JSON.stringify({
      flowId: flow.id,
      round: round.n,
      reviewerBindingId,
      role,
      accountId,
      reviews: owner.id,
    })).digest("hex"),
  });
  if (begun.kind === "conflict") throw new Error("reviewer spawn conflicts with its durable reservation");
  round.launchId = begun.receipt.launchId;
  round.reviewerConversationId = begun.receipt.conversationId;
  return begun;
}

export function captureReviewHead(flow: Flow, round: Round): string {
  const headSha = resolveCleanFlowHead(flow.cwd);
  if (!headSha) throw new Error("review requires a clean committed HEAD");
  if (flow.headRef) {
    const remoteSha = resolveFlowRemoteHead(flow.cwd, flow.headRef);
    if (remoteSha !== headSha) {
      const detail = remoteSha
        ? `review remote head mismatch before launch: local ${headSha}, origin/${flow.headRef} ${remoteSha}`
        : `review remote head is unavailable before launch: origin/${flow.headRef}`;
      markNeedsDecision(flow, detail);
      throw new Error(detail);
    }
  }
  if (round.n === 1 && flow.targetSha && headSha.toLowerCase() !== flow.targetSha.toLowerCase()) {
    const detail = `review target changed before launch: expected ${flow.targetSha}, found ${headSha}`;
    markNeedsDecision(flow, detail);
    throw new Error(detail);
  }
  round.reviewHeadSha = headSha;
  return headSha;
}

function markNeedsDecision(flow: Flow, detail: string): void {
  flow.state = "needs_decision";
  flow.stateDetail = detail;
}

function markRoundError(round: Round, error: string): string {
  round.error = error;
  round.terminalAt = isoNow();
  return error;
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

function safeAccountRef(accountId: string | null | undefined): NonNullable<Flow["hostClaim"]>["accountRef"] {
  if (!accountId) return "unknown";
  if (accountId === "default") return "default";
  return `managed:${crypto.createHash("sha256").update(accountId).digest("hex").slice(0, 12)}`;
}

function rememberImplementerHostClaim(flow: Flow, conversation: RegistryConversation | null): void {
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) return;
  flow.hostClaim = {
    sessionKey: sessionKeyId({ engine: conversation.engine, sessionId: generation.id }),
    accountRef: safeAccountRef(generation.accountId ?? conversation.pinnedAccountId ?? null),
  };
}

function claimFailureDetail(flow: Flow, detail: string): string {
  if (!flow.hostClaim || !/structured (?:resume )?host claim is unavailable|structured host ownership is unavailable/i.test(detail)) {
    return detail;
  }
  return `structured host claim ${flow.hostClaim.sessionKey} on account ${flow.hostClaim.accountRef} failed: ${detail}`;
}

/** The provider parked the implementer's account, so the relay was withheld
    instead of enqueued (#611). Carries the deadline the relay resumes at. */
export class RelayHeldByProviderLimitError extends Error {
  constructor(readonly hold: AccountPark) {
    super(hold.resetKnown
      ? `relay is held: the provider parked account ${hold.accountId} (${hold.reason}) until ${hold.until}`
      : `relay is held: account ${hold.accountId} has spent its quota window and the provider named no reset;`
        + ` the account is rechecked at ${hold.until}`);
    this.name = "RelayHeldByProviderLimitError";
  }
}

export interface RelayDeliveryOverrides {
  recover?: typeof recoverDeadStructuredConversation;
  enqueueStructured?: typeof enqueueStructuredMessage;
  deliver?: typeof deliverToTranscriptHost;
  /** Withhold the message when recovery reports the implementer's host parked
      behind a provider limit, instead of enqueuing into a host that cannot
      start the turn. Set by the relay tick, which owns a resume schedule and
      re-attempts at the deadline; the kickoff has no such schedule, so it
      keeps the queue behaviour it has always had. */
  holdWhenParked?: boolean;
  /** Restart recovery uses this fence when the prior process may have sent the
      relay before its durable settlement write. */
  requireIdempotentDelivery?: boolean;
  /** Reports the selected transport before either structured or legacy
      actuation can begin, allowing the caller to checkpoint it. */
  onTransportSelected?: (transport: RelayDeliveryTransport) => void;
}

/** The durable structured-delivery identity of a round's relay — the current
    round's by default, or any settled round's when given, so provenance can
    name the reservation each round's relay settled under (#1117). Exported so
    a test can address the exact reservation the delivery journal settles. */
export function relayClientMessageId(flow: Flow, round: Round | undefined = flow.rounds?.at(-1)): string {
  const deliveryAttempt = round?.relayDeliveryAttempt ?? 0;
  const identity = `${flow.id}:${round?.n ?? "legacy"}:${round?.reviewerBindingId ?? "legacy"}`
    + (deliveryAttempt > 0 ? `:retry:${deliveryAttempt}` : "");
  return `flow_relay_${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

export async function sendToImplementer(
  flow: Flow,
  entriesByPath: Map<string, FileEntry>,
  text: string,
  overrides: RelayDeliveryOverrides = {},
): Promise<string> {
  const entry = entriesByPath.get(currentConversationPath(flow.implementerConversationId, flow.implementerPath));
  if (!entry) throw new Error("implementer transcript is missing from scanner");
  /* Structured hosts first, exactly as deliverConversationMessage does. The
     legacy tmux ladder below refuses a pane-less Claude host outright
     ("structured transport prohibits legacy tmux Claude launches"), so a relay
     that only knew that ladder could not hand a finished review back to a
     structured implementer: flow 0d1364f8 held a real round-1 verdict and
     paused in `relaying` with nowhere to deliver it. The recovery probe is the
     same gate the canonical send path uses — it returns null whenever the
     conversation is not structured, which leaves legacy pane flows untouched. */
  const registry = agentRegistry();
  const conversation = flow.implementerConversationId?.startsWith("conversation_")
    ? registry.conversation(flow.implementerConversationId as `conversation_${string}`)
    : registry.conversationForPath(entry.path);
  if (conversation) {
    rememberImplementerHostClaim(flow, conversation);
    let recovered;
    try {
      recovered = await (overrides.recover ?? recoverDeadStructuredConversation)(
        { path: entry.path, conversationId: conversation.id },
        { registry },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(claimFailureDetail(flow, detail), { cause: error });
    }
    if (recovered) {
      /* Before any actuation: nothing is enqueued, no transport is recorded,
         and the round keeps its durable client-message identity, so the relay
         that runs after the park lapses is the same one, not a duplicate. */
      if (overrides.holdWhenParked && recovered.hold) throw new RelayHeldByProviderLimitError(recovered.hold);
      overrides.onTransportSelected?.("structured");
      const structured = await (overrides.enqueueStructured ?? enqueueStructuredMessage)(
        {
          path: recovered.path,
          conversationId: recovered.conversationId,
          clientMessageId: relayClientMessageId(flow),
          text,
          /* #1117: a relayed verdict is inter-agent traffic from the round's
             reviewer, and the feed labels it exactly that way. */
          origin: { kind: "agent", role: "reviewer" },
        },
        { registry: () => registry },
      );
      if (!structured) throw new Error("structured delivery ownership is unavailable");
      if (!structured.ok) {
        if (structured.transportUncertain || structured.receipt?.status === "uncertain") {
          throw new StructuredRelayDeliveryUncertainError(structured.error);
        }
        throw new Error(claimFailureDetail(flow, structured.error));
      }
      return recovered.path;
    }
    flow.hostClaim = null;
  }
  /* A restart leaves an uncertain send window. The structured queue dedupes
     the stable client-message id above; legacy pane delivery has no comparable
     receipt, so an automatic replay could duplicate the findings. */
  if (overrides.requireIdempotentDelivery) throw new UnsafeInterruptedRelayRetryError();
  const spec = resumeSpecFor(entry.root, entry.path, {
    model: entry.launchModel ?? entry.model,
    effort: entry.effort,
    allowSubagents: agentRegistry().launchProfileForPath(entry.path)?.allowSubagents,
    mcpServers: agentRegistry().launchProfileForPath(entry.path)?.mcpServers,
    plugins: agentRegistry().launchProfileForPath(entry.path)?.plugins,
  });
  if (!spec) throw new Error("implementer session cannot be resumed");
  overrides.onTransportSelected?.("legacy");
  const outcome = await (overrides.deliver ?? deliverToTranscriptHost)({ entry, spec, payload: text });
  if (!outcome.ok) {
    if (outcome.actuation === "started") {
      throw new TmuxDeliveryUncertainError(`legacy relay delivery is uncertain after actuation started: ${outcome.error}`);
    }
    throw new Error(outcome.error);
  }
  return entry.path;
}

sendRelay = sendToImplementer;

export function setRelayDeliveryForTest(delivery: typeof sendToImplementer): () => void {
  sendRelay = delivery;
  return () => { sendRelay = sendToImplementer; };
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
  round.terminalAt = round.reviewedAt;
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

function launchLeaseActive(round: Round, now = Date.now()): boolean {
  const until = Date.parse(round.launchLeaseUntil ?? "");
  return Boolean(round.launchId && Number.isFinite(until) && until > now);
}

function launchHasHandle(round: Round): boolean {
  return Boolean(round.reviewerPane || round.reviewerPid != null || round.reviewerPath || round.sessionId);
}

/** Reclaims a reviewer handle when an overlapping older Viewer tick parked the
    exact leased launch during its pre-handle checkpoint. Operator lifecycle
    actions and different launch ids remain authoritative. */
export function adoptSyntheticLaunchTakeover(flowId: string, launchedRound: Round): boolean {
  if (!launchedRound.launchId || !launchHasHandle(launchedRound)) return false;
  const flows = loadFlows();
  const diskFlow = flows.find((item) => item.id === flowId);
  const diskRound = diskFlow?.rounds.find((item) => item.n === launchedRound.n);
  if (
    !diskFlow ||
    !diskRound ||
    diskFlow.state !== "needs_decision" ||
    !SYNTHETIC_LAUNCH_LOSS_DETAILS.has(diskFlow.stateDetail ?? "") ||
    diskRound.launchId !== launchedRound.launchId
  ) return false;

  Object.assign(diskRound, {
    reviewerPath: launchedRound.reviewerPath,
    reviewerConversationId: launchedRound.reviewerConversationId ?? null,
    reviewerRole: launchedRound.reviewerRole ?? null,
    accountId: launchedRound.accountId ?? null,
    attemptedAccounts: [...(launchedRound.attemptedAccounts ?? [])],
    sessionId: launchedRound.sessionId ?? null,
    reviewerPid: launchedRound.reviewerPid ?? null,
    reviewerIdentity: launchedRound.reviewerIdentity ?? null,
    reviewerPane: launchedRound.reviewerPane ?? null,
    reviewHeadSha: launchedRound.reviewHeadSha ?? null,
    spawnStartedAt: launchedRound.spawnStartedAt ?? null,
    launchLeaseUntil: diskFlow.reviewerMode === "headless" && launchedRound.reviewerPid != null && !launchedRound.reviewerIdentity
      ? launchedRound.launchLeaseUntil
      : null,
    error: launchedRound.error,
  });
  diskFlow.state = "reviewing";
  diskFlow.stateDetail = null;
  saveFlows(flows);
  return true;
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
  round.launchId = null;
  round.launchLeaseUntil = null;
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

function adoptReviewerReceipt(flow: Flow, round: Round, receipt: SpawnReceipt): boolean {
  if (receipt.state === "failed" || receipt.state === "conflicted") {
    throw new Error(receipt.error ?? `reviewer reservation is ${receipt.state}`);
  }
  round.launchId = receipt.launchId;
  round.reviewerConversationId = receipt.conversationId;
  round.reviewerPath = receipt.artifactPath ?? round.reviewerPath;
  round.sessionId = receipt.key?.sessionId ?? round.sessionId;
  const host = receipt.verifiedHost;
  if (host) round.reviewerPane = { paneId: host.paneId, windowName: host.windowName };
  flow.state = "reviewing";
  flow.stateDetail = null;
  if (receipt.artifactPath || host) round.launchLeaseUntil = null;
  return receipt.state !== "starting" || Boolean(receipt.artifactPath || receipt.pane || receipt.verifiedHost);
}

function settleReviewerSpawn(flow: Flow, round: Round, role: RoleConfig, accountId: string | null, host: TmuxHostEvidence | null = null): void {
  if (!round.launchId || !round.reviewerPath) return;
  const registry = agentRegistry();
  const receipt = registry.readOnlySnapshot().receipts[round.launchId];
  if (!receipt) return;
  if (receipt?.state === "completed") {
    round.reviewerConversationId = receipt.conversationId;
    return;
  }
  const key = sessionKeyFromTranscript(role.engine, round.reviewerPath);
  if (!key) return;
  const settled = registry.settleSpawn(round.launchId, {
    key,
    artifactPath: round.reviewerPath,
    cwd: flow.cwd,
    accountId,
    status: "starting",
    host,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: "spawn",
  });
  if (settled.kind === "conflict") throw new Error(settled.code);
  round.reviewerConversationId = settled.conversation.id;
}

/* Rate-limit-aware account + role selection (issue #117): pane reviewers use the
   flow's reviewer role, headless reviewers pick an account excluding ones already
   attempted this round, parking the flow when every account is exhausted. Freezes
   round.reviewerRole here at launch, re-picking up an override applied before the
   spawn (over the newRound snapshot). */
function prepareReviewerLaunch(flow: Flow, round: Round): PreparedReviewerLaunch {
  if (flow.reviewerMode === "pane") {
    const role = flow.roles.reviewer;
    /* #1279: the flow's project fences this pick too. A round with no account
       yet draws one from the project's pool, capacity-aware, exactly as the
       headless path below does. A round that already has one is carrying the
       account FROZEN at its start — `Round.accountId` exists so polling and
       retry never silently adopt a different one — so it is passed as a pin,
       and a frozen account the project forbids parks the flow with the reason
       rather than being quietly re-seated mid-round. */
    const resolution = accountManager.resolveProjectSpawn(role.engine, {
      project: flow.project,
      requestedId: round.accountId,
    });
    if (resolution.kind !== "available") {
      throw new Error(projectAccountRefusalDetail(resolution, role.engine, flow.project));
    }
    const account = resolution.account;
    round.accountId = account.accountId;
    round.reviewerRole = { ...role };
    return { role, account };
  }
  const decision = chooseHeadlessReviewer(
    flow.roles.reviewer,
    flow.reviewerFallback,
    round.attemptedAccounts ?? [],
    /* The project is passed down so the automatic rate-limit switch draws from
       the project's allowed set only. Every allowed account exhausted parks the
       flow with `rateLimitStateDetail`, exactly as it already did — it just
       can no longer reach an account the project forbids to avoid parking. */
    (engine, requestedId, excludedIds) => accountManager.resolveHeadlessSpawn(engine, requestedId ?? null, excludedIds ?? [], flow.project),
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

async function launchReviewer(
  flow: Flow,
  round: Round,
  prepared: PreparedReviewerLaunch,
  reservation: Exclude<SpawnBeginResult, { kind: "conflict" }>,
  persistCheckpoint: () => void,
): Promise<void> {
  if (reservation.kind === "replay" && adoptReviewerReceipt(flow, round, reservation.receipt)) return;
  persistCheckpoint();
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
    const pane = await spawnAgentWithPrompt(spec, prompt, reservation.receipt);
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
    settleReviewerSpawn(flow, round, role, account.accountId, pane.host ?? null);
    if (!round.reviewerPath && pane.panePid) round.error = null;
    round.launchLeaseUntil = null;
    /* Persist the pane handle NOW so a close that races the tail of this spawn can
       find and stop it. If a concurrent close/pause/retry took the flow over, the
       merge dropped our handle — the pane is an orphan, so kill it, and let a
       resume/retry re-spawn cleanly rather than parking as interrupted. */
    persistCheckpoint();
    const paneDisk = loadFlows().find((item) => item.id === flow.id);
    if (!reviewerLaunchPersisted(paneDisk, round)) {
      if (adoptSyntheticLaunchTakeover(flow.id, round)) return;
      await stopOrphanPane(round);
      if (paneDisk && paneDisk.state !== "closed") abandonLaunch(flow.id, round.n);
    }
    return;
  }
  const spawnCapability = agentRegistry().rotateSpawnCapabilityForReceipt(reservation.receipt.launchId);
  const launched = startHeadlessReview(
    flow.id,
    round.n,
    role,
    flow.cwd,
    prompt,
    undefined,
    account.engine === "codex" ? { home: account.home, managed: account.kind === "managed" } : null,
    account.engine === "claude" ? { home: account.home, projectsDir: account.transcriptRoot, managed: account.kind === "managed" } : null,
    undefined,
    spawnCapability,
  );
  recordHeadlessLaunch(round, launched);
  settleReviewerSpawn(flow, round, role, account.accountId);
  /* Same ownership guard as the pane branch: persist the pid, and if a concurrent
     close/pause/retry took the flow over, terminate the orphan (forgetHeadlessReview
     SIGTERM/SIGKILLs the detached group) and clear the abandoned spawn markers so
     resume/retry re-spawns fresh. */
  persistCheckpoint();
  const headlessDisk = loadFlows().find((item) => item.id === flow.id);
  if (!reviewerLaunchPersisted(headlessDisk, round)) {
    if (adoptSyntheticLaunchTakeover(flow.id, round)) return;
    forgetHeadlessReview(flow.id, round.n, round);
    if (headlessDisk && headlessDisk.state !== "closed") abandonLaunch(flow.id, round.n);
  }
}

export function recordHeadlessLaunch(round: Round, launched: HeadlessReviewLaunch): void {
  if (launched.pid) {
    round.reviewerPid = launched.pid;
    round.reviewerIdentity = launched.identity;
  }
  if (launched.sessionId) round.sessionId = launched.sessionId;
  if (launched.reviewerPath) round.reviewerPath = launched.reviewerPath;
  if (launched.identity) round.launchLeaseUntil = null;
}

function retryHeadlessRound(flow: Flow, round: Round): void {
  forgetHeadlessReview(flow.id, round.n, round);
  clearHeadlessReviewArtifacts(flow.id, round.n);
  Object.assign(round, {
    reviewerPath: null,
    reviewerConversationId: null,
    reviewerBindingId: crypto.randomUUID(),
    reviewerRole: null,
    accountId: null,
    sessionId: null,
    reviewerPid: null,
    reviewerIdentity: null,
    reviewerPane: null,
    findingsPath: null,
    verdict: null,
    findingsCount: null,
    reviewHeadSha: null,
    autoRetryCount: (round.autoRetryCount ?? 0) + 1,
    startedAt: isoNow(),
    spawnStartedAt: null,
    launchId: null,
    launchLeaseUntil: null,
    relayStartedAt: null,
    relayRetryCount: 0,
    relayDeliveryAttempt: 0,
    relayDeliveryTransport: null,
    relayRetryAt: null,
    relayRetryRequiresIdempotency: false,
    relayPendingSettlement: null,
    reviewedAt: null,
    relayedAt: null,
    error: null,
  });
  flow.state = "spawning";
  flow.stateDetail = `reviewer produced no verdict; retrying automatically (${round.autoRetryCount}/${MAX_HEADLESS_NO_VERDICT_RETRIES})`;
}

/**
 * The durable settlement evidence for a structured relay, read from the very
 * rows the lifecycle journal projects `delivery_delivered` from (#1065): the
 * registry's held-delivery reservations, keyed by the relay's stable
 * client-message id. A row that has not reached `delivered` is not evidence —
 * flow 50dc0385 recorded `relayDelivery.deliveredAt` from the transport's
 * optimistic accept while the journal never saw the message land, and the flow
 * then waited in `fixing` for a REVIEW_READY that could never come.
 */
export function relayJournalSettlement(
  flow: Flow,
  registry: AgentRegistry = agentRegistry(),
): { deliveredAt: string } | null {
  const clientMessageId = relayClientMessageId(flow);
  const delivery = Object.values(registry.readOnlySnapshot().heldDeliveries)
    .find((item) => item.clientMessageId === clientMessageId);
  if (delivery?.state !== "delivered") return null;
  return { deliveredAt: delivery.deliveredAt ?? isoNow() };
}

function settleRelay(flow: Flow, round: Round, deliveryPath: string, deliveredAt: string): void {
  round.relayDelivery = { path: deliveryPath, deliveredAt };
  round.relayedAt = deliveredAt;
  round.relayPendingSettlement = null;
  round.relayHold = null;
  round.relayRetryAt = null;
  round.relayRetryRequiresIdempotency = false;
  round.error = null;
  flow.stateDetail = null;
  completeRelayTransition(flow, round);
}

async function relayFindings(
  flow: Flow,
  entriesByPath: Map<string, FileEntry>,
  round: Round,
  options: Pick<RelayDeliveryOverrides, "requireIdempotentDelivery" | "onTransportSelected"> = {},
): Promise<void> {
  if (!round.findingsPath) throw new Error("round has no findings artifact");
  const findings = fs.readFileSync(round.findingsPath, "utf8");
  flow.state = "relaying";
  const deliveryPath = await sendRelay(flow, entriesByPath, relayPrompt(round, findings), {
    ...options,
    holdWhenParked: true,
  });
  /* The park lapsed and the host took the message, so the hold is history. */
  round.relayHold = null;
  /* Only the structured transport writes a delivery journal, so only it can be
     held to journal corroboration. Legacy tmux delivery has no durable receipt
     at all (that is why its interrupted replays are refused), and keeps the
     transport-level settlement it always had. */
  if (round.relayDeliveryTransport === "structured") {
    const settlement = relayJournalSettlement(flow);
    if (!settlement) {
      round.relayPendingSettlement = { path: deliveryPath, since: isoNow() };
      round.relayRetryAt = null;
      round.relayRetryRequiresIdempotency = false;
      round.error = null;
      flow.stateDetail = "relay accepted by the structured transport; awaiting delivery journal settlement";
      return;
    }
    settleRelay(flow, round, deliveryPath, settlement.deliveredAt);
    return;
  }
  settleRelay(flow, round, deliveryPath, isoNow());
}

function scheduleRelayRetry(
  flow: Flow,
  round: Round,
  detail: string,
  requireIdempotentDelivery = round.relayRetryRequiresIdempotency ?? false,
): boolean {
  round.relayPendingSettlement = null;
  round.relayHold = null;
  const consumed = round.relayRetryCount ?? 0;
  if (consumed >= MAX_RELAY_DELIVERY_RETRIES) {
    round.error = detail;
    round.relayRetryAt = null;
    markNeedsDecision(flow, `relay delivery failed after ${consumed} automatic retries: ${detail}`);
    return false;
  }
  const next = consumed + 1;
  round.relayRetryCount = next;
  if (!requireIdempotentDelivery) {
    round.relayDeliveryAttempt = (round.relayDeliveryAttempt ?? 0) + 1;
  }
  round.relayRetryAt = new Date(Date.now() + RELAY_RETRY_BACKOFF_MS[next - 1]!).toISOString();
  round.relayStartedAt = null;
  round.relayRetryRequiresIdempotency = requireIdempotentDelivery;
  round.error = detail;
  flow.state = "relaying";
  flow.pausedState = null;
  flow.stateDetail = `relay delivery failed; retrying automatically (${next}/${MAX_RELAY_DELIVERY_RETRIES}): ${detail}`;
  return true;
}

/**
 * Hold the relay until the provider's own deadline, or — when the provider
 * named none — until the recheck the park bounded itself with (#611).
 *
 * A hold is not a delivery failure and not a timeout: the message never left
 * the Viewer, so the bounded retry budget, the delivery attempt generation and
 * the idempotent client-message identity are all untouched, and no item is
 * left sitting `queued` against a host that cannot start a turn. The round
 * stays in `relaying` and re-attempts at `until`, which the ordinary
 * `relayRetryAt` gate already enforces; `relayHold` records what it waits on
 * so the flow record names the wait, and the read model projects it onto the
 * strip and the loop hub as a block with the deadline — or, for an unknown
 * reset, as a wait that says the reset is unknown and names its recheck.
 * Either way the wait ends by itself: the exhaustion reading behind an unknown
 * reset stops being evidence at that recheck unless a fresh one renews it.
 */
function holdRelayForProviderLimit(flow: Flow, round: Round, hold: AccountPark): void {
  const previous = round.relayHold;
  /* One wait, however often its deadline is renewed: an unknown-reset park
     bounds itself with a recheck that moves forward every time a fresh reading
     confirms the exhaustion, and restarting `since` on each renewal would hide
     how long the relay has actually been waiting. */
  const continuing = previous?.accountId === hold.accountId
    && previous.reason === hold.reason
    && (previous.resetKnown ?? true) === hold.resetKnown;
  round.relayPendingSettlement = null;
  round.relayStartedAt = null;
  round.relayHold = {
    reason: hold.reason,
    accountId: hold.accountId,
    until: hold.until,
    since: continuing ? previous.since : isoNow(),
    resetKnown: hold.resetKnown,
  };
  round.relayRetryAt = hold.until;
  round.error = null;
  flow.state = "relaying";
  flow.pausedState = null;
  flow.stateDetail = hold.resetKnown
    ? `relay held: the provider parked account ${hold.accountId} (${hold.reason});`
      + ` delivery resumes at ${hold.until}`
    : `relay held: account ${hold.accountId} has spent its quota window and the provider named no reset;`
      + ` nothing is queued, and the account is rechecked at ${hold.until}`;
}

function completeRelayTransition(flow: Flow, round: Round): void {
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

export async function tickFlow(
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
      const markerRound = newRound(flow, "marker", note);
      flow.rounds.push(markerRound);
      try {
        /* Pipeline-owned flows carry headRef. Capture their clean published
           repair fence in the same durable marker transition, before a delayed
           reviewer launch or parent reconciliation can expose the prior HEAD. */
        if (flow.headRef) captureReviewHead(flow, markerRound);
        flow.state = flow.mode === "manual" ? "spawn_pending" : "spawning";
        flow.stateDetail = null;
      } catch (error) {
        const detail = error instanceof Error ? error.message : "review head capture failed";
        markerRound.error = detail;
        markNeedsDecision(flow, detail);
      }
    }
    return JSON.stringify(flow) !== before;
  }

  const round = lastRound(flow);
  if (!round) return JSON.stringify(flow) !== before;

  if (flow.state === "spawning") {
    const status = flow.reviewerMode === "headless"
      ? headlessReviewStatus(flow.id, round.n, round, reviewerRoleFor(flow, round).engine)
      : null;
    const preHandleLaunch = Boolean(
      round.spawnStartedAt &&
      !round.reviewerPane &&
      round.reviewerPid == null &&
      !round.reviewerPath &&
      !round.sessionId,
    );
    if (preHandleLaunch && launchLeaseActive(round) && (flow.reviewerMode === "pane" || status?.status === "lost")) {
      return JSON.stringify(flow) !== before;
    }
    /* A restart can land here with the round already launched (state was
       persisted before launchReviewer finished). The detached reviewer is
       still out there — adopt it instead of spawning a duplicate. */
    if (round.spawnStartedAt && flow.reviewerMode === "headless" && status?.status === "lost") {
      markNeedsDecision(flow, "reviewer tracking was lost before a verdict could be recovered");
      return JSON.stringify(flow) !== before;
    }
    if (round.spawnStartedAt && flow.reviewerMode === "headless" && status) {
      flow.state = "reviewing";
      flow.stateDetail = null;
      return JSON.stringify(flow) !== before;
    }
    if (round.spawnStartedAt && !status && round.reviewerPath === null) {
      markNeedsDecision(flow, "reviewer launch tracking is unavailable");
      return JSON.stringify(flow) !== before;
    }
    try {
      const prepared = prepareReviewerLaunch(flow, round);
      captureReviewHead(flow, round);
      round.spawnStartedAt = isoNow();
      const reservation = reserveReviewerSpawn(flow, round, prepared.role, prepared.account.accountId);
      round.launchLeaseUntil = new Date(Date.now() + REVIEWER_LAUNCH_LEASE_MS).toISOString();
      persistCheckpoint();
      /* launchReviewer persists again after spawning (for the ownership/orphan
         check), so no extra checkpoint is needed here. */
      await launchReviewer(flow, round, prepared, reservation, persistCheckpoint);
    } catch (error) {
      if (error instanceof ReviewerAccountsExhaustedError) {
        round.error = null;
        markNeedsDecision(flow, rateLimitStateDetail(error.resetsAt));
      } else {
        markNeedsDecision(flow, markRoundError(round, error instanceof Error ? error.message : String(error)));
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
      if (status?.processIdentity) {
        round.reviewerIdentity = status.processIdentity;
        round.launchLeaseUntil = null;
      }
      maybeClaimReviewerPathBySession(entries, round, round.sessionId ?? null);
      if (!round.reviewerPath && !round.sessionId) maybeClaimReviewerPathByHeuristic(flow, entries, round);
      settleReviewerSpawn(flow, round, reviewerRoleFor(flow, round), round.accountId ?? null);
      if (status?.status === "lost" && launchLeaseActive(round)) return JSON.stringify(flow) !== before;
      if (status?.status === "running") return JSON.stringify(flow) !== before;
      if (status?.status === "lost") {
        const fallback = fallbackReviewFromTranscript(round, entriesByPath, reviewerRoleFor(flow, round).engine);
        if (fallback) applyVerdict(flow, round, fallback);
        else markNeedsDecision(flow, "reviewer tracking was lost before a verdict could be recovered");
        return JSON.stringify(flow) !== before;
      }
      if (status) {
        forgetHeadlessReview(flow.id, round.n, round);
        /* The last-message artifact can lag or contain only an interim Codex
           message. The persisted rollout is authoritative once it carries a
           verdict, and consulting it before retry prevents duplicate reviewers. */
        const parsed = parseFindings(status.finalOutput) ?? fallbackReviewFromTranscript(round, entriesByPath, reviewerRoleFor(flow, round).engine);
        if (parsed) {
          applyVerdict(flow, round, parsed);
        } else if ((round.autoRetryCount ?? 0) < MAX_HEADLESS_NO_VERDICT_RETRIES) {
          retryHeadlessRound(flow, round);
        } else {
          const rawPath = round.findingsPath ?? findingsPathFor(flow.id, round.n);
          atomicWriteText(rawPath, status.finalOutput || status.stdout || status.stderr);
          round.findingsPath = rawPath;
          markNeedsDecision(flow, markRoundError(round, status.status === "timeout" ? "reviewer timed out" : status.stderr.trim() || "reviewer verdict was unparseable"));
        }
        return JSON.stringify(flow) !== before;
      }
      const fallback = fallbackReviewFromTranscript(round, entriesByPath, reviewerRoleFor(flow, round).engine);
      if (fallback) {
        applyVerdict(flow, round, fallback);
      } else {
        markNeedsDecision(flow, "reviewer tracking is unavailable and no verdict could be recovered");
      }
      return JSON.stringify(flow) !== before;
    }
    maybeClaimReviewerPathByHeuristic(flow, entries, round);
    settleReviewerSpawn(flow, round, reviewerRoleFor(flow, round), round.accountId ?? null, round.reviewerPane
      ? agentRegistry().readOnlySnapshot().receipts[round.launchId ?? ""]?.verifiedHost ?? null
      : null);
    if (round.reviewerPath) {
      const reviewer = entriesByPath.get(round.reviewerPath);
      const fallback = fallbackReviewFromTranscript(round, entriesByPath, reviewerRoleFor(flow, round).engine);
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
    if (round.relayedAt !== null) {
      completeRelayTransition(flow, round);
      return JSON.stringify(flow) !== before;
    }
    /* An accepted-but-unsettled structured relay (#1065). The round is
       undelivered until the delivery journal says otherwise; a journal that
       stays silent past the settlement window hands the round to the same
       bounded retry path a transport failure uses, under the idempotent
       client-message identity so a late-landing delivery cannot duplicate. */
    if (round.relayPendingSettlement) {
      const settlement = relayJournalSettlement(flow);
      if (settlement) {
        settleRelay(flow, round, round.relayPendingSettlement.path, settlement.deliveredAt);
      } else if (Date.now() - unixMs(round.relayPendingSettlement.since) >= RELAY_SETTLEMENT_TIMEOUT_MS) {
        relayStartedThisProcess.delete(relayKey);
        scheduleRelayRetry(flow, round, "structured relay was accepted but never settled in the delivery journal", true);
      }
      return JSON.stringify(flow) !== before;
    }
    const activeRelay = relayLeases.get(relayKey);
    if (activeRelay) {
      await activeRelay;
      return JSON.stringify(flow) !== before;
    }
    if (round.relayStartedAt && round.relayedAt === null && !relayStartedThisProcess.has(relayKey)) {
      if (round.relayDeliveryTransport === "structured") {
        scheduleRelayRetry(flow, round, "structured relay was interrupted before delivery settlement", true);
      } else {
        const detail = round.relayDeliveryTransport === "legacy"
          ? "legacy relay was interrupted before delivery settlement; automatic replay is unsafe"
          : "relay transport was not durably classified before interruption; automatic replay is unsafe";
        round.error = detail;
        round.relayRetryAt = null;
        markNeedsDecision(flow, detail);
      }
      return JSON.stringify(flow) !== before;
    }
    if (round.relayRetryAt && Date.now() < unixMs(round.relayRetryAt)) {
      return JSON.stringify(flow) !== before;
    }
    const lease = (async () => {
      try {
        round.relayRetryAt = null;
        round.relayDeliveryTransport = null;
        round.relayStartedAt = isoNow();
        relayStartedThisProcess.add(relayKey);
        persistCheckpoint();
        await relayFindings(flow, entriesByPath, round, {
          requireIdempotentDelivery: round.relayRetryRequiresIdempotency ?? false,
          onTransportSelected: (transport) => {
            round.relayDeliveryTransport = transport;
            persistCheckpoint();
          },
        });
        persistCheckpoint();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (error instanceof RelayHeldByProviderLimitError) {
          holdRelayForProviderLimit(flow, round, error.hold);
        } else if (error instanceof UnsafeInterruptedRelayRetryError || error instanceof TmuxDeliveryUncertainError) {
          round.error = detail;
          round.relayRetryAt = null;
          markNeedsDecision(flow, detail);
        } else if (error instanceof StructuredRelayDeliveryUncertainError) {
          scheduleRelayRetry(flow, round, detail, true);
        } else {
          scheduleRelayRetry(flow, round, detail, false);
        }
        relayStartedThisProcess.delete(relayKey);
        persistCheckpoint();
      }
    })();
    relayLeases.set(relayKey, lease);
    try {
      await lease;
    } finally {
      if (relayLeases.get(relayKey) === lease) relayLeases.delete(relayKey);
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
 *     taken over by the operator; pause/close retain their lifecycle state while
 *     accepting exact-round successful relay settlement, and other takeovers win;
 *   - otherwise the tick's result lands, but operator-owned fields are taken from
 *     disk: top-level roles/roundLimit/mode, and each unstarted round's
 *     reviewerRole (the tick never edits an unspawned round's snapshot — only
 *     set-roles does), so a config change without a lifecycle change survives.
 * Fully synchronous, so no patchFlow can interleave between the read and write.
 */
export function persistTickFlows(
  flows: Flow[],
  base: Map<string, FlowTickBase>,
  candidateIds?: ReadonlySet<string>,
): void {
  const tickById = new Map(flows.map((flow) => [flow.id, flow] as const));
  const ids = candidateIds ?? new Set(tickById.keys());
  patchFlowRows(ids, (diskFlows) => {
    const changed: Flow[] = [];
    for (const diskFlow of diskFlows) {
      const tick = tickById.get(diskFlow.id);
      if (!tick) continue;
      const start = base.get(diskFlow.id);
      if (!start) continue;
      /* The tick touched nothing on this flow → whatever is on disk now wins. */
      if (JSON.stringify(tick) === start.snapshot) continue;
      const takenOver =
        diskFlow.state !== start.state ||
        diskFlow.rounds.length !== start.roundsLen ||
        diskFlow.closedAt !== start.closedAt;
      if (takenOver) {
        if (diskFlow.state !== "paused" && diskFlow.state !== "closed") continue;
        const baseFlow = JSON.parse(start.snapshot) as Flow;
        const settledByRound = new Map(tick.rounds.flatMap((round) => {
          const baseRound = baseFlow.rounds.find((item) => item.n === round.n);
          return baseRound?.relayedAt == null && round.relayDelivery && round.relayedAt
            ? [[round.n, round] as const]
            : [];
        }));
        if (settledByRound.size === 0) continue;
        const next = {
          ...diskFlow,
          rounds: diskFlow.rounds.map((diskRound) => {
            const settled = settledByRound.get(diskRound.n);
            return settled && settled.reviewerBindingId === diskRound.reviewerBindingId ? {
              ...diskRound,
              relayStartedAt: settled.relayStartedAt,
              relayDelivery: settled.relayDelivery,
              relayedAt: settled.relayedAt,
            } : diskRound;
          }),
        };
        changed.push(next);
        continue;
      }
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
      const next = {
        ...tick,
        revision: diskFlow.revision,
        rounds,
        roles: diskFlow.roles,
        roundLimit: diskFlow.roundLimit,
        mode: diskFlow.mode,
      };
      changed.push(next);
    }
    return changed;
  });
}

export async function tickFlows(entries: FileEntry[]): Promise<TickResult> {
  if (store.__llvFlowTick) {
    const flows = cloneFlows(loadFlows());
    annotateFlowEntries(entries, flows);
    return { flows, changed: false };
  }
  store.__llvFlowTick = true;
  const flows = cloneFlows(loadFlowsForTick());
  const base = flowTickBase(flows);
  const changedIds = new Set<string>();
  try {
    const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
    let changed = false;
    for (const flow of flows) {
      if (TERMINAL_STATES.has(flow.state)) continue;
      const flowChanged = await tickFlow(flow, entries, entriesByPath, () => {
        persistTickFlows(flows, base, new Set([...changedIds, flow.id]));
      });
      if (flowChanged) {
        changed = true;
        changedIds.add(flow.id);
        persistTickFlows(flows, base, changedIds);
      }
    }
    if (changed) persistTickFlows(flows, base, changedIds);
    const projected = cloneFlows(loadFlows());
    annotateFlowEntries(entries, projected);
    return { flows: projected, changed };
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
