import crypto from "node:crypto";

import {
  agentRegistry,
  readOnlyConversationLookupFromSnapshot,
  type RegistryFile,
} from "@/lib/agent/registry";
import { UNRESOLVED_PROJECT } from "@/lib/projects/identity";
import { FileTransactionBusyError } from "@/lib/state/fileTransaction";
import { resolveProjectAttribution } from "@/lib/session/projectResolution";
import type { FileEntry } from "@/lib/types";

import { wakatimeIntegrationEnabled } from "./activation";
import {
  enqueueProductionOperatorHeartbeat,
  type DirectOperatorWakatimeHeartbeat,
} from "./sync";

export type DirectOperatorWakatimeAction = DirectOperatorWakatimeHeartbeat;

export interface DirectOperatorWakatimeInput {
  conversationId?: string;
  path?: string;
  idempotencyKey?: string;
  /** Attribution resolved at a trusted server ingress before a conversation
      exists, such as a new-agent spawn or task fan-out. */
  resolvedAttribution?: { engine: "claude" | "codex"; project: string };
  fallbackEntry?: FileEntry;
}

interface DirectOperatorWakatimeDependencies {
  enabled(): boolean;
  now(): number;
  registrySnapshot(): RegistryFile;
  enqueue(action: DirectOperatorWakatimeHeartbeat): void;
  reportStorageFailure(
    event: string,
    fields: Readonly<Record<string, string | number | boolean | null>>,
  ): void;
}

function digest(...parts: string[]): string {
  return crypto.createHash("sha256").update(parts.join("\0")).digest("hex");
}

/** One closed set of outcome classes for a refused optional write. The failure
    text itself never travels: `fs` messages carry the state path, and a parse
    failure can quote state bytes. */
function storageOutcome(error: unknown): string {
  if (error instanceof FileTransactionBusyError) return "busy";
  if (error instanceof SyntaxError) return "state_unreadable";
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string" && /^E[A-Z]{1,15}$/.test(code)) return code;
  return "unavailable";
}

export function recordDirectOperatorWakatimeActivity(
  input: DirectOperatorWakatimeInput,
  overrides: Partial<DirectOperatorWakatimeDependencies> = {},
): DirectOperatorWakatimeAction | null {
  const dependencies: DirectOperatorWakatimeDependencies = {
    enabled: overrides.enabled ?? wakatimeIntegrationEnabled,
    now: overrides.now ?? Date.now,
    registrySnapshot: overrides.registrySnapshot ?? (() => agentRegistry().readOnlySnapshot()),
    enqueue: overrides.enqueue ?? enqueueProductionOperatorHeartbeat,
    reportStorageFailure: overrides.reportStorageFailure
      ?? ((event, fields) => console.error(`[wakatime] ${event}`, fields)),
  };
  if (!dependencies.enabled()) return null;
  const idempotencyKey = input.idempotencyKey?.trim() ?? "";

  const resolvedAttribution = input.resolvedAttribution;
  if (resolvedAttribution
    && ((resolvedAttribution.engine !== "claude" && resolvedAttribution.engine !== "codex")
      || !resolvedAttribution.project.trim()
      || resolvedAttribution.project === UNRESOLVED_PROJECT)) {
    throw new Error("direct operator activity attribution is invalid");
  }
  const lookup = resolvedAttribution
    ? null
    : readOnlyConversationLookupFromSnapshot(dependencies.registrySnapshot());
  const suppliedConversationId = input.conversationId?.trim() ?? "";
  const suppliedPath = input.path?.trim() ?? "";
  const byId = suppliedConversationId.startsWith("conversation_")
    ? lookup?.conversation(suppliedConversationId as `conversation_${string}`) ?? null
    : null;
  const byPath = suppliedPath ? lookup?.conversationForPath(suppliedPath) ?? null : null;
  const ownedPaths = byId
    ? new Set([
        ...byId.generations.map((generation) => generation.path),
        ...byId.continuityPaths,
        ...byId.abandonedContinuityPaths,
      ])
    : null;
  if ((byId && byPath && byId.id !== byPath.id)
    || (byId && suppliedPath && !ownedPaths?.has(suppliedPath))) {
    throw new Error("direct operator activity has conflicting target evidence");
  }
  const conversation = byId ?? byPath;
  const fallback = input.fallbackEntry;
  const engine = resolvedAttribution?.engine ?? conversation?.engine
    ?? (fallback?.engine === "claude" || fallback?.engine === "codex" ? fallback.engine : null);
  if (!engine) throw new Error("direct operator activity target is unavailable");
  const generation = conversation?.generations.at(-1);
  const project = resolvedAttribution?.project.trim() ?? resolveProjectAttribution({
    projectOwnership: conversation?.projectOwnership,
    cwd: generation?.launchProfile.cwd || fallback?.cwd,
    launchProfileProject: generation?.launchProfile.project,
    fallbackProject: fallback?.project,
  }).project;
  if (!project || project === UNRESOLVED_PROJECT) {
    throw new Error("direct operator activity project is unavailable");
  }
  const atMs = dependencies.now();
  if (!Number.isSafeInteger(atMs) || atMs <= 0) throw new Error("direct operator activity time is invalid");
  const key = idempotencyKey
    ? digest("llv-wakatime-direct-operator-v1", idempotencyKey)
    : crypto.randomBytes(32).toString("hex");
  const action: DirectOperatorWakatimeAction = { key, engine, project, atMs };
  /* THE ACTION IS ALREADY VALID HERE. Everything above rejects an unattributed,
     conflicting or unauthorized gesture by throwing, and callers turn that into
     a refusal. What remains is the optional heartbeat queue — a corrupt, busy or
     unwritable state file is a telemetry outage, and an outage in a statistics
     feature must not disable a control the operator is entitled to use (#1621).
     The point is dropped, the outcome class is reported, and no state is reset:
     an unreadable file keeps every byte for recovery from a backup. */
  try {
    dependencies.enqueue(action);
  } catch (error) {
    dependencies.reportStorageFailure("operator_activity_not_stored", { outcome: storageOutcome(error) });
  }
  return action;
}
