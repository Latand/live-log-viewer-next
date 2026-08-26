import crypto from "node:crypto";

import {
  agentRegistry,
  readOnlyConversationLookupFromSnapshot,
  type RegistryFile,
} from "@/lib/agent/registry";
import { UNRESOLVED_PROJECT } from "@/lib/projects/identity";
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
}

function digest(...parts: string[]): string {
  return crypto.createHash("sha256").update(parts.join("\0")).digest("hex");
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
  dependencies.enqueue(action);
  return action;
}
