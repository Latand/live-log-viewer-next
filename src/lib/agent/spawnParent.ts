import fs from "node:fs";

import { agentRegistry, type AgentRegistry } from "./registry";
import { sessionKeyFromTranscript } from "./sessionKey";
import { claudeProjectRootFor, codexSessionRootFor } from "@/lib/scanner/roots";

export interface ResolvedSpawnParent {
  conversationId: `conversation_${string}`;
  engine: "claude" | "codex";
  artifactPath: string;
  sessionKey: ReturnType<typeof sessionKeyFromTranscript>;
}

export interface ResolvedSpawnLineage {
  parent: ResolvedSpawnParent | null;
  reviewed: ResolvedSpawnParent | null;
}

export class SpawnParentError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SpawnParentError";
  }
}

export function transcriptAllowed(candidate: string): boolean {
  let real: string;
  let stat: fs.Stats;
  try {
    real = fs.realpathSync(candidate);
    stat = fs.statSync(real);
  } catch {
    return false;
  }
  if (!stat.isFile() || !real.endsWith(".jsonl")) return false;
  if (codexSessionRootFor(real)) return true;
  return Boolean(claudeProjectRootFor(real));
}

function parentPath(body: { src?: unknown; parent?: unknown }): string {
  if (typeof body.parent === "string") return body.parent;
  return typeof body.src === "string" ? body.src : "";
}

function conversationForTranscript(transcript: string, registry: AgentRegistry): `conversation_${string}` {
  const existing = registry.conversationForPath(transcript);
  if (existing) return existing.id;
  return registry.ensureConversation(codexSessionRootFor(transcript) ? "codex" : "claude", transcript, null).id;
}

export function resolveSpawnParent(
  body: { src?: unknown; parent?: unknown; parentConversationId?: unknown },
  registry = agentRegistry(),
): ResolvedSpawnParent | null {
  if (body.parentConversationId !== undefined) {
    if (typeof body.parentConversationId !== "string" || !/^conversation_[0-9a-f-]{36}$/i.test(body.parentConversationId)) {
      throw new SpawnParentError("parentConversationId is invalid", 400);
    }
    const conversation = registry.conversation(body.parentConversationId as `conversation_${string}`);
    if (!conversation) throw new SpawnParentError("parent conversation is unknown", 404);
    const artifactPath = conversation.generations.at(-1)?.path;
    if (!artifactPath) throw new SpawnParentError("parent conversation has no active generation", 409);
    return {
      conversationId: conversation.id,
      engine: conversation.engine,
      artifactPath,
      sessionKey: sessionKeyFromTranscript(conversation.engine, artifactPath),
    };
  }
  const artifactPath = parentPath(body);
  if (!artifactPath || !transcriptAllowed(artifactPath)) return null;
  const engine = codexSessionRootFor(artifactPath) ? "codex" : "claude";
  return {
    conversationId: conversationForTranscript(artifactPath, registry),
    engine,
    artifactPath,
    sessionKey: sessionKeyFromTranscript(engine, artifactPath),
  };
}

export function resolveSpawnLineage(
  body: { role?: unknown; reviews?: unknown; src?: unknown; parent?: unknown; parentConversationId?: unknown },
  registry = agentRegistry(),
): ResolvedSpawnLineage {
  const reviewer = body.role === "reviewer";
  if (!reviewer) {
    if (body.reviews !== undefined) throw new SpawnParentError("reviews requires role: reviewer", 400);
    return { parent: resolveSpawnParent(body, registry), reviewed: null };
  }
  if (typeof body.reviews !== "string" || !body.reviews.trim()) {
    throw new SpawnParentError("reviewer requires reviews", 400);
  }
  const reviewRef = body.reviews.trim();
  const reviewed = reviewRef.startsWith("conversation_")
    ? resolveSpawnParent({ parentConversationId: reviewRef }, registry)
    : resolveSpawnParent({ parent: reviewRef }, registry);
  if (!reviewed) throw new SpawnParentError("reviewed conversation is invalid", 400);

  const explicitSelector = body.parentConversationId !== undefined || body.parent !== undefined || body.src !== undefined;
  const parent = explicitSelector ? resolveSpawnParent(body, registry) : reviewed;
  if (!parent) throw new SpawnParentError("reviewer caller is invalid", 400);
  return { parent, reviewed };
}

export function resolveSpawnLineageParent(
  body: { role?: unknown; reviews?: unknown; src?: unknown; parent?: unknown; parentConversationId?: unknown },
  registry = agentRegistry(),
): ResolvedSpawnParent | null {
  return resolveSpawnLineage(body, registry).parent;
}
