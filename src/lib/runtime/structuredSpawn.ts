import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AccountContext } from "@/lib/accounts/contracts";
import { accountManager } from "@/lib/accounts/manager";
import { claudeSettingsPath } from "@/lib/accounts/claude";
import { claudeValidityFromLimitRead } from "@/lib/accounts/spawnHealth";
import type { LaunchProfile } from "@/lib/accounts/migration/contracts";
import type { SpawnAccountAdmission } from "@/lib/agent/accountLiveness";
import { effectiveClaudePermissionMode, type AgentEngine, type ResumeSpec } from "@/lib/agent/cli";
import { identityMaterializationFence, type AgentRegistry, type AgentRegistryEntry, type ProcessIdentity, type RegistryFile, type SpawnReceipt, type StructuredHostColumns } from "@/lib/agent/registry";
import { sessionKey, sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import type { SpawnResponse } from "@/lib/agent/spawnResponse";
import { prepareManagedClaudeSpawnHome } from "@/lib/agent/spawnPolicy";
import { claudeTranscriptPath } from "@/lib/agent/transcript";
import { statePath } from "@/lib/configDir";
import { rememberHandoffChild, persistHandoffLineage } from "@/lib/handoffLineage";
import { en } from "@/lib/i18n/en";
import { uk } from "@/lib/i18n/uk";
import { fetchClaudeLimits } from "@/lib/limits";
import { procBackend } from "@/lib/proc";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { signalProcessGroup } from "@/lib/processGroup";
import { hasUserAuthoredMessage } from "@/lib/session/reader";
import { buildImagePayload, deleteInboxImages, spawnAgentWithPrompt } from "@/lib/tmux";
import { hardenedRedact } from "@/lib/view/compactText";

import { ClaudeStreamBrokerHost } from "./claudeStreamBrokerHost";
import { CodexAppServerHost } from "./codexAppServerHost";
import { isRuntimeHostTransportFailure, type RuntimeHostClient } from "./client";
import { supervisedRuntimeHostUnavailableReason } from "./flags";
import { StructuredHostAdoptionCleanupError, StructuredSessionMaterializationError, type EngineHost, type HostState, type SessionMaterializationEvidence } from "./engineHost";
import { messageOriginRole, type MessageOrigin } from "./messageOrigin";
import { runtimeSettingsCapability, type RuntimeOperationResult, type RuntimeSession } from "./contracts";
import { bindClaudeHostPersistence, bindCodexHostPersistence } from "./registry";
import { publishStructuredDeliveryHost, releaseStructuredDeliveryHost, structuredDeliveryLastError } from "./structuredDeliveryController";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";
import { runtimeImageCapability, runtimeImageStore } from "./runtimeImageStore";
import { publishFilesRevision } from "./filesRevision";
import { parseStructuredImageRefs, structuredContent, type StructuredImageRef } from "./structuredContent";

export type SpawnedStructuredHost = EngineHost & {
  identity: { threadId: string; path: string | null } | { sessionId: string };
  onStateChange(listener: (state: HostState) => void): () => void;
  /** The canonical phrase of a terminal CLI exit, when the host recognized one
      (#1071). Absent on hosts whose engine reports no such diagnostic. */
  terminalExitReason?(): string | null;
};

export const INITIAL_MESSAGE_TIMEOUT_MS = 30_000;
const INITIAL_MESSAGE_POLL_MS = 250;
export const ADMISSION_RETRY_ATTEMPTS = 3;
const ADMISSION_RETRY_BACKOFF_MS = 250;
/**
 * Operational ownership bound for one synchronous setup generation. It gives
 * host start, binding, first delivery, and publication one five-minute caller
 * lifetime, then hands cleanup to durable reconciliation. Engine evidence can
 * establish a concrete failure earlier; this bound supplies no causal claim.
 */
export const STRUCTURED_SPAWN_DURABLE_SETUP_TIMEOUT_MS = 5 * 60_000;
export const READ_ONLY_STAGE_PERMISSION_PROFILE = "llv-read-only-stage";
const PINNED_SPAWN_HEALTH_TIMEOUT_MS = 600;

export function queuedPinnedSpawnTitle(locale: "en" | "uk", retryAt: string): string {
  const localized = locale === "uk" ? uk["spawnCard.pinUnavailableQueued"] : en["spawnCard.pinUnavailableQueued"];
  const template = typeof localized === "string" ? localized : en["spawnCard.pinUnavailableQueued"];
  return template.replace("{retryAt}", retryAt);
}

export async function resolvePinnedSpawnAdmission(
  engine: "claude" | "codex",
  account: AccountContext,
): Promise<SpawnAccountAdmission> {
  if (engine === "codex") {
    return { kind: "admissible", basis: "current", stale: false, retryAt: null };
  }
  return claudeValidityFromLimitRead(await fetchClaudeLimits(
    path.join(account.home, ".credentials.json"),
    Date.now,
    PINNED_SPAWN_HEALTH_TIMEOUT_MS,
  ));
}

export interface StructuredHostAccessMaterialization {
  env: NodeJS.ProcessEnv;
  codex: {
    sandbox?: string;
    permissionProfile?: string;
    permissionProfileConfig?: string;
  };
  host: {
    forwardGitHubConfig?: boolean;
    releaseCleanup?: () => void;
  };
  scratchDirectory: string | null;
  cleanup(): void;
}

function githubConfigDirectory(sourceEnv: NodeJS.ProcessEnv): string {
  if (sourceEnv.GH_CONFIG_DIR) return sourceEnv.GH_CONFIG_DIR;
  const home = sourceEnv.HOME || os.homedir();
  return path.join(sourceEnv.XDG_CONFIG_HOME || path.join(home, ".config"), "gh");
}

/** A read-only stage keeps the checkout under Codex's read-only profile while
    adding one private write root for temporary and test state. */
export function materializeStructuredHostAccess(
  readOnly: boolean,
  sourceEnv: NodeJS.ProcessEnv,
  capability: string | null,
  scratchParent?: string,
): StructuredHostAccessMaterialization {
  const baseEnv = {
    ...sourceEnv,
    ...(capability ? { LLV_SPAWN_CAPABILITY: capability } : {}),
  };
  if (!readOnly) {
    return {
      env: baseEnv,
      codex: { sandbox: "danger-full-access" },
      host: {},
      scratchDirectory: null,
      cleanup: () => {},
    };
  }

  const resolvedScratchParent = scratchParent ?? statePath("scratch");
  fs.mkdirSync(resolvedScratchParent, { recursive: true, mode: 0o700 });
  const scratchDirectory = fs.mkdtempSync(path.join(resolvedScratchParent, "llv-read-only-stage-"));
  try {
    fs.chmodSync(scratchDirectory, 0o700);
    const temporaryDirectory = path.join(scratchDirectory, "tmp");
    fs.mkdirSync(temporaryDirectory, { mode: 0o700 });
    const permissionProfileConfig = `permissions.${READ_ONLY_STAGE_PERMISSION_PROFILE}={extends=":read-only",filesystem={${JSON.stringify(scratchDirectory)}="write"}}`;
    const cleanup = () => fs.rmSync(scratchDirectory, { recursive: true, force: true });
    return {
      env: {
        ...baseEnv,
        TMPDIR: temporaryDirectory,
        GH_CONFIG_DIR: githubConfigDirectory(sourceEnv),
      },
      codex: {
        permissionProfile: READ_ONLY_STAGE_PERMISSION_PROFILE,
        permissionProfileConfig,
      },
      host: {
        forwardGitHubConfig: true,
        releaseCleanup: cleanup,
      },
      scratchDirectory,
      cleanup,
    };
  } catch (error) {
    fs.rmSync(scratchDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** Runtime admission calls carry the durable launch id as their idempotency
    key, so a replay lands on the original receipt. Production #367 saw
    simultaneous launches turn transient socket timeouts into terminal failed
    receipts; transport-level failures are retried before giving up. */
export async function withRuntimeAdmissionRetry<T>(
  request: () => Promise<T>,
  options: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = options.attempts ?? ADMISSION_RETRY_ATTEMPTS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (!isRuntimeHostTransportFailure(error)) throw error;
      lastError = error;
      if (attempt < attempts) await sleep(ADMISSION_RETRY_BACKOFF_MS * attempt);
    }
  }
  throw lastError;
}
const INITIAL_MESSAGE_DELIVERED = new Set(["delivered", "turn-started", "steered"]);
const INITIAL_MESSAGE_FAILED = new Set(["failed", "rejected", "uncertain", "interrupted"]);

export class StructuredInitialMessageTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuredInitialMessageTimeoutError";
  }
}

export class StructuredTranscriptMaterializationError extends Error {
  constructor(timeoutMs: number) {
    super(`structured spawn startup reached its ${timeoutMs}ms durable setup bound without a readable transcript`);
    this.name = "StructuredTranscriptMaterializationError";
  }
}

function structuredTranscriptIsReadable(artifactPath: string): boolean {
  let descriptor: number | null = null;
  try {
    const stat = fs.statSync(artifactPath);
    if (!stat.isFile() || stat.size === 0) return false;
    descriptor = fs.openSync(artifactPath, "r");
    const maxValidationBytes = 8 * 1024 * 1024;
    const length = Math.min(stat.size, maxValidationBytes);
    const buffer = Buffer.allocUnsafe(length);
    if (fs.readSync(descriptor, buffer, 0, length, 0) !== length) return false;
    const text = buffer.toString("utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as unknown;
        if (record && typeof record === "object" && !Array.isArray(record)) return true;
      } catch {
        // The writer may still be appending its first record; the next poll retries it.
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

async function waitForStructuredSessionMaterialization(
  host: SpawnedStructuredHost,
  artifactPath: string,
  clientMessageId: string,
  options: {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    timeoutMs: number;
  },
): Promise<void> {
  const deadline = options.now() + options.timeoutMs;
  let lastEvidence: SessionMaterializationEvidence | null = null;
  for (;;) {
    const evidence = host.sessionMaterializationEvidence
      ? await host.sessionMaterializationEvidence(clientMessageId)
      : { state: "materialized" as const };
    if (evidence.state === "failed") throw new StructuredSessionMaterializationError(evidence.reason);
    lastEvidence = evidence;
    if (evidence.state === "materialized" && structuredTranscriptIsReadable(artifactPath)) return;
    if (evidence.state === "unavailable" && structuredTranscriptIsReadable(artifactPath)) return;
    const remaining = deadline - options.now();
    if (remaining <= 0) {
      if (lastEvidence.state === "absent") {
        throw new StructuredSessionMaterializationError(
          `${lastEvidence.reason}; startup reached its ${options.timeoutMs}ms durable setup bound`,
        );
      }
      if (lastEvidence.state === "unavailable") {
        throw new StructuredSessionMaterializationError(
          `structured spawn startup reached its ${options.timeoutMs}ms durable setup bound while session evidence was unavailable: ${lastEvidence.reason}`,
        );
      }
      throw new StructuredTranscriptMaterializationError(options.timeoutMs);
    }
    await options.sleep(Math.min(INITIAL_MESSAGE_POLL_MS, remaining));
  }
}

const STALE_SPAWN_PROCESS_REAP_ATTEMPTS = 20;
const STALE_SPAWN_PROCESS_REAP_POLL_MS = 25;

/** Reaps the detached engine group only while PID and start identity still
    match the staged host. A missing or recycled target already counts as gone;
    an unverifiable identity stays untouched. */
async function terminateVerifiedStructuredSpawnProcess(expected: ProcessIdentity): Promise<boolean> {
  if (expected.pid === process.pid || expected.startIdentity === null) return false;
  const matches = () => procBackend.processIdentity(expected.pid) === expected.startIdentity;
  if (!matches()) return true;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!signalProcessGroup(expected.pid, signal)) {
      try { process.kill(expected.pid, signal); }
      catch { return !matches(); }
    }
    for (let attempt = 0; attempt < STALE_SPAWN_PROCESS_REAP_ATTEMPTS; attempt += 1) {
      if (!matches()) return true;
      if (attempt + 1 < STALE_SPAWN_PROCESS_REAP_ATTEMPTS) {
        await new Promise<void>((resolve) => setTimeout(resolve, STALE_SPAWN_PROCESS_REAP_POLL_MS));
      }
    }
  }
  return !matches();
}

function structuredSpawnFailureReason(error: unknown): string {
  if (isRuntimeHostTransportFailure(error)) {
    return supervisedRuntimeHostUnavailableReason("structured spawn runtime host");
  }
  const message = error instanceof Error ? error.message : "structured spawn failed";
  return hardenedRedact(message).replace(/\s+/g, " ").trim().slice(0, 240) || "structured spawn failed";
}

function runtimeEntryStatus(session: RuntimeSession): "dead" | "live" | "idle" {
  if (session.host === "dead" || session.host === "unhosted") return "dead";
  if (session.turn === "running") return "live";
  return "idle";
}

function failedOperationReason(operation: RuntimeOperationResult | null, subject: string): string | null {
  const status = operation?.receipt.status;
  if (!status || !INITIAL_MESSAGE_FAILED.has(status)) return null;
  return operation.receipt.reason ?? `${subject} ended as ${status}`;
}

function reconciledInitialMessage(
  receipt: SpawnReceipt,
  status: string | undefined,
  runtimeDelivered: boolean,
): "pending" | "queued" | "delivered" | "failed" {
  if (receipt.state === "failed" || (status !== undefined && INITIAL_MESSAGE_FAILED.has(status))) return "failed";
  if (runtimeDelivered || receipt.state === "completed") return "delivered";
  if (status === "queued" || status === "pending" || status === "delivering") return "queued";
  return "pending";
}

function settleInitialMessageReservation(registry: AgentRegistry, launchId: string): void {
  const clientMessageId = `spawn_${launchId}`;
  const reservation = Object.values(registry.readOnlySnapshot().heldDeliveries)
    .find((delivery) => delivery.clientMessageId === clientMessageId);
  if (reservation && reservation.state !== "delivered") {
    registry.recordDeliveryOutcome(reservation.id, "delivered");
  }
}

function markInitialMessageTimeout(registry: AgentRegistry, launchId: string, error: StructuredInitialMessageTimeoutError): void {
  const reservation = Object.values(registry.readOnlySnapshot().heldDeliveries)
    .find((delivery) => delivery.clientMessageId === `spawn_${launchId}`);
  if (reservation && reservation.state !== "delivered") {
    registry.recordDeliveryOutcome(reservation.id, "delivery-uncertain", error.message);
  }
}

export async function waitForStructuredInitialMessage(
  client: RuntimeHostClient,
  operationId: string,
  options: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? INITIAL_MESSAGE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? INITIAL_MESSAGE_POLL_MS;
  const deadline = now() + timeoutMs;
  let lastStatus: string | undefined;
  let lastReadError: string | null = null;
  for (;;) {
    let operation: Awaited<ReturnType<RuntimeHostClient["operationStatus"]>> = null;
    try {
      operation = await client.operationStatus(operationId, { currentRetryLeaf: true });
      lastStatus = operation?.receipt.status ?? lastStatus;
      lastReadError = null;
    } catch (error) {
      lastReadError = error instanceof Error ? error.message : "runtime status read failed";
    }
    const status = operation?.receipt.status ?? lastStatus;
    if (status && INITIAL_MESSAGE_DELIVERED.has(status)) return;
    if (status && INITIAL_MESSAGE_FAILED.has(status)) {
      throw new Error(operation?.receipt.reason ?? `structured initial message ended as ${status}`);
    }
    if (now() >= deadline) {
      if (lastReadError) {
        throw new StructuredInitialMessageTimeoutError(`structured initial message status remained unavailable for ${timeoutMs}ms: ${lastReadError}`);
      }
      throw new StructuredInitialMessageTimeoutError(`structured initial message remained ${status ?? "pending"} for ${timeoutMs}ms`);
    }
    await sleep(Math.min(pollMs, deadline - now()));
  }
}

async function structuredSpawnEffectForLaunch(
  client: RuntimeHostClient,
  launchId: string,
): Promise<Record<string, unknown> | null> {
  let afterEventSeq = 0;
  while (true) {
    const batch = await client.effectBatch(["runtime.spawn"], afterEventSeq);
    for (const effect of batch) {
      if (effect.payload.operationId === launchId) return effect.payload;
    }
    if (batch.length < 100) return null;
    const next = Math.max(...batch.map((effect) => effect.eventSeq));
    if (!Number.isSafeInteger(next) || next <= afterEventSeq) {
      throw new Error("structured spawn replay effect page did not advance");
    }
    afterEventSeq = next;
  }
}

export async function reconcileStructuredSpawnReplay(
  launchId: string,
  registry: AgentRegistry,
  client: RuntimeHostClient,
  options: {
    now?: () => number;
    timeoutMs?: number;
    releaseHost?: (key: SessionKey) => Promise<boolean>;
    terminateHostProcess?: (expected: ProcessIdentity) => Promise<boolean>;
    drainError?: (conversationId: string) => string | null;
  } = {},
): Promise<SpawnReceipt & { initialMessage: "pending" | "queued" | "delivered" | "failed" }> {
  const current = registry.readOnlySnapshot().receipts[launchId];
  if (!current) throw new Error("unknown spawn receipt");
  if (current.state === "completed") {
    return { ...current, initialMessage: "delivered" };
  }
  if (current.state === "conflicted") {
    return { ...current, initialMessage: "failed" };
  }
  const [initialOperation, spawnOperation, runtime] = await Promise.all([
    client.operationStatus(`spawn_message_${launchId}`, { currentRetryLeaf: true }).catch(() => null),
    client.operationStatus(launchId, { currentRetryLeaf: true }).catch(() => null),
    client.snapshot().catch(() => null),
  ]);
  let operation = initialOperation;
  let effectHistoryUnavailable = false;
  if (!operation && current.state === "path-pending" && current.artifactPath) {
    /* Effect history can be unavailable during the same runtime-journal outage
       this replay is meant to bound. Missing evidence remains unconfirmed so
       the normal deadline path can settle the placeholder retry-safely. */
    const effect = await structuredSpawnEffectForLaunch(client, launchId).catch(() => {
      effectHistoryUnavailable = true;
      return null;
    });
    const prompt = typeof effect?.prompt === "string" ? effect.prompt : null;
    const imageRefs = parseStructuredImageRefs(effect?.images ?? [], 16);
    if (
      prompt !== null
      && imageRefs !== null
      && effect?.conversationId === current.conversationId
      && effect.cwd === current.cwd
      && (prompt.trim() || imageRefs.length)
    ) {
      const readmittedOrigin = spawnMessageOrigin(current, registry);
      const readmitted = await enqueueStructuredMessage({
        path: current.artifactPath,
        conversationId: current.conversationId,
        clientMessageId: `spawn_${launchId}`,
        operationId: `spawn_message_${launchId}`,
        text: prompt,
        imageRefs,
        ...(readmittedOrigin ? { origin: readmittedOrigin } : {}),
      }, {
        client: () => client,
        registry: () => registry,
        enabled: () => true,
      });
      if (readmitted?.ok && readmitted.outcome !== "held") {
        operation = await client.operationStatus(`spawn_message_${launchId}`, { currentRetryLeaf: true }).catch(() => null);
      }
    }
  }
  const runtimeDelivered = Boolean(operation
    && operation.receipt.conversationId === current.conversationId
    && INITIAL_MESSAGE_DELIVERED.has(operation.receipt.status));
  const sessionMatches = runtime?.sessions.find((candidate) =>
    candidate.conversationId === current.conversationId
    && candidate.sessionKey.engine === current.engine
    && candidate.cwd === current.cwd
    && typeof candidate.artifactPath === "string"
    && (!current.key || sessionKeyId(candidate.sessionKey) === sessionKeyId(current.key))
    && (!current.artifactPath || candidate.artifactPath === current.artifactPath)) ?? null;
  const evidencePath = current.artifactPath ?? sessionMatches?.artifactPath ?? null;
  const transcriptMaterialized = Boolean(evidencePath
    && structuredTranscriptIsReadable(evidencePath));
  const transcriptDelivered = Boolean(evidencePath
    && hasUserAuthoredMessage(evidencePath, current.engine));
  /* A runtime delivery receipt establishes host acceptance. Session identity
     publication waits for transcript-backed persistence evidence. */
  if (transcriptDelivered || (runtimeDelivered && transcriptMaterialized)) {
    const evidence = sessionMatches ? {
      key: sessionMatches.sessionKey,
      artifactPath: sessionMatches.artifactPath!,
      cwd: current.cwd,
      accountId: current.accountId,
      launchProfile: current.launchProfile,
      status: runtimeEntryStatus(sessionMatches),
      host: null,
      structuredHost: sessionMatches.hostKind === "codex-app-server" || sessionMatches.hostKind === "claude-broker"
        ? {
          kind: sessionMatches.hostKind,
          endpoint: "runtime:reconciled",
          process: null,
          eventCursor: sessionMatches.revision,
          protocolVersion: null,
          writerClaimEpoch: 0,
          activeTurnRef: sessionMatches.activeTurnId,
          pendingAttention: sessionMatches.attentionIds,
          activeFlags: [],
        }
        : null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    } : undefined;
    const recovered = registry.recoverStructuredSpawnFromEvidence(launchId, evidence);
    if (recovered.kind === "settled") {
      return { ...recovered.receipt, initialMessage: "delivered" };
    }
  }
  const messageStatus = operation?.receipt.status;
  const runtimeSession = runtime?.sessions.find((candidate) => candidate.conversationId === current.conversationId
    && candidate.cwd === current.cwd
    && (!current.key || sessionKeyId(candidate.sessionKey) === sessionKeyId(current.key))) ?? null;
  const liveRuntimeSession = runtimeSession
    && (runtimeSession.host === "registering"
      || runtimeSession.host === "hosted"
      || runtimeSession.host === "recovering")
    ? runtimeSession
    : null;
  const operationStartedAt = operation ? Date.parse(operation.receipt.at) : Number.NaN;
  const stageStartedAt = Number.isFinite(operationStartedAt) ? operationStartedAt : Date.parse(current.createdAt);
  const ageMs = (options.now ?? Date.now)() - stageStartedAt;
  /* The five-minute ceiling is the spawn caller's durable setup contract. It
     covers host start, first-message delivery, and transcript publication as
     one bounded operation; the 30-second delivery-status poll is not reused as
     a session-creation verdict. */
  const timeoutMs = options.timeoutMs ?? STRUCTURED_SPAWN_DURABLE_SETUP_TIMEOUT_MS;
  let terminalReason = failedOperationReason(operation, "structured initial message")
    ?? failedOperationReason(spawnOperation, "structured spawn");
  if (!terminalReason && ageMs >= timeoutMs) {
    if (liveRuntimeSession && messageStatus === "queued") {
      const drainError = (options.drainError ?? structuredDeliveryLastError)(current.conversationId)
        ?? operation?.receipt.reason
        ?? `no delivery drain error was recorded before the ${timeoutMs}ms deadline`;
      terminalReason = `first message never drained: ${drainError}`;
    } else if (runtimeDelivered) {
      terminalReason = `structured spawn startup reached its ${timeoutMs}ms durable setup bound with no readable transcript after confirmed first-message delivery`;
    } else if (liveRuntimeSession) {
      terminalReason = `structured spawn durable setup remained incomplete for ${timeoutMs}ms`;
    } else if (effectHistoryUnavailable) {
      terminalReason = `structured spawn runtime effect history remained unavailable for ${timeoutMs}ms`;
    } else if (runtime) {
      terminalReason = `structured spawn runtime snapshot has no session after ${timeoutMs}ms`;
    } else {
      terminalReason = `structured spawn durable setup remained unconfirmed for ${timeoutMs}ms`;
    }
  }
  if (terminalReason) {
    terminalReason = terminalReason.slice(0, 240);
    /* Claim the terminal receipt before any asynchronous cleanup. A concurrent
       completion or same-key successor then wins atomically and prevents this
       stale replay from releasing its host. */
    const failure = registry.failStructuredSpawn(launchId, terminalReason);
    if (!failure.claimed) {
      const settled = failure.receipt ?? registry.readOnlySnapshot().receipts[launchId] ?? current;
      return {
        ...settled,
        initialMessage: settled.state === "completed" ? "delivered" : "failed",
      };
    }
    const spawnStatus = spawnOperation?.receipt.status;
    if (spawnStatus === "pending" || spawnStatus === "queued" || spawnStatus === "delivering") {
      try {
        await client.transitionOperation(launchId, "failed", { reason: terminalReason });
      } catch (error) {
        console.error("[spawn] runtime operation failure did not settle during reconciliation", {
          launchId,
          error: structuredSpawnFailureReason(error),
        });
      }
    }
    const cleanup = failure.cleanup;
    if (cleanup) {
      let released = false;
      const entryBeforeRelease = registry.readOnlySnapshot().entries[sessionKeyId(cleanup.key)];
      if (cleanup.releaseRegisteredHost && entryBeforeRelease?.structuredHostOperationId === launchId) {
        try {
          released = await (options.releaseHost ?? releaseStructuredDeliveryHost)(cleanup.key);
        } catch (error) {
          console.error("[spawn] registered host release failed during reconciliation", {
            launchId,
            error: structuredSpawnFailureReason(error),
          });
        }
      }
      if (!released && cleanup.process) {
        const entryBeforeTermination = registry.readOnlySnapshot().entries[sessionKeyId(cleanup.key)];
        const stillOwned = cleanup.releaseRegisteredHost
          ? entryBeforeTermination?.structuredHostOperationId === launchId
          : entryBeforeTermination?.structuredHostOperationId == null
            && entryBeforeTermination.artifactPath === failure.receipt?.artifactPath
            && entryBeforeTermination.status === "dead"
            && entryBeforeTermination.claimOwner === null;
        if (stillOwned) {
          try {
            const terminated = await (options.terminateHostProcess ?? terminateVerifiedStructuredSpawnProcess)(cleanup.process);
            if (!terminated && cleanup.process.pid !== process.pid) {
              console.error("[spawn] staged host termination remained unconfirmed", {
                launchId,
                pid: cleanup.process.pid,
              });
            }
          } catch (error) {
            console.error("[spawn] staged host termination failed during reconciliation", {
              launchId,
              error: structuredSpawnFailureReason(error),
            });
          }
        }
      }
    }
    const failed = registry.readOnlySnapshot().receipts[launchId] ?? current;
    return { ...failed, initialMessage: "failed" };
  }
  const receipt = registry.readOnlySnapshot().receipts[launchId] ?? current;
  return {
    ...receipt,
    initialMessage: reconciledInitialMessage(receipt, messageStatus, runtimeDelivered),
  };
}

/* Foreground setup and the reaper share one five-minute ceiling. Transcript
   publication belongs to that complete startup contract; the shorter
   first-message status poll has no authority over session materialization. */
export const STALE_STRUCTURED_SPAWN_TIMEOUT_MS = STRUCTURED_SPAWN_DURABLE_SETUP_TIMEOUT_MS;
export const STALE_STRUCTURED_SPAWN_ACTUATION_CAP = 50;

function queuedPinnedSpawnForReceipt(receipt: SpawnReceipt): NonNullable<SpawnReceipt["queuedPinnedSpawn"]> | null {
  const queued = receipt.queuedPinnedSpawn;
  const recoverableTransportState = receipt.transport === "structured"
    ? receipt.state === "starting" && !receipt.key && !receipt.pane
    : receipt.transport === "tmux"
      && !receipt.key
      && ((receipt.state === "starting" && !receipt.pane)
        || ((receipt.state === "pane-bound" || receipt.state === "host-verified") && Boolean(receipt.pane)));
  return recoverableTransportState
    && receipt.purpose === "launch"
    && receipt.accountPin
    && Boolean(receipt.accountId)
    && queued?.accountId === receipt.accountId
    && queued.spec.engine === receipt.engine
    && queued.spec.cwd === receipt.cwd
    ? queued
    : null;
}

export interface StructuredSpawnRecoveryOptions {
  now?: () => number;
  timeoutMs?: number;
  actuationCap?: number;
  resolveSpawnAccount?: (engine: "claude" | "codex", accountId: string | null) => AccountContext;
  resolvePinnedSpawnAdmission?: (engine: "claude" | "codex", account: AccountContext) => Promise<SpawnAccountAdmission>;
  spawnStructuredConversation?: typeof spawnStructuredConversation;
  spawnTmuxAgent?: typeof spawnAgentWithPrompt;
  publishFilesRevision?: typeof publishFilesRevision;
}

function failQueuedPinnedSpawn(
  registry: AgentRegistry,
  receipt: SpawnReceipt,
  reason: string,
): SpawnReceipt {
  if (receipt.transport === "structured") {
    return registry.failStructuredSpawn(receipt.launchId, reason).receipt ?? receipt;
  }
  registry.failSpawn(receipt.launchId, reason);
  return registry.readOnlySnapshot().receipts[receipt.launchId] ?? receipt;
}

async function actuateQueuedPinnedSpawn(
  registry: AgentRegistry,
  client: RuntimeHostClient | null,
  receipt: SpawnReceipt,
  options: StructuredSpawnRecoveryOptions,
): Promise<SpawnReceipt> {
  const queued = queuedPinnedSpawnForReceipt(receipt);
  const currentTime = (options.now ?? Date.now)();
  if (!queued || Date.parse(queued.retryAt) > currentTime) return receipt;
  const admissionClaim = receipt.transport === "tmux"
    ? registry.claimTmuxSpawnActuation(receipt.launchId)
    : registry.claimStartingStructuredSpawn(receipt.launchId);
  if (!admissionClaim.claimed || !admissionClaim.receipt.admissionOwner) return admissionClaim.receipt;
  const claimedQueue = queuedPinnedSpawnForReceipt(admissionClaim.receipt);
  if (!claimedQueue) {
    return failQueuedPinnedSpawn(registry, admissionClaim.receipt, "queued pinned spawn lost its durable admission payload");
  }
  let account: AccountContext;
  let admission: SpawnAccountAdmission;
  try {
    account = (options.resolveSpawnAccount
      ?? ((engine, accountId) => accountManager.resolveSpawn(engine, accountId)))(receipt.engine, claimedQueue.accountId);
    if (account.engine !== receipt.engine || account.accountId !== claimedQueue.accountId) {
      throw new Error("queued pinned spawn resolved a different account");
    }
    admission = receipt.transport === "tmux" && Boolean(admissionClaim.receipt.pane)
      ? { kind: "admissible", basis: "current", stale: false, retryAt: null }
      : await (options.resolvePinnedSpawnAdmission ?? resolvePinnedSpawnAdmission)(receipt.engine, account);
  } catch (error) {
    return failQueuedPinnedSpawn(registry, admissionClaim.receipt, structuredSpawnFailureReason(error));
  }
  if (admission.kind === "retry-at") {
    const nextRetryMs = Date.parse(admission.retryAt);
    if (!Number.isFinite(nextRetryMs) || nextRetryMs <= currentTime) {
      return failQueuedPinnedSpawn(registry, admissionClaim.receipt, "pinned account retry deadline did not advance");
    }
    const nextRetryAt = new Date(nextRetryMs).toISOString();
    const refreshed = registry.queuePinnedSpawn(receipt.launchId, {
      ...claimedQueue,
      retryAt: nextRetryAt,
    }, queuedPinnedSpawnTitle(claimedQueue.locale, nextRetryAt));
    return refreshed.admissionOwner
      ? registry.releaseSpawnActuation(refreshed.launchId, refreshed.admissionOwner).receipt
      : refreshed;
  }
  if (admission.kind === "unavailable") {
    return failQueuedPinnedSpawn(
      registry,
      admissionClaim.receipt,
      `pinned account is unavailable: ${admission.reason}`,
    );
  }
  let response: SpawnResponse | null = null;
  let tmuxImagePaths: string[] = [];
  try {
    if (receipt.transport === "tmux") {
      const images = claimedQueue.imageRefs.length
        ? (() => {
            const imageStore = runtimeImageStore();
            return claimedQueue.imageRefs.map((ref) => ({
              base64: imageStore.read(ref).toString("base64"),
              mime: ref.mime,
            }));
          })()
        : [];
      const bundle = buildImagePayload(claimedQueue.prompt, images);
      tmuxImagePaths = bundle.imagePaths;
      await (options.spawnTmuxAgent ?? spawnAgentWithPrompt)(
        claimedQueue.spec,
        bundle.payload,
        admissionClaim.receipt,
      );
      const launched = registry.readOnlySnapshot().receipts[receipt.launchId];
      if (launched?.state === "prompt-delivered" || launched?.state === "host-verified") {
        registry.markSpawnPathPending(receipt.launchId);
      }
    } else {
      if (!client) {
        throw new Error(supervisedRuntimeHostUnavailableReason("structured spawn runtime host"));
      }
      response = await (options.spawnStructuredConversation ?? spawnStructuredConversation)({
        engine: receipt.engine,
        receipt: admissionClaim.receipt,
        spec: claimedQueue.spec,
        account,
        ["prompt"]: claimedQueue.prompt,
        imageRefs: claimedQueue.imageRefs,
        registry,
        client,
      });
    }
  } catch (error) {
    if (receipt.transport === "tmux") {
      registry.failSpawn(receipt.launchId, structuredSpawnFailureReason(error));
      const failed = registry.readOnlySnapshot().receipts[receipt.launchId] ?? admissionClaim.receipt;
      if (!failed.pane) deleteInboxImages(tmuxImagePaths);
      if (failed.queuedPinnedSpawn && failed.admissionOwner) {
        return registry.releaseSpawnActuation(failed.launchId, failed.admissionOwner).receipt;
      }
      return failed;
    }
    const current = registry.readOnlySnapshot().receipts[receipt.launchId];
    if (current?.queuedPinnedSpawn && current.admissionOwner) {
      registry.releaseSpawnActuation(current.launchId, current.admissionOwner);
    }
    throw error;
  }
  if (claimedQueue.parentArtifactPath && response?.path) {
    try {
      rememberHandoffChild(response.path, claimedQueue.parentArtifactPath);
      persistHandoffLineage();
    } catch (error) {
      console.error("[spawn] queued handoff lineage persistence failed", {
        launchId: receipt.launchId,
        conversationId: receipt.conversationId,
        error,
      });
    }
  }
  if (response?.path && client && fs.existsSync(response.path)) {
    try {
      await (options.publishFilesRevision ?? publishFilesRevision)(client);
    } catch (error) {
      console.error("[spawn] queued transcript materialization refresh failed", {
        launchId: receipt.launchId,
        conversationId: receipt.conversationId,
        error,
      });
    }
  }
  return registry.readOnlySnapshot().receipts[receipt.launchId] ?? admissionClaim.receipt;
}

/** Bounded, idempotent convergence for stale non-terminal structured launches
    (#334/#1031): every launch older than the setup bound enters the replay
    reconciler, including rows with a live admission owner, a registering host,
    or a transcript that materialized late. Strong delivery evidence recovers
    the receipt; every other overdue launch settles as retry-safe failure and
    releases its registered host or reaps its verified staged process. Running
    the pass twice is a no-op because terminal receipts are skipped. Held
    deliveries and receipts remain durable.

    The same existing reaper tick actuates a valid queued pin once its durable
    deadline arrives. A future queue stays WAITING, while an incomplete queue
    follows the ordinary setup bound and cannot become immortal. */
export async function terminalizeStaleStructuredSpawns(
  registry: AgentRegistry,
  client: RuntimeHostClient | null,
  options: StructuredSpawnRecoveryOptions & {
    reconcile?: typeof reconcileStructuredSpawnReplay;
  } = {},
): Promise<{ examined: number; terminalized: string[]; recovered: string[] }> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? STALE_STRUCTURED_SPAWN_TIMEOUT_MS;
  const actuationCap = options.actuationCap ?? STALE_STRUCTURED_SPAWN_ACTUATION_CAP;
  const reconcile = options.reconcile ?? reconcileStructuredSpawnReplay;
  const snapshot = registry.readOnlySnapshot();
  const terminalized: string[] = [];
  const recovered: string[] = [];
  let examined = 0;
  for (const receipt of Object.values(snapshot.receipts)) {
    if (examined >= actuationCap) break;
    if (receipt.state === "completed" || receipt.state === "failed" || receipt.state === "conflicted") continue;
    const queued = queuedPinnedSpawnForReceipt(receipt);
    if (queued) {
      if (Date.parse(queued.retryAt) > now()) continue;
      if (receipt.transport === "structured" && !client) continue;
      examined += 1;
      try {
        const supersededReason = supersededQueuedSpawnReason(snapshot, receipt);
        const recoveredReceipt = supersededReason
          ? failQueuedPinnedSpawn(registry, receipt, supersededReason)
          : await actuateQueuedPinnedSpawn(registry, client, receipt, options);
        if (recoveredReceipt.state === "failed" || recoveredReceipt.state === "conflicted") terminalized.push(receipt.launchId);
        else if (recoveredReceipt.state === "completed") recovered.push(receipt.launchId);
      } catch (error) {
        console.error("[reaper] queued pinned spawn recovery failed", {
          launchId: receipt.launchId,
          error,
        });
      }
      continue;
    }
    const createdMs = Date.parse(receipt.createdAt);
    if (!Number.isFinite(createdMs) || now() - createdMs < timeoutMs) continue;
    if (receipt.transport === "tmux") {
      const ownerlessPreSettlement = receipt.state === "starting"
        && !receipt.key
        && !receipt.pane
        && !receipt.admissionOwner;
      if (!ownerlessPreSettlement) continue;
      examined += 1;
      try {
        registry.failSpawn(
          receipt.launchId,
          `tmux spawn interrupted before durable queue publication or pane binding: ${receipt.launchId}`,
        );
        const failed = registry.readOnlySnapshot().receipts[receipt.launchId];
        if (failed?.state === "failed" || failed?.state === "conflicted") terminalized.push(receipt.launchId);
      } catch (error) {
        console.error("[reaper] stale tmux spawn reconciliation failed", {
          launchId: receipt.launchId,
          error,
        });
      }
      continue;
    }
    if (receipt.transport !== "structured") continue;
    if (!client) continue;
    examined += 1;
    try {
      const reconciled = await reconcile(receipt.launchId, registry, client, { now, timeoutMs });
      if (reconciled.state === "failed") terminalized.push(receipt.launchId);
      else if (reconciled.state === "completed") recovered.push(receipt.launchId);
    } catch (error) {
      console.error("[reaper] stale structured spawn reconciliation failed", {
        launchId: receipt.launchId,
        error,
      });
    }
  }
  return { examined, terminalized, recovered };
}

export interface StructuredSpawnInput {
  engine: AgentEngine;
  receipt: SpawnReceipt;
  spec: ResumeSpec;
  account: AccountContext;
  "prompt": string;
  imageRefs?: StructuredImageRef[];
  registry: AgentRegistry;
  client: RuntimeHostClient;
}

interface HostBinding {
  stopPersistence(): void;
  unregister(): Promise<void>;
}

const FAILED_SPAWN_OPERATION_STATUSES = new Set([
  "failed",
  "rejected",
  "uncertain",
  "turn-started",
  "steered",
  "interrupted",
  "answered",
]);

async function projectDeadStructuredSpawn(
  client: RuntimeHostClient,
  receipt: SpawnReceipt,
  entry: { accountId: string | null; cwd: string },
  eventKey: string,
  identity?: { key: SessionKey; artifactPath: string },
): Promise<void> {
  const key = identity?.key ?? receipt.key;
  const artifactPath = identity?.artifactPath ?? receipt.artifactPath;
  if (!key || !artifactPath) return;
  await client.append({
    scope: { type: "session", id: receipt.conversationId },
    kind: "session-status",
    producer: {
      kind: key.engine === "codex" ? "codex-app-server" : "claude-broker",
      eventKey,
    },
    payload: {
      conversationId: receipt.conversationId,
      sessionKey: key,
      hostKind: key.engine === "codex" ? "codex-app-server" : "claude-broker",
      host: "dead",
      turn: "idle",
      provenance: "structured",
      accountId: entry.accountId,
      parentConversationId: receipt.parentConversationId,
      cwd: entry.cwd,
      artifactPath,
      capabilities: {
        steer: key.engine === "codex",
        structuredAttention: true,
        imageInput: runtimeImageCapability(key.engine, false),
        runtimeSettings: runtimeSettingsCapability(key.engine),
      },
      activeTurnId: null,
    },
  });
}

function resumeIdentityForReceipt(
  registry: AgentRegistry,
  receipt: SpawnReceipt,
): { key: SessionKey; artifactPath: string } | null {
  if (receipt.purpose !== "resume-successor") return null;
  const conversation = registry.conversation(receipt.conversationId);
  const source = conversation?.generations.find((generation) => generation.path === receipt.resumeSourcePath)
    ?? conversation?.generations.at(-1);
  return source ? { key: { engine: receipt.engine, sessionId: source.id }, artifactPath: source.path } : null;
}

/** Whether the engine session behind a staged identity actually exists (#1071).
    The only evidence is the transcript the engine writes when it creates the
    session — the same file `claude --resume` reads, so nothing weaker stands in
    for it. A registry row does not qualify: the broker opens its own row and
    emits an idle event the moment a child is spawned, before the CLI has
    created anything, so a promote inside that window would leave an event
    cursor pointing at a session that never existed. */
export function structuredSessionExists(
  identity: { artifactPath: string },
  exists: (candidate: string) => boolean = fs.existsSync,
): boolean {
  return Boolean(identity.artifactPath) && exists(identity.artifactPath);
}

export type StructuredClaudeLaunchForm =
  | { kind: "resume"; sessionId: string }
  | { kind: "fresh"; sessionId: string | undefined };

/** Which Claude CLI form a launch takes. Only a session with existence
    evidence is resumed: rebuilding a never-created session as
    `claude --resume <id>` makes the CLI exit with "No conversation found with
    session ID" and the launch can never succeed, however often it is retried.
    A retried fresh launch therefore re-runs the `--session-id` form under the
    SAME pre-allocated id, so the retry keeps the receipt's durable identity
    (#1071). */
export function structuredClaudeLaunchForm(
  input: Pick<StructuredSpawnInput, "receipt" | "registry" | "spec">,
  exists: (candidate: string) => boolean = fs.existsSync,
): StructuredClaudeLaunchForm {
  const identity = resumeIdentityForReceipt(input.registry, input.receipt);
  if (identity && structuredSessionExists(identity, exists)) {
    return { kind: "resume", sessionId: identity.key.sessionId };
  }
  return {
    kind: "fresh",
    sessionId: identity?.key.sessionId
      ?? (input.spec.transcript ? path.basename(input.spec.transcript, ".jsonl") : undefined),
  };
}

function releaseAdoptionClaim(
  registry: AgentRegistry,
  claimed: AgentRegistryEntry,
  terminal: boolean,
): void {
  if (!claimed.claimOwner || !claimed.structuredHost) return;
  if (terminal) {
    const projected = registry.setStructuredHostClaimed(claimed.key, {
      ...claimed.structuredHost,
      endpoint: "stdio:released",
      process: null,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    }, "dead", claimed.claimOwner, claimed.claimEpoch, true);
    if (projected) return;
  }
  registry.releaseStructuredHostClaim(claimed.key, claimed.claimOwner, claimed.claimEpoch);
}

export interface StructuredSpawnDependencies {
  startHost?(input: StructuredSpawnInput, capability: string): Promise<SpawnedStructuredHost>;
  bindHost?(
    registry: AgentRegistry,
    key: SessionKey,
    host: SpawnedStructuredHost,
    claimOwner: string,
    claimEpoch: number,
    releasedStatus?: "unhosted" | "dead",
  ): Promise<() => void>;
  publishHost?(
    key: SessionKey,
    host: SpawnedStructuredHost,
    ownsOperation?: () => Promise<boolean>,
  ): Promise<() => Promise<void>>;
  deliverFirst?(input: StructuredSpawnInput, artifactPath: string): Promise<void | "held">;
  processIdentity?(): ProcessIdentity;
  durableSetupTimeoutMs?: number;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

/** Why a queued launch from a previous generation must not be replayed, or
    null when it is still a legitimate replay candidate (#1071). Only a launch
    that never reached a live host qualifies, and only against a newer launch
    that demonstrably replaces THIS one. Two relations prove that: the durable
    supersedence edge, which a stage retry and a recovery spawn write naming the
    predecessor conversation, and an identical request digest, which a plain
    resubmission under a fresh idempotency key keeps. The digest alone is not
    enough — a retry that names its predecessor folds that name into its own
    digest, so the replacement's digest differs from the launch it replaces.
    An independent launch into the same working directory matches neither
    relation. Age alone proves nothing here, so a queued launch with no
    replacement keeps its established recovery. */
function supersededQueuedSpawnReason(
  snapshot: RegistryFile,
  receipt: SpawnReceipt,
): string | null {
  if (receipt.transport !== "structured" || receipt.purpose !== "launch") return null;
  if (receipt.state !== "starting" && receipt.state !== "path-pending") return null;
  if (receipt.artifactLifecycle !== "pending") return null;
  const entry = receipt.key ? snapshot.entries[sessionKeyId(receipt.key)] : null;
  if (entry?.structuredHost?.process || entry?.claimOwner) return null;
  const replaced = Object.values(snapshot.receipts).some((candidate) => {
    if (candidate.launchId === receipt.launchId) return false;
    if (candidate.transport !== "structured" || candidate.purpose !== "launch") return false;
    if (candidate.state === "failed" || candidate.state === "conflicted") return false;
    /* The explicit edge already names the launch it retires, so it carries its
       own direction and needs no timestamp ordering to establish one. */
    if (candidate.supersedes?.conversationId === receipt.conversationId) return true;
    return Boolean(receipt.requestDigest)
      && candidate.requestDigest === receipt.requestDigest
      && candidate.createdAt > receipt.createdAt;
  });
  return replaced
    ? "structured spawn was superseded by a newer launch of the same request"
    : null;
}

export async function recoverPendingStructuredSpawns(
  registry: AgentRegistry,
  client: RuntimeHostClient,
  options: StructuredSpawnRecoveryOptions = {},
): Promise<void> {
  /* Boot reconciliation shares the reaper's bounded contract so placeholders
     admitted by an older process settle before startup replay considers them. */
  await terminalizeStaleStructuredSpawns(registry, client, options);
  const spawnEffects = new Map<string, Record<string, unknown>>();
  let afterEventSeq = 0;
  while (true) {
    const batch = await client.effectBatch(["runtime.spawn"], afterEventSeq);
    for (const effect of batch) {
      const operationId = typeof effect.payload.operationId === "string" ? effect.payload.operationId : null;
      if (operationId) spawnEffects.set(operationId, effect.payload);
    }
    if (batch.length < 100) break;
    const next = Math.max(...batch.map((effect) => effect.eventSeq));
    if (!Number.isSafeInteger(next) || next <= afterEventSeq) throw new Error("structured spawn recovery effect page did not advance");
    afterEventSeq = next;
  }

  let registeringConversationIds: Set<string> | null = null;
  const registeringSessions = async (): Promise<Set<string>> => {
    if (!registeringConversationIds) {
      const runtime = await client.snapshot().catch(() => null);
      registeringConversationIds = new Set((runtime?.sessions ?? [])
        .filter((session) => session.host === "registering")
        .map((session) => session.conversationId));
    }
    return registeringConversationIds;
  };

  const snapshot = registry.readOnlySnapshot();
  for (const receipt of Object.values(snapshot.receipts)) {
    const effect = spawnEffects.get(receipt.launchId);
    /* Re-validate before replay (#1071): a queued launch the previous
       generation accepted is not replayed verbatim by its successor. One whose
       replacement already exists settles as failed here, so a stale
       first-generation launch can never drain into a second builder beside the
       fresh one. A live admission owner does not exempt it: a promote overlaps
       the generations, so the previous container is routinely still running,
       and its deferred execution beside the replacement IS the duplicate the
       issue reports. */
    const supersededReason = supersededQueuedSpawnReason(snapshot, receipt);
    if (supersededReason) {
      const stale = await client.operationStatus(receipt.launchId);
      const staleStatus = stale?.receipt.status;
      if (staleStatus === "pending" || staleStatus === "queued" || staleStatus === "delivering") {
        await client.transitionOperation(receipt.launchId, "failed", { reason: supersededReason });
      }
      const staged = receipt.key ? snapshot.entries[sessionKeyId(receipt.key)] : null;
      if (staged) {
        await projectDeadStructuredSpawn(client, receipt, staged, `structured-spawn-superseded:${receipt.launchId}`);
      }
      registry.failStructuredSpawn(receipt.launchId, supersededReason);
      continue;
    }
    if (receipt.state === "failed" && receipt.transport !== "tmux") {
      const reconciled = await reconcileStructuredSpawnReplay(receipt.launchId, registry, client);
      if (reconciled.state === "completed") continue;
      /* The durable launch receipt failed, but its runtime spawn operation can
         survive as queued when the terminal transition itself timed out. The
         placeholder session then sits registering/unknown until someone closes
         the operation; the journal retires the placeholder on that transition. */
      if (!(await registeringSessions()).has(receipt.conversationId)) continue;
      const operation = await client.operationStatus(receipt.launchId);
      const status = operation?.receipt.status;
      if (operation
        && operation.receipt.conversationId === receipt.conversationId
        && (status === "pending" || status === "queued" || status === "delivering")) {
        await client.transitionOperation(receipt.launchId, "failed", {
          reason: (receipt.error ?? "structured spawn failed before runtime acknowledgement").slice(0, 240),
        });
      }
      continue;
    }
    if (queuedPinnedSpawnForReceipt(receipt)) continue;
    if (receipt.state === "starting" && !receipt.key && receipt.transport !== "tmux") {
      const operation = await client.operationStatus(receipt.launchId);
      if (receipt.transport !== "structured" && !effect && !operation) continue;
      let reason: string;
      if (operation?.receipt.status === "queued" || operation?.receipt.status === "pending" || operation?.receipt.status === "delivering") {
        reason = `structured spawn interrupted before identity staging: ${receipt.launchId}`;
        await client.transitionOperation(receipt.launchId, "failed", { reason });
      } else if (!operation) {
        reason = `structured spawn interrupted before runtime admission: ${receipt.launchId}`;
      } else {
        reason = operation.receipt.reason
          ?? `structured spawn operation ended as ${operation.receipt.status} before identity staging`;
      }
      const identity = resumeIdentityForReceipt(registry, receipt);
      let claimed: AgentRegistryEntry | null = null;
      if (identity) {
        const entry = registry.readOnlySnapshot().entries[sessionKeyId(identity.key)];
        if (entry?.structuredHost) {
          claimed = registry.claimStructuredHost(identity.key, captureProcessIdentity(process.pid), { allowUnhosted: true });
          if (!claimed?.claimOwner) {
            registry.failStructuredSpawn(receipt.launchId, reason);
            continue;
          }
        }
        try {
          await projectDeadStructuredSpawn(
            client,
            receipt,
            entry ?? { accountId: receipt.accountId, cwd: receipt.cwd },
            `structured-spawn-failed:${receipt.launchId}`,
            identity,
          );
        } catch (error) {
          if (claimed) releaseAdoptionClaim(registry, claimed, false);
          throw error;
        }
        if (claimed) releaseAdoptionClaim(registry, claimed, true);
      }
      registry.failStructuredSpawn(receipt.launchId, reason);
      continue;
    }
    if (receipt.state !== "path-pending" || !receipt.key || !receipt.artifactPath) continue;
    const entry = snapshot.entries[sessionKeyId(receipt.key)];
    const operation = await client.operationStatus(receipt.launchId);
    const status = operation?.receipt.status;
    if (status && FAILED_SPAWN_OPERATION_STATUSES.has(status)) {
      const stagedByAnotherOperation = typeof entry?.structuredHostOperationId === "string"
        && entry.structuredHostOperationId !== receipt.launchId;
      if (stagedByAnotherOperation) {
        registry.failSpawn(
          receipt.launchId,
          operation?.receipt.reason ?? `structured spawn operation ended as ${status}`,
        );
        continue;
      }
      const ownedByFailedOperation = entry?.structuredHostOperationId === receipt.launchId
        || (entry?.structuredHostOperationId === undefined && entry?.pendingAction === "spawn");
      let recoveryClaim: AgentRegistryEntry | null = null;
      let releasedOwnedHost = false;
      if (entry?.structuredHost && !ownedByFailedOperation) {
        recoveryClaim = registry.claimStructuredHost(receipt.key, captureProcessIdentity(process.pid), { allowUnhosted: true });
        if (!recoveryClaim?.claimOwner) {
          registry.failSpawn(
            receipt.launchId,
            operation?.receipt.reason ?? `structured spawn operation ended as ${status}`,
          );
          continue;
        }
      }
      try {
        const releasedHost = await releaseStructuredDeliveryHost(receipt.key);
        releasedOwnedHost = ownedByFailedOperation && releasedHost;
        if (entry?.structuredHost && ownedByFailedOperation && !releasedHost) {
          recoveryClaim = registry.claimStructuredHost(receipt.key, captureProcessIdentity(process.pid), { allowUnhosted: true });
          if (!recoveryClaim?.claimOwner) {
            throw new Error(`structured spawn failed host is still owned for ${receipt.launchId}`);
          }
        }
        if (entry) await projectDeadStructuredSpawn(
          client,
          receipt,
          entry,
          `structured-spawn-failed:${receipt.launchId}`,
        );
      } catch (error) {
        const failedClaim = recoveryClaim ?? (releasedOwnedHost ? entry : null);
        if (failedClaim) releaseAdoptionClaim(registry, failedClaim, false);
        throw error;
      }
      registry.failStructuredSpawn(
        receipt.launchId,
        operation?.receipt.reason ?? `structured spawn operation ended as ${status}`,
      );
      continue;
    }
    if (status === "delivered") {
      /* A prior process may have written the runtime receipt before its
         registry settlement. Publish that staged identity only when the
         session artifact still supplies the persistence evidence. */
      if (!structuredTranscriptIsReadable(receipt.artifactPath)) continue;
      const hostReady = entry?.structuredHost?.process
        && entry.claimOwner
        && entry.status !== "dead"
        && entry.status !== "unhosted";
      if (hostReady) {
        const finalized = registry.finalizeStructuredSpawn(receipt.launchId);
        if (finalized.kind === "conflict") throw new Error(`structured spawn recovery conflict: ${finalized.code}`);
      } else {
        if (!entry) throw new Error(`structured spawn recovery identity is unavailable for ${receipt.launchId}`);
        await releaseStructuredDeliveryHost(receipt.key);
        await projectDeadStructuredSpawn(
          client,
          receipt,
          entry,
          `structured-spawn-delivered-host-dead:${receipt.launchId}`,
        );
        const settled = registry.recoverDeliveredStructuredSpawn(receipt.launchId);
        if (settled.kind === "conflict") throw new Error(`structured spawn recovery conflict: ${settled.code}`);
      }
      continue;
    }
    if (!entry?.structuredHost || entry.status === "dead" || entry.status === "unhosted") continue;
    const prompt = typeof effect?.prompt === "string" ? effect.prompt : null;
    const imageRefs = parseStructuredImageRefs(effect?.images ?? [], 16);
    if (prompt === null || effect?.conversationId !== receipt.conversationId || effect?.cwd !== receipt.cwd) {
      throw new Error(`structured spawn recovery is missing durable prompt admission for ${receipt.launchId}`);
    }
    if (imageRefs === null) throw new Error(`structured spawn recovery has invalid image refs for ${receipt.launchId}`);
    if (prompt.trim() || imageRefs.length) {
      const origin = spawnMessageOrigin(receipt, registry);
      const delivered = await enqueueStructuredMessage({
        path: receipt.artifactPath,
        conversationId: receipt.conversationId,
        clientMessageId: `spawn_${receipt.launchId}`,
        operationId: `spawn_message_${receipt.launchId}`,
        text: prompt,
        imageRefs,
        ...(origin ? { origin } : {}),
      }, {
        client: () => client,
        registry: () => registry,
        enabled: () => true,
      });
      if (!delivered?.ok) throw new Error(delivered?.error ?? `structured spawn recovery could not admit ${receipt.launchId}`);
      if (delivered.outcome === "held") continue;
      if (delivered.outcome !== "delivered") {
        await waitForStructuredInitialMessage(client, delivered.operationId);
        settleInitialMessageReservation(registry, receipt.launchId);
      }
    }
    /* Delivery acceptance can precede lazy Codex rollout creation. Keep the
       receipt staged so replay exposes no identity while the host is live. */
    if (!structuredTranscriptIsReadable(receipt.artifactPath)) continue;
    await client.transitionOperation(receipt.launchId, "delivered");
    const finalized = registry.finalizeStructuredSpawn(receipt.launchId);
    if (finalized.kind === "conflict") throw new Error(`structured spawn recovery conflict: ${finalized.code}`);
  }
}

function pendingColumns(engine: AgentEngine, eventCursor = 0, writerClaimEpoch = 0): StructuredHostColumns {
  return {
    kind: engine === "codex" ? "codex-app-server" : "claude-broker",
    endpoint: "stdio:pending",
    process: null,
    eventCursor,
    protocolVersion: null,
    writerClaimEpoch,
    activeTurnRef: null,
    pendingAttention: [],
    activeFlags: [],
  };
}

function hostIdentity(engine: AgentEngine, host: SpawnedStructuredHost, input: StructuredSpawnInput): { key: SessionKey; path: string } {
  if (engine === "codex") {
    const identity = host.identity as { threadId?: string; path?: string | null };
    if (!identity.threadId) throw new Error("structured Codex spawn returned no thread identity");
    if (!identity.path) throw new Error("structured Codex spawn feature gap: app-server returned no transcript path");
    const key = sessionKey("codex", identity.threadId);
    if (!key) throw new Error("structured Codex spawn returned an invalid thread identity");
    return { key, path: identity.path };
  }
  const identity = host.identity as { sessionId?: string };
  if (!identity.sessionId) throw new Error("structured Claude spawn returned no session identity");
  const key = sessionKey("claude", identity.sessionId);
  if (!key) throw new Error("structured Claude spawn returned an invalid session identity");
  return {
    key,
    path: input.spec.transcript ?? claudeTranscriptPath(input.spec.cwd, identity.sessionId, input.account.transcriptRoot),
  };
}

export interface StructuredClaudePermissionContext {
  agentInitiated: boolean;
  operatorAuthenticated: boolean;
  roleSpawn: boolean;
}

/** Viewer-managed role launches run autonomously behind prompt and tool
    fences, so a role spawn keeps the full-permission mode regardless of which
    capability lane admitted it; only a role-less agent-initiated spawn loses
    the bypass. */
export function structuredClaudePermissionMode(
  mode: string | null | undefined,
  context: StructuredClaudePermissionContext,
): string {
  if (!mode) return "default";
  if (mode !== "bypassPermissions") return mode;
  return !context.agentInitiated || context.operatorAuthenticated || context.roleSpawn ? mode : "default";
}

export function structuredClaudeSpawnPolicyBaseSettingsPath(
  account: Pick<AccountContext, "kind">,
  sharedSettingsPath: () => string | null = claudeSettingsPath,
): string | null {
  return account.kind === "managed" ? sharedSettingsPath() : null;
}

async function defaultStartHost(input: StructuredSpawnInput, capability: string): Promise<SpawnedStructuredHost> {
  const profile = input.spec.launchProfile ?? {} as LaunchProfile;
  const resumeSessionId = structuredResumeSessionId(input);
  const initialEventCursor = resumeSessionId
    ? input.registry.readOnlySnapshot().entries[sessionKeyId({ engine: input.engine, sessionId: resumeSessionId })]?.structuredHost?.eventCursor
    : undefined;
  if (initialEventCursor !== undefined
    && (!Number.isSafeInteger(initialEventCursor) || initialEventCursor < 0)) {
    throw new Error("structured resume event cursor is invalid");
  }
  const access = materializeStructuredHostAccess(profile.readOnly === true, input.account.env, capability);
  const env = access.env;
  if (input.engine === "codex") {
    const options = {
      cwd: input.spec.cwd,
      codexHome: input.account.home,
      fileAuthCredentials: input.account.kind === "managed",
      model: profile.model ?? undefined,
      effort: profile.effort ?? undefined,
      allowSubagents: profile.allowSubagents,
      mcpServers: profile.mcpServers,
      /* Plugin grant from the durable profile (issue #687): present only for
         an operator-launched root session that did not opt out. */
      plugins: profile.plugins,
      ...access.codex,
      ...access.host,
      approvalPolicy: profile.permissionMode ?? undefined,
      initialEventCursor,
      env,
    };
    return resumeSessionId
      ? await CodexAppServerHost.adopt(resumeSessionId, options)
      : await CodexAppServerHost.start(options);
  }
  const form = structuredClaudeLaunchForm(input);
  const options = {
    cwd: input.spec.cwd,
    claudeConfigDir: input.account.home,
    claudeProjectsDir: input.account.transcriptRoot,
    spawnPolicyBaseSettingsPath: structuredClaudeSpawnPolicyBaseSettingsPath(input.account),
    allowSubagents: profile.allowSubagents,
    mcpServers: profile.mcpServers,
    mcpStatePath: input.account.kind === "managed"
      ? path.join(input.account.home, ".claude.json")
      : path.join(path.dirname(input.account.home), ".claude.json"),
    readOnly: profile.readOnly === true,
    model: profile.model ?? undefined,
    effort: profile.effort ?? undefined,
    permissionMode: effectiveClaudePermissionMode(profile),
    initialEventCursor,
    env,
    ...access.host,
  };
  return form.kind === "resume"
    ? await ClaudeStreamBrokerHost.adopt(form.sessionId, options)
    : await ClaudeStreamBrokerHost.start({ ...options, ...(form.sessionId ? { sessionId: form.sessionId } : {}) });
}

export function structuredResumeSessionId(
  input: Pick<StructuredSpawnInput, "receipt" | "registry">,
): string | null {
  return resumeIdentityForReceipt(input.registry, input.receipt)?.key.sessionId ?? null;
}

async function defaultBindHost(
  registry: AgentRegistry,
  key: SessionKey,
  host: SpawnedStructuredHost,
  claimOwner: string,
  claimEpoch: number,
  releasedStatus: "unhosted" | "dead" = "unhosted",
): Promise<() => void> {
  return key.engine === "codex"
    ? await bindCodexHostPersistence(registry, key, host as CodexAppServerHost, claimOwner, claimEpoch, releasedStatus)
    : await bindClaudeHostPersistence(registry, key, host as ClaudeStreamBrokerHost, claimOwner, claimEpoch, releasedStatus);
}

/**
 * Authorship of a spawn's FIRST message (#1117), from the receipt's recorded
 * delegation depth: 0 is an operator/external root whose prompt the operator
 * typed; a deeper launch was delegated, so its mandate is inter-agent traffic
 * from the parent conversation (named by its role when the registry knows one).
 * Legacy receipts without a depth stay unattributed — the feed must not guess.
 */
function spawnMessageOrigin(receipt: SpawnReceipt, registry: AgentRegistry): MessageOrigin | undefined {
  if (receipt.delegationDepth === 0) return { kind: "operator" };
  if (receipt.delegationDepth === null || receipt.delegationDepth === undefined) return undefined;
  const parent = receipt.parentConversationId ? registry.conversation(receipt.parentConversationId) : null;
  const role = messageOriginRole(parent?.agentRole ?? undefined);
  return { kind: "agent", ...(role ? { role } : {}) };
}

async function defaultDeliverFirst(input: StructuredSpawnInput, artifactPath: string): Promise<void | "held"> {
  if (!input.prompt.trim() && !input.imageRefs?.length) return;
  const origin = spawnMessageOrigin(input.receipt, input.registry);
  const delivered = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: input.receipt.conversationId,
    clientMessageId: `spawn_${input.receipt.launchId}`,
    operationId: `spawn_message_${input.receipt.launchId}`,
    text: input.prompt,
    imageRefs: input.imageRefs,
    ...(origin ? { origin } : {}),
  }, {
    client: () => input.client,
    registry: () => input.registry,
    enabled: () => true,
  });
  if (!delivered?.ok) {
    const message = delivered?.error ?? "structured spawn first-message delivery was unavailable";
    if (delivered?.transportUncertain) throw new StructuredInitialMessageTimeoutError(message);
    throw new Error(message);
  }
  if (delivered.outcome === "held") return "held";
  if (delivered.outcome !== "delivered") {
    await waitForStructuredInitialMessage(input.client, delivered.operationId);
    settleInitialMessageReservation(input.registry, input.receipt.launchId);
  }
}

/** The terminal reason a spawned host is already dead before its first message
    landed, or null when the host is still live (or cannot be read, which stays
    recoverable reconciliation work exactly as before). */
async function terminalHostExitReason(host: SpawnedStructuredHost | null): Promise<string | null> {
  if (!host) return null;
  let state: HostState;
  try { state = await host.health(); }
  catch { return null; }
  if (state.status !== "dead") return null;
  return host.terminalExitReason?.() ?? "structured spawn host exited before its first message";
}

async function cleanupHost(host: SpawnedStructuredHost | null, binding: HostBinding): Promise<void> {
  await host?.release();
  let unregisterError: unknown = null;
  try {
    await binding.unregister();
  } catch (error) {
    unregisterError = error;
  }
  binding.stopPersistence();
  if (unregisterError) throw unregisterError;
}

export async function spawnStructuredConversation(
  input: StructuredSpawnInput,
  dependencies: StructuredSpawnDependencies = {},
): Promise<SpawnResponse> {
  const startHost = dependencies.startHost ?? defaultStartHost;
  const bindHost = dependencies.bindHost ?? defaultBindHost;
  const publishHost = dependencies.publishHost
    ?? ((key, host, ownsOperation) => publishStructuredDeliveryHost({ key, host }, ownsOperation));
  const deliverFirst = dependencies.deliverFirst ?? defaultDeliverFirst;
  const processIdentity = dependencies.processIdentity ?? (() => captureProcessIdentity(process.pid));
  const now = dependencies.now ?? Date.now;
  const operationId = input.receipt.launchId;
  const resumeSessionId = structuredResumeSessionId(input);
  const resumeKey = resumeSessionId ? sessionKey(input.engine, resumeSessionId) : null;
  const resumeIdentity = resumeIdentityForReceipt(input.registry, input.receipt);
  let host: SpawnedStructuredHost | null = null;
  const binding: HostBinding = { stopPersistence: () => {}, unregister: async () => {} };
  let key: SessionKey | null = null;
  let adoptionClaim: AgentRegistryEntry | null = null;
  let adoptionClaimTransferred = false;
  let adoptionClaimContended = false;
  let durableSetupTimedOut = false;
  let durableSetupDeadline = 0;
  let materializationPending = false;
  let durableSetupTimer: ReturnType<typeof setTimeout> | null = null;
  let durableSetupTimeout: Promise<never> | null = null;
  const clearDurableSetupTimeout = () => {
    if (durableSetupTimer !== null) clearTimeout(durableSetupTimer);
    durableSetupTimer = null;
    durableSetupTimeout = null;
  };
  const withinDurableSetup = <T>(work: Promise<T>): Promise<T> => {
    if (!durableSetupTimeout) return work;
    return Promise.race([work, durableSetupTimeout]);
  };
  try {
    /* Bypass acceptance and project trust are staged in the managed home
       before runtime admission: no structured launch may ever wait at an
       interactive acceptance gate, whichever caller reached this point. */
    if (input.engine === "claude" && input.account.kind === "managed") {
      prepareManagedClaudeSpawnHome(input.account.home, input.spec.cwd);
    }
    const imageRefs = input.imageRefs ?? [];
    const content = input.prompt.trim() || imageRefs.length
      ? structuredContent(input.prompt, imageRefs)
      : null;
    await withRuntimeAdmissionRetry(() => input.client.command({
      kind: "spawn",
      operationId,
      idempotencyKey: operationId,
      conversationId: input.receipt.conversationId,
      engine: input.engine,
      cwd: input.spec.cwd,
      "prompt": content?.content.text ?? "",
      ...(content?.content.images.length ? { images: content.content.images } : {}),
      ...(content ? { contentDigest: content.contentDigest } : {}),
      accountId: input.account.accountId,
      parentConversationId: input.receipt.parentConversationId,
      ...(input.receipt.purpose === "resume-successor" ? { sessionId: structuredResumeSessionId(input) } : {}),
    }));
    const capability = input.registry.rotateSpawnCapabilityForReceipt(input.receipt.launchId);
    const resumeEntry = resumeKey ? input.registry.readOnlySnapshot().entries[sessionKeyId(resumeKey)] : null;
    if (resumeEntry?.structuredHost) {
      adoptionClaim = input.registry.claimStructuredHost(resumeKey!, processIdentity(), { allowUnhosted: true });
      if (!adoptionClaim?.claimOwner) {
        adoptionClaimContended = true;
        throw new Error("structured resume host claim is unavailable");
      }
    }
    const durableSetupTimeoutMs = dependencies.durableSetupTimeoutMs
      ?? STRUCTURED_SPAWN_DURABLE_SETUP_TIMEOUT_MS;
    durableSetupDeadline = now() + durableSetupTimeoutMs;
    durableSetupTimeout = new Promise<never>((_resolve, reject) => {
      durableSetupTimer = setTimeout(() => {
        durableSetupTimedOut = true;
        reject(materializationPending
          ? new StructuredSessionMaterializationError(
            `structured spawn startup reached its ${durableSetupTimeoutMs}ms durable setup bound while session materialization was pending`,
          )
          : new Error(`structured spawn durable host setup timed out after ${durableSetupTimeoutMs}ms`));
      }, durableSetupTimeoutMs);
      durableSetupTimer.unref?.();
    });
    const startingHost = startHost(input, capability);
    void startingHost.then(async (lateHost) => {
      if (!durableSetupTimedOut) return;
      try {
        await lateHost.release();
      } catch (error) {
        console.error("[spawn] late structured host could not be released after setup timeout", {
          launchId: input.receipt.launchId,
          error: structuredSpawnFailureReason(error),
        });
      }
    }, () => {});
    host = await withinDurableSetup(startingHost);
    const identity = hostIdentity(input.engine, host, input);
    key = identity.key;
    if (resumeKey && sessionKeyId(key) !== sessionKeyId(resumeKey)) {
      throw new Error("structured resume returned a different session identity");
    }
    const stagedClaimEpoch = adoptionClaim?.claimEpoch ?? 0;
    const stagedClaimOwner = adoptionClaim?.claimOwner ?? null;
    const staged = input.registry.stageStructuredSpawn(input.receipt.launchId, {
      key,
      artifactPath: identity.path,
      cwd: input.spec.cwd,
      accountId: input.account.accountId,
      launchProfile: input.spec.launchProfile,
      status: "unhosted",
      host: null,
      structuredHost: pendingColumns(
        input.engine,
        adoptionClaim?.structuredHost?.eventCursor ?? 0,
        stagedClaimEpoch,
      ),
      claimEpoch: stagedClaimEpoch,
      claimOwner: stagedClaimOwner,
      pendingAction: "spawn",
    });
    if (staged.kind === "conflict") throw new Error(`structured spawn registry conflict: ${staged.code}`);
    const stagedPath = identityMaterializationFence().allowsReceipt(staged.receipt, { structured: true })
      ? identity.path
      : null;
    const claimed = adoptionClaim
      ? staged.entry
      : input.registry.claimStructuredHost(key, processIdentity(), { allowUnhosted: true });
    if (!claimed?.claimOwner) throw new Error("structured spawn host claim is unavailable");
    adoptionClaimTransferred = adoptionClaim !== null;
    binding.stopPersistence = await withinDurableSetup(
      bindHost(input.registry, key, host, claimed.claimOwner, claimed.claimEpoch),
    );
    const ownsLaunch = async () => {
      if (durableSetupTimedOut) return false;
      const snapshot = input.registry.readOnlySnapshot();
      const current = snapshot.receipts[input.receipt.launchId];
      const entry = snapshot.entries[sessionKeyId(key!)];
      return Boolean(current
        && current.state !== "completed"
        && current.state !== "failed"
        && current.state !== "conflicted"
        && entry?.structuredHostOperationId === input.receipt.launchId);
    };
    binding.unregister = await withinDurableSetup(publishHost(key, host, ownsLaunch));
    let initialMessage: void | "held";
    try {
      initialMessage = await withinDurableSetup(deliverFirst(input, identity.path));
    } catch (error) {
      /* Host identity and ownership are durable by this point. A caller
         timeout becomes reconciliation work and never enters host cleanup. */
      if (!(error instanceof StructuredInitialMessageTimeoutError)) throw error;
      /* A CLI that could not start at all — "No conversation found with session
         ID" and its immediate-exit siblings — leaves an already dead host and
         a first message that will never land. That is terminal, not a slow
         launch: it enters the failure path below so the receipt and its runtime
         operation settle as failed and the caller can resubmit, instead of
         reporting `queued` forever (#1071). */
      const terminal = await terminalHostExitReason(host);
      if (terminal) throw new Error(terminal);
      markInitialMessageTimeout(input.registry, input.receipt.launchId, error);
      initialMessage = "held";
    }
    if (initialMessage === "held") {
      clearDurableSetupTimeout();
      input.registry.releaseStructuredSpawnAdmissionOwner(
        input.receipt.launchId,
        input.receipt.admissionOwner ?? processIdentity(),
      );
      return {
        ok: true,
        target: null,
        path: stagedPath,
        ...(input.engine === "claude"
          ? { effectivePermissionMode: input.spec.launchProfile?.permissionMode ?? "default" }
          : {}),
        launchId: input.receipt.launchId,
        conversationId: input.receipt.conversationId,
        launched: true,
        retrySafe: false,
        initialMessage: "queued",
        state: "path-pending",
        transport: "structured",
      };
    }
    if (!content && !structuredTranscriptIsReadable(identity.path)) {
      clearDurableSetupTimeout();
      input.registry.releaseStructuredSpawnAdmissionOwner(
        input.receipt.launchId,
        input.receipt.admissionOwner ?? processIdentity(),
      );
      return {
        ok: true,
        target: null,
        path: stagedPath,
        ...(input.engine === "claude"
          ? { effectivePermissionMode: input.spec.launchProfile?.permissionMode ?? "default" }
          : {}),
        launchId: input.receipt.launchId,
        conversationId: input.receipt.conversationId,
        launched: true,
        retrySafe: false,
        initialMessage: "pending",
        state: "path-pending",
        transport: "structured",
      };
    }
    if (content) {
      const sleep = dependencies.sleep
        ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      materializationPending = true;
      try {
        /* The id the engine wire actually carries: the drain stamps the spawn
           first message with the OPERATION id (`spawn_message_<launchId>`),
           not the held delivery's `spawn_<launchId>` clientMessageId, and the
           persisted rollout item echoes the wire id. Hunting the wrong id
           left materialization pending forever (#1332). */
        await withinDurableSetup(waitForStructuredSessionMaterialization(
          host,
          identity.path,
          `spawn_message_${input.receipt.launchId}`,
          {
            now,
            sleep,
            timeoutMs: Math.max(0, durableSetupDeadline - now()),
          },
        ));
      } finally {
        materializationPending = false;
      }
    }
    await withinDurableSetup(
      withRuntimeAdmissionRetry(() => input.client.transitionOperation(operationId, "delivered")),
    );
    const settled = input.registry.finalizeStructuredSpawn(input.receipt.launchId);
    if (settled.kind === "conflict") throw new Error(`structured spawn registry conflict: ${settled.code}`);
    clearDurableSetupTimeout();
    return {
      ok: true,
      target: null,
      path: identityMaterializationFence().allowsReceipt(settled.receipt, { structured: true })
        ? identity.path
        : null,
      ...(input.engine === "claude"
        ? { effectivePermissionMode: input.spec.launchProfile?.permissionMode ?? "default" }
        : {}),
      launchId: input.receipt.launchId,
      conversationId: settled.conversation.id,
      launched: true,
      retrySafe: false,
      initialMessage: "delivered",
      state: "settled",
      transport: "structured",
    };
  } catch (error) {
    clearDurableSetupTimeout();
    const failureReason = structuredSpawnFailureReason(error);
    await input.client.transitionOperation(operationId, "failed", {
      reason: failureReason,
    }).catch(() => {});
    if (!host && error instanceof StructuredHostAdoptionCleanupError) {
      host = error.host as SpawnedStructuredHost;
      if (resumeKey && adoptionClaim?.claimOwner) {
        key = resumeKey;
        binding.stopPersistence = await bindHost(
          input.registry,
          resumeKey,
          host,
          adoptionClaim.claimOwner,
          adoptionClaim.claimEpoch,
          "dead",
        );
      }
    }
    let cleanupError: unknown = null;
    try {
      await cleanupHost(host, binding);
    } catch (failure) {
      cleanupError = failure;
    }
    const transcriptFailureMustSettle = input.receipt.purpose === "launch"
      && (error instanceof StructuredTranscriptMaterializationError
        || error instanceof StructuredSessionMaterializationError);
    if (cleanupError !== null && !transcriptFailureMustSettle) throw error;
    let failedEntry: AgentRegistryEntry | null = null;
    let failedIdentity = resumeIdentity;
    if (key) {
      const entry = input.registry.readOnlySnapshot().entries[sessionKeyId(key)];
      if (entry) {
        failedEntry = entry;
        failedIdentity = { key, artifactPath: entry.artifactPath };
      }
    } else {
      if (resumeIdentity) {
        failedEntry = input.registry.readOnlySnapshot().entries[sessionKeyId(resumeIdentity.key)] ?? null;
      }
    }
    if (typeof failedEntry?.structuredHostOperationId === "string"
      && failedEntry.structuredHostOperationId !== input.receipt.launchId) {
      failedIdentity = null;
    }
    let projectionSucceeded = cleanupError === null;
    if (failedIdentity && !adoptionClaimContended && cleanupError === null) {
      try {
        await projectDeadStructuredSpawn(
          input.client,
          input.receipt,
          failedEntry ?? { accountId: input.account.accountId, cwd: input.spec.cwd },
          `structured-spawn-failed:${input.receipt.launchId}`,
          failedIdentity,
        );
      } catch {
        projectionSucceeded = false;
      }
    }
    if (adoptionClaim && (!adoptionClaimTransferred || !projectionSucceeded)) {
      releaseAdoptionClaim(input.registry, adoptionClaim, projectionSucceeded);
    }
    const terminalFreshLaunch = input.receipt.purpose === "launch";
    if (projectionSucceeded || terminalFreshLaunch) {
      if (key) {
        input.registry.failStructuredSpawn(input.receipt.launchId, failureReason, {
          retainRegisteredHost: cleanupError !== null,
        });
      } else {
        input.registry.failSpawn(input.receipt.launchId, failureReason);
      }
    }
    if (cleanupError !== null) {
      console.error("[spawn] failed host cleanup remained unconfirmed", {
        launchId: input.receipt.launchId,
        error: structuredSpawnFailureReason(cleanupError),
      });
    }
    throw error;
  }
}
