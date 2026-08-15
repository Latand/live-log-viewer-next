import { decodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText";
import type { ProjectAttributionSource } from "@/lib/session/projectResolution";

import { kyivDayBounds } from "./calculator";
import { historicalOperatorOccurrence } from "./ledger";
import type { OperatorOccurrenceInput } from "./types";

type RecordLike = Record<string, unknown>;

export interface HistoricalRecordInput {
  engine: "claude" | "codex";
  lineageId: string;
  occurrenceNamespace?: string;
  projectCandidates: OperatorOccurrenceInput["projectCandidates"];
  records: RecordLike[];
}

export interface HistoricalInventoryEntry {
  path: string;
  size?: number;
  mtime?: number;
  root: "claude-projects" | "codex-sessions" | string;
  rootPath?: string;
  engine: "claude" | "codex" | string;
  project: string;
  projectUnresolved?: true;
  projectOwnership?: { project: string };
  cwd?: string | null;
  projectSource?: ProjectAttributionSource;
  derivationComplete?: boolean;
}

export interface HistoricalInventory {
  complete: boolean;
  files: HistoricalInventoryEntry[];
}

interface HistoricalRegistryConversation {
  id: string;
  generations?: Array<{ path: string }>;
  continuityPaths?: string[];
}

export interface HistoricalRegistrySnapshot {
  conversations: Record<string, HistoricalRegistryConversation>;
  conversationAliases: Record<string, string>;
  lineageEdges: Record<string, { parentConversationId: string }>;
}

export interface HistoricalTranscriptRead {
  complete: boolean;
  records: RecordLike[];
}

export interface HistoricalInventoryResult {
  complete: boolean;
  reason?: "inventory-incomplete" | "derivation-incomplete" | "transcript-tail-incomplete";
  occurrences: OperatorOccurrenceInput[];
}

function record(value: unknown): RecordLike | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordLike : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function timestamp(value: unknown): number | null {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function textParts(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const item = record(part);
      if (!item) return "";
      if (item.type === "image" || item.type === "input_image") return `[${String(item.type)}]`;
      if (item.type !== "text") return "";
      return string(item.text) ?? string(item.input_text) ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

function codexUserText(item: RecordLike): string | null {
  const payload = record(item.payload);
  if (!payload) return null;
  if (payload.type === "user_message") {
    const message = string(payload.message);
    return message?.trim() ? message : null;
  }
  if (payload.type !== "message" || payload.role !== "user") return null;
  const text = textParts(payload.content);
  return text.trim() ? text : null;
}

function claudeUserText(item: RecordLike): string | null {
  if (item.type !== "user" || item.isMeta === true || item.isSidechain === true || item.isCompactSummary === true) return null;
  if (item.promptSource === "sdk" || item.promptSource === "system" || item.promptSource === "command") return null;
  const origin = typeof item.origin === "string" ? item.origin : string(record(item.origin)?.kind);
  if (origin !== "human" && item.promptSource !== "typed") return null;
  const text = textParts(record(item.message)?.content);
  return text.trim() ? text : null;
}

function operatorSourceId(item: RecordLike): string | null {
  const payload = record(item.payload);
  return string(item.operatorEventId)
    ?? string(item.client_id)
    ?? string(payload?.client_id);
}

function nativeRecordId(item: RecordLike): string | null {
  const payload = record(item.payload);
  const message = record(item.message);
  return string(item.id)
    ?? string(item.uuid)
    ?? string(payload?.id)
    ?? string(message?.id);
}

/**
 * Converts explicitly human-authored transcript rows into privacy-minimized
 * occurrence inputs. Text is used only to build the historical fallback
 * digest and never leaves this function.
 */
export function historicalOccurrencesFromRecords(input: HistoricalRecordInput): OperatorOccurrenceInput[] {
  const occurrences: OperatorOccurrenceInput[] = [];
  for (const [index, item] of input.records.entries()) {
    const occurredAtMs = timestamp(item.timestamp);
    if (occurredAtMs === null) continue;
    const occurrenceId = `${input.occurrenceNamespace ?? input.lineageId}:${occurredAtMs}:${index}`;
    if (input.engine === "codex") {
      const encoded = codexUserText(item);
      if (!encoded) continue;
      const decoded = decodeCodexStructuredUserText(encoded);
      if (decoded.operatorEvent) {
        occurrences.push({
          sourceId: decoded.operatorEvent.id,
          occurrenceId,
          origin: decoded.operatorEvent.origin,
          relation: decoded.operatorEvent.relation,
          occurredAtMs,
          projectCandidates: input.projectCandidates,
        });
        continue;
      }
      const explicitHuman = item.promptSource === "typed"
        || item.origin === "human"
        || record(item.origin)?.kind === "human"
        || (decoded.structured && operatorSourceId(item) !== null);
      if (!explicitHuman) continue;
      const sourceId = operatorSourceId(item) ?? nativeRecordId(item);
      if (sourceId) {
        occurrences.push({
          sourceId: `native:${input.engine}:${sourceId}`,
          occurrenceId,
          origin: "api-human",
          relation: "direct",
          occurredAtMs,
          projectCandidates: input.projectCandidates,
        });
      } else {
        occurrences.push(historicalOperatorOccurrence({
          normalizedText: decoded.text,
          lineageId: input.lineageId,
          occurrenceId,
          occurredAtMs,
          projectCandidates: input.projectCandidates,
        }));
      }
      continue;
    }
    const text = claudeUserText(item);
    if (!text) continue;
    const sourceId = operatorSourceId(item) ?? nativeRecordId(item);
    if (sourceId) {
      occurrences.push({
        sourceId: `native:${input.engine}:${sourceId}`,
        occurrenceId,
        origin: "historical",
        relation: "direct",
        occurredAtMs,
        projectCandidates: input.projectCandidates,
      });
    } else {
      occurrences.push(historicalOperatorOccurrence({
        normalizedText: text,
        lineageId: input.lineageId,
        occurrenceId,
        occurredAtMs,
        projectCandidates: input.projectCandidates,
      }));
    }
  }
  return occurrences;
}

function canonicalConversationId(snapshot: HistoricalRegistrySnapshot, value: string): string {
  let current = value;
  const visited = new Set<string>();
  while (snapshot.conversationAliases[current] && !visited.has(current)) {
    visited.add(current);
    current = snapshot.conversationAliases[current]!;
  }
  return current;
}

function conversationForPath(snapshot: HistoricalRegistrySnapshot, pathname: string): HistoricalRegistryConversation | null {
  for (const conversation of Object.values(snapshot.conversations)) {
    if (conversation.generations?.some((generation) => generation.path === pathname)
      || conversation.continuityPaths?.includes(pathname)) return conversation;
  }
  return null;
}

function lineageRoot(snapshot: HistoricalRegistrySnapshot, entry: HistoricalInventoryEntry): string {
  const conversation = conversationForPath(snapshot, entry.path);
  if (!conversation) return entry.path;
  let current = canonicalConversationId(snapshot, conversation.id);
  const visited = new Set<string>();
  while (!visited.has(current)) {
    visited.add(current);
    const parent = snapshot.lineageEdges[current]?.parentConversationId;
    if (!parent) break;
    current = canonicalConversationId(snapshot, parent);
  }
  return current;
}

function projectCandidates(entry: HistoricalInventoryEntry): OperatorOccurrenceInput["projectCandidates"] {
  const project = entry.project;
  if (!project || entry.projectUnresolved) return [];
  const source = entry.projectSource ?? (entry.projectOwnership ? "ownership" : entry.cwd ? "cwd" : "launch-profile");
  const rank = source === "ownership" ? 4 : source === "cwd" ? 3 : source === "launch-profile" ? 2 : 1;
  return [{ project, rank, evidence: `${source}:${project}` }];
}

/**
 * Imports one day only when the inventory and every candidate transcript are
 * complete. The all-or-nothing return prevents a caller from persisting a
 * partially classified corpus.
 */
export function scanHistoricalDayFromInventory(
  day: string,
  inventory: HistoricalInventory,
  registry: HistoricalRegistrySnapshot,
  readTranscript: (entry: HistoricalInventoryEntry) => HistoricalTranscriptRead,
): HistoricalInventoryResult {
  const bounds = kyivDayBounds(day);
  if (!inventory.complete) return { complete: false, reason: "inventory-incomplete", occurrences: [] };
  const entries = inventory.files.filter((entry) =>
    (entry.root === "claude-projects" || entry.root === "codex-sessions")
    && (entry.engine === "claude" || entry.engine === "codex")
    && entry.path.endsWith(".jsonl"));
  if (entries.some((entry) => entry.derivationComplete !== true)) {
    return { complete: false, reason: "derivation-incomplete", occurrences: [] };
  }
  const occurrences: OperatorOccurrenceInput[] = [];
  for (const entry of entries) {
    const transcript = readTranscript(entry);
    if (!transcript.complete) {
      return { complete: false, reason: "transcript-tail-incomplete", occurrences: [] };
    }
    occurrences.push(...historicalOccurrencesFromRecords({
      engine: entry.engine as "claude" | "codex",
      lineageId: lineageRoot(registry, entry),
      occurrenceNamespace: entry.path,
      projectCandidates: projectCandidates(entry),
      records: transcript.records,
    }).filter((occurrence) => occurrence.occurredAtMs >= bounds.startMs && occurrence.occurredAtMs < bounds.endMs));
  }
  return { complete: true, occurrences };
}
