import { resumeSpecFor } from "@/lib/agent/cli";
import type { AgentReconfiguration } from "@/lib/agent/reconfigure";
import { agentRegistry, type AgentRegistry, type AgentRegistryEntry, type TmuxHostEvidence } from "@/lib/agent/registry";
import { deliveryFence } from "@/lib/accounts/migration/coordinator";
import { requestAccountMigrationTick } from "@/lib/accounts/migration/controllerSignal";
import { deliverToTranscriptHost, readTranscriptHosts, type HostDeliveryOutcome } from "@/lib/agent/transcriptHost";
import { listFiles } from "@/lib/scanner";
import { pathAllowed } from "@/lib/scanner/roots";
import { procBackend } from "@/lib/proc";
import { detectBlockingGate, parseScreenMenu, screenAtIdleComposer, screenWaitsForInput } from "@/lib/status";
import {
  buildImagePayload,
  deleteInboxImages,
  forgetResumePane,
  killTmuxHostIfMatches,
  knownLivePids,
  paneScreen,
  resolveTarget,
  sendInterrupt,
  sendKeys,
  sendText,
  TmuxDeliveryUncertainError,
  withPaneLock,
  type InboxImagePayload,
} from "@/lib/tmux";

/**
 * Conversation-level delivery: every action the tmux API exposes, expressed
 * over transcript paths instead of panes. This module owns the resolution
 * ladder — live pane → resume window → relay through the root conversation —
 * and each per-action guard; the route only maps HTTP to these calls.
 */

export interface DeliveryFailure {
  ok: false;
  outcome: "failed";
  error: string;
  status: number;
  actuation?: "started";
}

export interface DeliverySuccess {
  ok: true;
  target: string;
  outcome?: "delivered-to-live" | "resumed" | "held" | "pending" | "reconfigured";
  imagePaths?: string[];
  /** Set when the message booted a fresh agent window instead of an existing pane. */
  spawned?: boolean;
}

interface ReconfigureConversationOverrides {
  pathAllowed?: typeof pathAllowed;
  listFiles?: typeof listFiles;
  resumeSpecFor?: typeof resumeSpecFor;
  livePaneHost?: typeof livePaneHost;
  registry?: AgentRegistry;
  paneScreen?: typeof paneScreen;
  killHost?: typeof killTmuxHostIfMatches;
  deliver?: typeof deliverToTranscriptHost;
}

export async function reconfigureConversation(
  filePath: string,
  config: AgentReconfiguration,
  overrides: ReconfigureConversationOverrides = {},
): Promise<DeliveryOutcome> {
  if (!filePath || !(overrides.pathAllowed ?? pathAllowed)(filePath)) return failure("the conversation path is required", 400);
  const entry = (await (overrides.listFiles ?? listFiles)()).find((item) => item.path === filePath);
  if (!entry || (entry.engine !== "claude" && entry.engine !== "codex")) return failure("conversation is unavailable", 403);
  const registry = overrides.registry ?? agentRegistry();
  const registered = registeredHostForPath(registry.snapshot(), filePath);
  if (!registered?.host) return failure("no registered agent pane for this conversation", 404);
  const buildSpec = (profile: AgentRegistryEntry["launchProfile"]) => (overrides.resumeSpecFor ?? resumeSpecFor)(entry.root, entry.path, {
    ...config,
    readOnly: profile?.readOnly ?? null,
    permissionMode: profile?.permissionMode ?? null,
  });
  const deliver = overrides.deliver ?? deliverToTranscriptHost;
  const observedHost = await (overrides.livePaneHost ?? livePaneHost)(filePath);
  const paneId = observedHost?.paneId ?? registered.host.paneId;
  const target = observedHost?.display ?? registered.host.paneId;
  const owner = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
  try {
    const prepared = await registry.withOperationLock(registered.key, owner, async () => {
      const refreshed = registeredHostForPath(registry.snapshot(), filePath);
      if (!refreshed?.host || refreshed.host.paneId !== paneId) {
        return failure("the registered pane changed", 409);
      }
      const spec = buildSpec(refreshed.launchProfile);
      if (!spec) return failure("this conversation cannot be resumed", 409);
      const refreshedHost = refreshed.host;
      return withPaneLock(paneId, async () => {
        if (!screenAtIdleComposer(await (overrides.paneScreen ?? paneScreen)(paneId))) {
          return "pending" as const;
        }
        if (!await (overrides.killHost ?? killTmuxHostIfMatches)(refreshedHost)) return failure("the registered pane changed or its process did not exit", 409);
        registry.markUnhosted(refreshed.key);
        forgetResumePane(filePath);
        return { state: "prepared" as const, spec };
      });
    });
    if (prepared === "pending") return { ok: true, target, outcome: "pending" };
    if (!("state" in prepared)) return prepared;
    /* Resume acquires the same per-session serialization lock through the
       transcript-host adapter. The termination lock must be released first. */
    const resumed = await hostOutcome(deliver({ entry: { ...entry, pid: null, proc: "done" }, spec: prepared.spec, payload: "" }));
    return resumed.ok ? { ...resumed, outcome: "reconfigured" } : resumed;
  } catch (error) {
    return failure(error);
  }
}

export type DeliveryOutcome = DeliverySuccess | DeliveryFailure;

export function migrationDeliveryOutcome(outcome: DeliveryOutcome): "delivered" | "failed" | "delivery-uncertain" | "held" {
  if (!outcome.ok) return outcome.actuation === "started" ? "delivery-uncertain" : "failed";
  return outcome.outcome === "held" ? "held" : "delivered";
}

function failure(error: unknown, status = 500, actuation?: "started"): DeliveryFailure {
  return {
    ok: false,
    outcome: "failed",
    error: error instanceof Error ? error.message : String(error),
    status,
    ...(actuation ? { actuation } : {}),
  };
}

async function hostOutcome(result: Promise<HostDeliveryOutcome>): Promise<DeliveryOutcome> {
  const outcome = await result;
  if (!outcome.ok) return outcome;
  return { ...outcome, spawned: outcome.outcome === "resumed" };
}

/** A host failure happens after image payload construction. Keep the cleanup
    beside the returned outcome so direct and root-relayed delivery share the
    same no-orphan contract. */
export function cleanupFailedImageDelivery(outcome: DeliveryOutcome, imagePaths: string[]): DeliveryOutcome {
  if (!outcome.ok && outcome.actuation !== "started") deleteInboxImages(imagePaths);
  return outcome;
}

/** Resolves and revalidates a request pid against the scanner's live set. */
export async function targetForKnownPid(pid: number): Promise<string | null | "unknown"> {
  const live = await knownLivePids();
  if (!live.has(pid)) return "unknown";
  return resolveTarget(pid);
}

/**
 * Live pane of a conversation, for an interrupt or a kill. The pid comes from
 * the scanner's own entry for the path — a client-supplied pid is ignored
 * (like /api/proc), since resolving it directly would let any same-origin
 * caller reach an unrelated agent's pane. Never boots a fresh agent window:
 * both actions only make sense against a pane that already exists.
 */
async function livePaneHost(filePath: string) {
  if (!filePath || !pathAllowed(filePath)) return null;
  return (await readTranscriptHosts(true)).canonicalFor(filePath);
}

/** Human-readable target of the shared canonical resolver for non-message
    actions that only operate on a presently live pane. */
export async function livePaneTarget(filePath: string): Promise<string | null> {
  return (await livePaneHost(filePath))?.display ?? null;
}

export async function interruptConversation(filePath: string): Promise<DeliveryOutcome> {
  if (!filePath || !pathAllowed(filePath)) {
    return failure("the conversation path is required to interrupt", 400);
  }
  const host = await livePaneHost(filePath);
  if (host === null) {
    return failure("no active agent pane to interrupt", 409);
  }
  try {
    await sendInterrupt(host.paneId);
    return { ok: true, target: host.display };
  } catch (error) {
    return failure(error);
  }
}

/* The /compact slash command typed into the live pane: both agent CLIs
   parse a submitted "/compact" and condense their context; the transcript
   then grows a compaction marker the feed renders as a band. Only makes
   sense against a pane that already exists — never boots a window. */
export async function compactConversation(filePath: string): Promise<DeliveryOutcome> {
  if (!filePath || !pathAllowed(filePath)) {
    return failure("the conversation path is required to compact", 400);
  }
  const host = await livePaneHost(filePath);
  if (host === null) {
    return failure("no active agent pane to compact", 409);
  }
  try {
    await sendText(host.paneId, "/compact");
    return { ok: true, target: host.display };
  } catch (error) {
    return failure(error);
  }
}

export type DialogStale = "blocked" | "closed" | "changed" | null;

/**
 * Stale-menu guard for a dialog key press, pure over the captured screen: the
 * dialog that advanced or closed since the client rendered must swallow
 * nothing. A digit must still point at the same option label under the same
 * question; a bare Tab/Enter/Escape only checks the question when a menu is
 * still on screen.
 */
export function dialogKeyStale(screen: string, key: string, label: unknown, question: unknown): DialogStale {
  const blocking = detectBlockingGate(screen);
  if (blocking !== null) return "blocked";
  if (!screenWaitsForInput(screen)) return "closed";
  const menu = parseScreenMenu(screen);
  if (/^[1-9]$/.test(key)) {
    const option = menu?.options.find((item) => String(item.value) === key);
    if (
      !option ||
      (typeof label === "string" && label !== option.label) ||
      (typeof question === "string" && question !== menu?.question)
    ) {
      return "changed";
    }
  } else if (menu && typeof question === "string" && question !== menu.question) {
    return "changed";
  }
  return null;
}

/* A key press into a live dialog the scrape fallback surfaced: the digit of
   a menu option, or Tab/Enter/Escape for screens the parser cannot read.
   The pane is re-read right before sending — see dialogKeyStale. */
export async function answerDialogKey(filePath: string, key: string, label: unknown, question: unknown): Promise<DeliveryOutcome> {
  if (!filePath || !pathAllowed(filePath)) {
    return failure("the conversation path is required to answer", 400);
  }
  if (!/^([1-9]|Tab|Enter|Escape)$/.test(key)) {
    return failure("invalid key", 400);
  }
  const host = await livePaneHost(filePath);
  if (host === null) {
    return failure("no active agent pane", 409);
  }
  try {
    const stale = await withPaneLock(host.paneId, async () => {
      const verdict = dialogKeyStale(await paneScreen(host.paneId), key, label, question);
      if (verdict === null) await sendKeys(host.paneId, [key]);
      return verdict;
    });
    if (stale === "blocked") return failure("pane is waiting for a confirmation that requires a manual decision", 409);
    if (stale === "closed") return failure("pane is no longer waiting for a response", 409);
    if (stale === "changed") return failure("the on-screen menu has changed", 409);
    return { ok: true, target: host.display };
  } catch (error) {
    return failure(error);
  }
}

export async function resumeConversation(filePath: string): Promise<DeliveryOutcome> {
  if (!filePath || !pathAllowed(filePath)) {
    return failure("the conversation path is required to open", 400);
  }
  const entry = (await listFiles()).find((item) => item.path === filePath);
  if (!entry) return failure("file is unknown to the viewer", 403);
  const spec = resumeSpecFor(entry.root, entry.path, { model: entry.launchModel ?? entry.model, effort: entry.effort });
  if (!spec) return failure("this conversation cannot be resumed", 409);
  try {
    return await hostOutcome(deliverToTranscriptHost({ entry, spec, payload: "" }));
  } catch (error) {
    return failure(error);
  }
}

interface KillConversationOverrides {
  pathAllowed?: typeof pathAllowed;
  listFiles?: typeof listFiles;
  registrySnapshot?: () => ReturnType<ReturnType<typeof agentRegistry>["snapshot"]>;
  registry?: Pick<AgentRegistry, "snapshot" | "withOperationLock" | "markUnhosted">;
  killHost?: typeof killTmuxHostIfMatches;
}

function registeredHostForPath(
  snapshot: ReturnType<AgentRegistry["snapshot"]>,
  filePath: string,
): AgentRegistryEntry | null {
  return Object.values(snapshot.entries)
    .filter((candidate) => candidate.artifactPath === filePath && candidate.host !== null)
    .sort((left, right) => right.claimEpoch - left.claimEpoch || right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
}

function sameRegisteredHost(left: TmuxHostEvidence | null, right: TmuxHostEvidence): boolean {
  return Boolean(left
    && left.kind === right.kind
    && left.endpoint === right.endpoint
    && left.paneId === right.paneId
    && left.server.pid === right.server.pid
    && left.server.startIdentity === right.server.startIdentity
    && left.panePid.pid === right.panePid.pid
    && left.panePid.startIdentity === right.panePid.startIdentity
    && left.agent.pid === right.agent.pid
    && left.agent.startIdentity === right.agent.startIdentity
    && left.windowName === right.windowName
    && left.argv.length === right.argv.length
    && left.argv.every((argument, index) => argument === right.argv[index]));
}

/** Closes the registry-owned pane for one root conversation. The registry
    supplies the stable pane id and the complete process identity fence. */
export async function killConversation(filePath: string, overrides: KillConversationOverrides = {}): Promise<DeliveryOutcome> {
  if (!filePath || !(overrides.pathAllowed ?? pathAllowed)(filePath)) {
    return failure("the conversation path is required to close", 400);
  }
  const entry = (await (overrides.listFiles ?? listFiles)()).find((item) => item.path === filePath);
  /* A branch column shares the root conversation's pane: killing it from a
     branch close would take the whole agent down along with the root card
     that is still on screen. Only a root conversation may kill a pane. */
  if (entry && entry.parent) {
    return failure("a branch shares its root conversation pane and cannot be closed independently", 409);
  }
  const registry = overrides.registry ?? agentRegistry();
  const readSnapshot = overrides.registry
    ? () => registry.snapshot()
    : overrides.registrySnapshot ?? (() => registry.snapshot());
  const registered = registeredHostForPath(readSnapshot(), filePath);
  if (!registered?.host) return failure("no registered agent pane for this conversation", 404);
  const owner = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
  const runLocked = overrides.registry || !overrides.registrySnapshot
    ? <T>(task: () => Promise<T>) => registry.withOperationLock(registered.key, owner, task)
    : <T>(task: () => Promise<T>) => task();
  try {
    return await runLocked(async () => {
      const refreshed = registeredHostForPath(readSnapshot(), filePath);
      if (!refreshed?.host) return failure("no registered agent pane for this conversation", 404);
      const killed = await (overrides.killHost ?? killTmuxHostIfMatches)(refreshed.host);
      if (!killed) return failure("the registered pane changed or its process did not exit", 409);
      if (overrides.registry || !overrides.registrySnapshot) {
        const current = registry.snapshot().entries[`${refreshed.key.engine}:${refreshed.key.sessionId}`];
        if (current?.artifactPath === filePath && sameRegisteredHost(current.host, refreshed.host)) registry.markUnhosted(refreshed.key);
      }
      forgetResumePane(filePath);
      return { ok: true, target: refreshed.host.paneId };
    });
  } catch (error) {
    return failure(error);
  }
}

export interface ConversationMessage {
  pid: number | null;
  path: string;
  conversationId?: string | null;
  clientMessageId?: string | null;
  reservedDeliveryId?: string | null;
  text: string;
  images: InboxImagePayload[];
}

interface DeliveryOverrides {
  targetForKnownPid?: typeof targetForKnownPid;
  buildImagePayload?: typeof buildImagePayload;
  sendText?: typeof sendText;
}

/**
 * The send ladder: a known live pid delivers straight into its pane; a
 * conversation without one reopens through its resume spec; subagents and
 * other child records, which have no resumable session of their own, relay
 * through the root conversation — into its live pane when it runs, through a
 * resume window otherwise.
 */
export async function deliverConversationMessage(message: ConversationMessage, overrides: DeliveryOverrides = {}): Promise<DeliveryOutcome> {
  const { pid, images } = message;
  const text = message.text.trim();
  const requestLocalPayload = images.length > 0 || text.length > 32_000;

  const registry = agentRegistry();
  const conversation = message.conversationId?.startsWith("conversation_")
    ? registry.conversation(message.conversationId as `conversation_${string}`)
    : registry.conversationForPath(message.path);
  let filePath = conversation?.generations.at(-1)?.path ?? message.path;
  let deliveryId: string | null = null;
  let retryArtifactPaths: string[] = [];
  if (conversation && !message.reservedDeliveryId) {
    if (deliveryFence(conversation) === "held" && requestLocalPayload) return failure("request-local delivery waits for migration completion", 409);
    let queued;
    try {
      queued = registry.holdDelivery(
        conversation.id,
        text.length > 32_000 ? "" : text,
        message.clientMessageId ?? null,
        images.length ? "ephemeral-images" : text.length > 32_000 ? "ephemeral-text" : "text",
      );
    } catch (error) {
      return failure(error, 409);
    }
    if (queued.state === "delivered") return { ok: true, target: conversation.id };
    if (queued.state === "delivery-uncertain") {
      retryArtifactPaths = queued.artifactPaths;
      queued = registry.retryUncertainDelivery(queued.id);
    }
    if (queued.state === "held") {
      if (requestLocalPayload) {
        registry.discardDelivery(queued.id);
        return failure("request-local delivery waits for migration completion", 409);
      }
      requestAccountMigrationTick();
      return { ok: true, target: conversation.id, outcome: "held" };
    }
    if (queued.state !== "assigned" || !queued.generationId) {
      if (requestLocalPayload) registry.discardDelivery(queued.id);
      return failure("delivery target is unavailable", 409);
    }
    const claimed = registry.beginDeliveryAttempt(queued.id, queued.generationId);
    if (!claimed) {
      if (requestLocalPayload) {
        registry.discardDelivery(queued.id);
        return failure("request-local delivery waits for migration completion", 409);
      }
      registry.requeueHeldDelivery(queued.id);
      requestAccountMigrationTick();
      return { ok: true, target: conversation.id, outcome: "held" };
    }
    deliveryId = claimed.id;
    const claimedConversation = registry.conversation(conversation.id);
    filePath = claimedConversation?.generations.find((generation) => generation.id === claimed.generationId)?.path ?? filePath;
  }
  let actuation: "none" | "started" | "completed" = "none";
  const settle = (outcome: DeliveryOutcome): DeliveryOutcome => {
    try {
      if (deliveryId) {
        if (outcome.ok) registry.recordDeliveryOutcome(deliveryId, "delivered");
        else if (outcome.actuation !== "started") registry.discardDelivery(deliveryId);
      }
      return outcome;
    } catch (error) {
      return failure(error, 500, actuation === "none" ? undefined : "started");
    }
  };

  /* Saved paths stay visible to the catch-all: a delivery that fails after
     the images hit disk deletes them so a retry cannot duplicate files. */
  let imagePaths: string[] = [];
  const materializePayload = () => {
    if (retryArtifactPaths.length > 0) {
      return { payload: [text, ...retryArtifactPaths].filter(Boolean).join("\n"), imagePaths: retryArtifactPaths };
    }
    return (overrides.buildImagePayload ?? buildImagePayload)(text, images);
  };
  const recordArtifacts = () => {
    if (deliveryId && imagePaths.length > 0) registry.recordDeliveryArtifacts(deliveryId, imagePaths);
  };
  try {
    let target: string | null = null;
    if (!filePath && pid !== null) {
      const resolved = await (overrides.targetForKnownPid ?? targetForKnownPid)(pid);
      if (resolved === "unknown" && !filePath) return settle(failure("process is unknown to the viewer", 403));
      target = resolved === "unknown" ? null : resolved;
    }
    /* Images are only saved to the inbox once a deliverable destination is
       confirmed below — every early 409/403 return above and below happens
       before any file touches disk, so a rejected request never orphans one. */
    if (target !== null) {
      const bundle = materializePayload();
      imagePaths = bundle.imagePaths;
      recordArtifacts();
      await (overrides.sendText ?? sendText)(target, bundle.payload);
      actuation = "completed";
      return settle({ ok: true, target, ...(imagePaths.length ? { imagePaths } : {}) });
    }

    /* No live pane: reopen the conversation as a fresh agent window in the
       user's current tmux session and type the prompt there. */
    if (!filePath || !pathAllowed(filePath)) {
      return settle(failure("process is not in a tmux session", 409));
    }
    const all = await listFiles();
    const entry = all.find((item) => item.path === filePath);
    if (!entry) {
      return settle(failure("file is unknown to the viewer", 403));
    }
    const spec = resumeSpecFor(entry.root, entry.path, { model: entry.launchModel ?? entry.model, effort: entry.effort });
    if (spec) {
      const bundle = materializePayload();
      imagePaths = bundle.imagePaths;
      recordArtifacts();
      const outcome = await hostOutcome(deliverToTranscriptHost({ entry, spec, payload: bundle.payload }));
      if (!outcome.ok) { actuation = outcome.actuation === "started" ? "started" : "none"; return settle(cleanupFailedImageDelivery(outcome, imagePaths)); }
      actuation = "completed";
      return settle({ ...outcome, ...(imagePaths.length ? { imagePaths } : {}) });
    }

    const byPath = new Map(all.map((item) => [item.path, item]));
    const seen = new Set<string>();
    let root = entry;
    while (root.parent && byPath.has(root.parent) && !seen.has(root.path)) {
      seen.add(root.path);
      root = byPath.get(root.parent)!;
    }
    if (root.path === entry.path) {
      return settle(failure("this conversation cannot be resumed", 409));
    }
    /* Resolved before saving anything: the root's live pane or resume spec
       must exist, or the request is rejected without ever writing an image. */
    const rootSpec = resumeSpecFor(root.root, root.path, { model: root.launchModel ?? root.model, effort: root.effort });
    if (!rootSpec) {
      return settle(failure("root session is unavailable for messaging", 409));
    }
    const bundle = materializePayload();
    imagePaths = bundle.imagePaths;
    recordArtifacts();
    const relayText = `User message for your branch «${entry.title.slice(0, 100)}» — forward it or handle it yourself:\n${bundle.payload}`;
    const imageField = imagePaths.length ? { imagePaths } : {};
    const outcome = await hostOutcome(deliverToTranscriptHost({ entry: root, spec: rootSpec, payload: relayText }));
    if (!outcome.ok) { actuation = outcome.actuation === "started" ? "started" : "none"; return settle(cleanupFailedImageDelivery(outcome, imagePaths)); }
    actuation = "completed";
    return settle({ ...outcome, ...imageField });
  } catch (error) {
    const uncertain = actuation === "completed" || error instanceof TmuxDeliveryUncertainError;
    if (!uncertain) {
      if (deliveryId) try { registry.discardDelivery(deliveryId); } catch { /* the original registry failure remains actionable */ }
      deleteInboxImages(imagePaths);
    }
    return failure(error, 500, uncertain ? "started" : undefined);
  }
}
