import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { pidAlive } from "@/lib/scanner/process";
import { agentRegistry, type ConversationLookup } from "@/lib/agent/registry";
import { forEachCooperatively } from "@/lib/cooperative";

/**
 * Compatibility lineage for older handoffs. Viewer spawns now commit a durable
 * conversation edge in the agent registry at intent creation. This store keeps
 * historical transcript edges and live pane-pid evidence readable while those
 * sessions age out.
 */
const LINEAGE_FILE = statePath("handoff-lineage.json");
const MAX_CHILDREN = 20_000;

export interface HandoffLineageStoreShape {
  panes?: Record<string, string>;
  children?: Record<string, string>;
  conversationChildren?: Record<string, string>;
}

/** Pane pid of a handoff window → source transcript, while the pane lives. */
let panes: Map<number, string> | null = null;
/** New conversation transcript → source transcript, durable. */
let children: Map<string, string> | null = null;
let conversationChildren: Map<string, string> | null = null;
let dirty = false;

export function normalizeHandoffLineageStore(
  stored: HandoffLineageStoreShape,
  pidIsAlive: (pid: number) => boolean = pidAlive,
): { panes: Map<number, string>; children: Map<string, string>; conversationChildren: Map<string, string>; dirty: boolean } {
  const nextPanes = new Map<number, string>();
  const nextChildren = new Map<string, string>();
  const nextConversationChildren = new Map<string, string>();
  for (const [pidRaw, parent] of Object.entries(stored.panes ?? {})) {
    const pid = Number(pidRaw);
    /* A dead pane pid can only match again after the OS reuses it — drop it. */
    if (Number.isInteger(pid) && pid > 0 && typeof parent === "string" && pidIsAlive(pid)) nextPanes.set(pid, parent);
  }
  for (const [child, parent] of Object.entries(stored.children ?? {})) {
    if (typeof parent === "string") nextChildren.set(child, parent);
  }
  for (const [child, parent] of Object.entries(stored.conversationChildren ?? {})) {
    if (child.startsWith("conversation_") && parent.startsWith("conversation_")) nextConversationChildren.set(child, parent);
  }
  const storedSize = Object.keys(stored.panes ?? {}).length + Object.keys(stored.children ?? {}).length + Object.keys(stored.conversationChildren ?? {}).length;
  return { panes: nextPanes, children: nextChildren, conversationChildren: nextConversationChildren, dirty: nextPanes.size + nextChildren.size + nextConversationChildren.size !== storedSize };
}

function load(): { panes: Map<number, string>; children: Map<string, string>; conversationChildren: Map<string, string> } {
  if (panes && children && conversationChildren) return { panes, children, conversationChildren };
  let stored: HandoffLineageStoreShape = {};
  try {
    stored = JSON.parse(fs.readFileSync(LINEAGE_FILE, "utf8")) as HandoffLineageStoreShape;
  } catch {
    /* first run or unreadable cache: start empty */
  }
  const normalized = normalizeHandoffLineageStore(stored);
  panes = normalized.panes;
  children = normalized.children;
  conversationChildren = normalized.conversationChildren;
  if (normalized.dirty) dirty = true;
  return { panes, children, conversationChildren };
}

/** Records that the pane just booted for a handoff descends from `parent`. */
export function rememberHandoffPane(panePid: number, parent: string): void {
  if (!Number.isInteger(panePid) || panePid <= 0) return;
  const store = load();
  if (store.panes.get(panePid) === parent) return;
  store.panes.set(panePid, parent);
  dirty = true;
  persistHandoffLineage();
}

/** Source transcript of the handoff pane `pid` belongs to, if any. */
export function handoffParentForPid(pid: number): string | null {
  return load().panes.get(pid) ?? null;
}

export function rememberHandoffChild(child: string, parent: string): void {
  const store = load();
  if (store.children.get(child) === parent) return;
  store.children.set(child, parent);
  /* Map keeps insertion order, so the oldest links fall out first. */
  while (store.children.size > MAX_CHILDREN) {
    const oldest = store.children.keys().next().value;
    if (oldest === undefined) break;
    store.children.delete(oldest);
  }
  dirty = true;
}

/** Previously proven handoff source of the `child` transcript, if any. */
export function handoffParentForChild(child: string): string | null {
  return load().children.get(child) ?? null;
}

export function handoffParentConversation(childConversationId: string): string | null {
  return load().conversationChildren.get(childConversationId) ?? null;
}

export function reconcileHandoffConversationOwnership(registry: ConversationLookup = agentRegistry()): void {
  const store = load();
  let changed = false;
  for (const [childPath, parentPath] of store.children) {
    const child = registry.conversationForPath(childPath);
    const parent = registry.conversationForPath(parentPath);
    if (!child || !parent || store.conversationChildren.get(child.id) === parent.id) continue;
    store.conversationChildren.set(child.id, parent.id);
    changed = true;
  }
  if (changed) { dirty = true; persistHandoffLineage(); }
}

export async function reconcileHandoffConversationOwnershipCooperatively(registry: ConversationLookup = agentRegistry()): Promise<void> {
  const store = load();
  let changed = false;
  await forEachCooperatively([...store.children], ([childPath, parentPath]) => {
    const child = registry.conversationForPath(childPath);
    const parent = registry.conversationForPath(parentPath);
    if (!child || !parent || store.conversationChildren.get(child.id) === parent.id) return;
    store.conversationChildren.set(child.id, parent.id);
    changed = true;
  });
  if (changed) { dirty = true; persistHandoffLineage(); }
}

export function persistHandoffLineage(): void {
  if (!dirty) return;
  dirty = false;
  const store = load();
  try {
    fs.mkdirSync(path.dirname(LINEAGE_FILE), { recursive: true });
    fs.writeFileSync(
      LINEAGE_FILE,
      JSON.stringify({
        panes: Object.fromEntries([...store.panes].map(([pid, parent]) => [String(pid), parent])),
        children: Object.fromEntries(store.children),
        conversationChildren: Object.fromEntries(store.conversationChildren),
      }),
    );
  } catch {
    /* best-effort: a lost cache only costs one unlinked handoff */
  }
}
