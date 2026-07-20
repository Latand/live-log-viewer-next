import { attentionId } from "@/components/attention";
import { conversationIdentity, isArchivedPredecessor } from "@/lib/accounts/identity";
import type { Engine, FileEntry } from "@/lib/types";

/*
 * Engine-native subagent tray — the single presence projection for issue #142
 * slice S2 (docs/design/board-presence-cards.md §1.2/§1.4).
 *
 * This is the one pure authority that sits between durable catalog lineage and
 * board assembly. It assigns each current-generation engine-native child to
 * exactly one board surface: a promoted full P2 node, a compact parent P1 tray
 * row, or (when its host cannot carry a tray) the existing full-node path. It
 * writes nothing — the only durable inputs are the identity-keyed fold pins and
 * tray-disclosure intent stored on the board state, so the placement survives
 * reloads and redeploys as a deterministic function of the scan + those pins.
 *
 * Review/pipeline-claimed, hidden (P0), viewer-origin and unattributed children
 * are OUT of scope here; the caller resolves those surfaces first and hands us
 * only their exclusion sets so a card is never placed in two surfaces at once.
 */

export type SubagentBadgeState = "running" | "live" | "closed" | "dead";

/** Presence surface an engine-native child renders on (§1.2 ladder). */
export type TrayPresence = "promoted" | "folded";

/** Why the child landed on its surface — precedence rung that matched first. */
export type PresenceReason =
  | "attention"
  | "hand-fold"
  | "owner"
  | "busy"
  | "quiet"
  | "fail-visible";

export function badgeState(entry: FileEntry): SubagentBadgeState {
  if (entry.path.startsWith("spawn:")) return "dead";
  if (entry.spawn?.state === "failed") return "dead";
  if (entry.proc === "done" || entry.proc === "killed" || entry.supersededBy || entry.activity === "idle") return "closed";
  if (entry.proc === "running" || entry.spawn?.state === "starting" || entry.spawn?.state === "binding" || entry.spawn?.state === "queued") {
    return "running";
  }
  return "live";
}

function spawnTime(entry: FileEntry): number {
  const started = entry.sessionStartedAt ? Date.parse(entry.sessionStartedAt) : Number.NaN;
  return Number.isFinite(started) ? started : entry.mtime * 1_000;
}

/** Activity rank for ordering + tray roll-up: lower is hotter. */
export function activeRank(state: SubagentBadgeState): number {
  if (state === "running" || state === "live") return 0;
  if (state === "closed") return 1;
  return 2;
}

/** The hottest (most-active) state across a set of members — the tray badge
    inherits it so nothing urgent hides behind a folded row (§1.4 roll-up). */
export function rollUpState(states: readonly SubagentBadgeState[]): SubagentBadgeState {
  let hottest: SubagentBadgeState = "dead";
  for (const state of states) {
    if (activeRank(state) < activeRank(hottest)) hottest = state;
  }
  return hottest;
}

/**
 * Direct current-generation children of one stable conversation, deduplicated
 * by conversation identity (the newest generation wins, mtime breaking a tie),
 * archived predecessors and shell tasks dropped. Shared authority consumed by
 * both the badge model and the tray projection so their membership can never
 * drift. `filter` narrows to a provenance subset without re-deriving lineage.
 */
export function currentGenerationChildrenOf(
  conversationId: string,
  entries: readonly FileEntry[],
  filter: (entry: FileEntry) => boolean = () => true,
): FileEntry[] {
  const parentPaths = new Set(
    entries
      .filter((entry) => conversationIdentity(entry) === conversationId)
      .map((entry) => entry.path),
  );
  const currentById = new Map<string, FileEntry>();
  for (const entry of entries) {
    if (isArchivedPredecessor(entry)) continue;
    if (entry.engine === "shell") continue;
    const id = conversationIdentity(entry);
    if (id === conversationId) continue;
    const durableParent = entry.durableLineage?.parentConversationId;
    if (durableParent !== conversationId && (!entry.parent || !parentPaths.has(entry.parent))) continue;
    if (!filter(entry)) continue;
    const current = currentById.get(id);
    const generation = entry.generation ?? 0;
    const currentGeneration = current?.generation ?? 0;
    if (!current || generation > currentGeneration || (generation === currentGeneration && entry.mtime > current.mtime)) {
      currentById.set(id, entry);
    }
  }
  return [...currentById.values()];
}

/** Engine-native provenance marker (issue #339): a Codex `spawn_agent` rollout
    or a Claude in-harness subagent, distinguished from operator spawns. */
export function isEngineNativeChild(entry: FileEntry): boolean {
  return entry.spawnOrigin === "engine";
}

/**
 * An engine child needs the board's attention right now, so it surfaces to a
 * full P2 node beside its parent even when it would otherwise fold (§1.4:
 * attention beats the tray). Covers a structured question, waiting input, a
 * rate-limit wall, a live stall, a failed spawn and a killed host — the
 * actionable-failure set from the presence policy.
 */
export function engineChildNeedsAttention(entry: FileEntry, now: number): boolean {
  if (attentionId(entry, now) !== null) return true;
  if (entry.spawn?.state === "failed") return true;
  if (entry.proc === "killed") return true;
  return false;
}

function isBusy(entry: FileEntry): boolean {
  if (entry.authoritativeTurn?.state === "busy") return true;
  if (entry.proc === "running") return true;
  return entry.activity === "live";
}

function isTerminalOrIdle(entry: FileEntry): boolean {
  const turn = entry.authoritativeTurn?.state;
  if (turn === "terminal" || turn === "idle") return true;
  if (entry.activity === "idle") return true;
  if (entry.proc === "done" || entry.proc === "killed") return true;
  return Boolean(entry.supersededBy);
}

export interface EngineChildContext {
  /** The child carries a durable hand-fold pin (identity-keyed). */
  folded: boolean;
  /** The child is manually placed / expanded / pinned on the board. */
  pinned: boolean;
  now: number;
}

export interface EngineChildClassification {
  presence: TrayPresence;
  reason: PresenceReason;
}

/**
 * The presence precedence for one engine-native child whose host CAN carry a
 * tray. Evaluated top-down, first match wins (the presence policy order):
 *
 * 1. actionable attention → promoted P2 (the fold pin is still retained for
 *    later reuse; the caller keeps it stored).
 * 2. explicit hand-fold → folded P1.
 * 3. owner-authored / authorship-unverified / manual / expanded / pinned →
 *    promoted P2 (exempt from automatic folding).
 * 4. authoritative busy / running process / live activity → promoted P2.
 * 5. authoritative terminal or idle → folded P1 immediately (no idle wait,
 *    independent of transcript age).
 * 6. conflicting or incomplete evidence → fail-visible promoted P2.
 */
export function classifyEngineChild(entry: FileEntry, ctx: EngineChildContext): EngineChildClassification {
  if (engineChildNeedsAttention(entry, ctx.now)) return { presence: "promoted", reason: "attention" };
  if (ctx.folded) return { presence: "folded", reason: "hand-fold" };
  if (entry.userAuthored || entry.authorshipUnverified || ctx.pinned) return { presence: "promoted", reason: "owner" };
  if (isBusy(entry)) return { presence: "promoted", reason: "busy" };
  if (isTerminalOrIdle(entry)) return { presence: "folded", reason: "quiet" };
  return { presence: "promoted", reason: "fail-visible" };
}

export interface TrayMember {
  id: string;
  /** Current-generation transcript PATH — navigation opens exactly this entry
      rather than re-resolving the id against file order (a stale generation). */
  path: string;
  title: string;
  engine: Engine;
  model: string | null;
  state: SubagentBadgeState;
  avatarSeed: string;
}

export interface ParentTray {
  parentConversationId: string;
  /** Folded (P1) members, hottest first then oldest spawn. */
  members: TrayMember[];
  count: number;
  /** Rolled-up hottest state across the folded members (§2.2 roll-up). */
  hottest: SubagentBadgeState;
  /** Durable tray-disclosure intent: the compact rows are expanded in place. */
  expanded: boolean;
}

export interface SubagentTrayInput {
  entries: readonly FileEntry[];
  /** Durable hand-fold pins, keyed by child conversation identity. */
  foldedEngineChildIds: ReadonlySet<string>;
  /** Durable tray-disclosure pins, keyed by parent conversation identity. */
  expandedTrayParentIds: ReadonlySet<string>;
  /** Manual/expanded placement paths — pin a child at P2 (owner intent). */
  pinnedPaths: ReadonlySet<string>;
  /** Durably closed / tombstoned paths (P0) — never ours to place. */
  hiddenPaths: ReadonlySet<string>;
  /** Review / review-history / pipeline-claimed paths — existing surfaces win. */
  claimedPaths: ReadonlySet<string>;
  /** Parent conversation identities whose board card can host a tray. A child
      whose host is missing (hidden, deleted, cross-project, deck-claimed,
      compacted) stays visible through the existing full-node path. */
  hostEligibleParentIds: ReadonlySet<string>;
  now: number;
}

export interface SubagentTrayProjection {
  /** Engine children forced to render as full P2 nodes. */
  promotedPaths: Set<string>;
  /** Engine children folded into a parent tray — excluded from nodes/badges. */
  foldedPaths: Set<string>;
  /** Conversation identities folded into a tray. */
  foldedIds: Set<string>;
  /** One tray per durable parent id that carries at least one folded member. */
  traysByParent: Map<string, ParentTray>;
}

/** The durable parent conversation identity of an engine child. */
export function engineChildParentId(entry: FileEntry, byPath: ReadonlyMap<string, FileEntry>): string | null {
  const durable = entry.durableLineage?.parentConversationId;
  if (durable) return durable;
  if (entry.parent) {
    const parent = byPath.get(entry.parent);
    if (parent) return conversationIdentity(parent);
  }
  return entry.parentRemoved?.conversationId ?? null;
}

function toMember(entry: FileEntry): TrayMember {
  const id = conversationIdentity(entry);
  return {
    id,
    path: entry.path,
    title: entry.title,
    engine: entry.engine,
    model: entry.model,
    state: badgeState(entry),
    avatarSeed: id,
  };
}

function memberOrder(left: TrayMember, right: TrayMember, timeById: ReadonlyMap<string, number>): number {
  return (
    activeRank(left.state) - activeRank(right.state)
    || (timeById.get(left.id) ?? 0) - (timeById.get(right.id) ?? 0)
    || left.id.localeCompare(right.id)
  );
}

/**
 * The presence projection: partition every current-generation engine-native
 * child into promoted nodes and folded tray rows, grouped by durable parent id.
 * This is the single authority consumed by project grouping, layout, badges,
 * the minimap, and mobile.
 */
export function buildSubagentTrays(input: SubagentTrayInput): SubagentTrayProjection {
  const byPath = new Map(input.entries.map((entry) => [entry.path, entry]));
  const byId = new Map<string, FileEntry>();
  for (const entry of input.entries) {
    if (isArchivedPredecessor(entry)) continue;
    const id = conversationIdentity(entry);
    const current = byId.get(id);
    const generation = entry.generation ?? 0;
    const currentGeneration = current?.generation ?? 0;
    if (!current || generation > currentGeneration || (generation === currentGeneration && entry.mtime > current.mtime)) {
      byId.set(id, entry);
    }
  }

  const promotedPaths = new Set<string>();
  const foldedPaths = new Set<string>();
  const foldedIds = new Set<string>();
  const membersByParent = new Map<string, TrayMember[]>();
  const spawnByChildId = new Map<string, number>();

  for (const entry of byId.values()) {
    if (entry.engine === "shell") continue;
    if (!isEngineNativeChild(entry)) continue;
    if (input.hiddenPaths.has(entry.path)) continue;
    if (input.claimedPaths.has(entry.path)) continue;
    const parentId = engineChildParentId(entry, byPath);
    if (!parentId) continue;
    const id = conversationIdentity(entry);
    /* Host ineligible (hidden/deleted/cross-project/deck-claimed/compacted
       parent): the child stays visible through the existing full-node path. */
    if (!input.hostEligibleParentIds.has(parentId)) {
      promotedPaths.add(entry.path);
      continue;
    }
    const classification = classifyEngineChild(entry, {
      folded: input.foldedEngineChildIds.has(id),
      pinned: input.pinnedPaths.has(entry.path),
      now: input.now,
    });
    if (classification.presence === "promoted") {
      promotedPaths.add(entry.path);
      continue;
    }
    foldedPaths.add(entry.path);
    foldedIds.add(id);
    spawnByChildId.set(id, spawnTime(entry));
    const list = membersByParent.get(parentId) ?? [];
    list.push(toMember(entry));
    membersByParent.set(parentId, list);
  }

  const traysByParent = new Map<string, ParentTray>();
  for (const [parentConversationId, members] of membersByParent) {
    members.sort((left, right) => memberOrder(left, right, spawnByChildId));
    traysByParent.set(parentConversationId, {
      parentConversationId,
      members,
      count: members.length,
      hottest: rollUpState(members.map((member) => member.state)),
      expanded: input.expandedTrayParentIds.has(parentConversationId),
    });
  }

  return { promotedPaths, foldedPaths, foldedIds, traysByParent };
}
