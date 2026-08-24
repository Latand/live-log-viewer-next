"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

import type { DeliveredMessageProvenance } from "@/lib/runtime/messageOrigin";
import { messageOriginRole } from "@/lib/runtime/messageOrigin";
import { parseSelectedContextRef } from "@/lib/selection/selectedContext";

import type { FeedEntry } from "./parse";
import { BoundedLru } from "./scrollMemory";

/**
 * Delivery-ledger provenance for the feed (#1117), Claude only: a delivered
 * system row resolves through this lookup into the operator's own bubble or
 * an internal relay card. Codex needs none of this — its authorship rides the
 * structured-user marker the parser already decodes.
 *
 * The lookup travels by context so every FeedItem — focused pane, compact
 * canvas pane — reads the same map without threading a prop through the row
 * tree. A surface that mounts no provider (demo renderer, tests) gets the
 * empty lookup and keeps today's system-row rendering.
 */
export type ProvenanceLookup = (engineMessageId: string | null) => DeliveredMessageProvenance | null;

const NO_PROVENANCE: ProvenanceLookup = () => null;
const ProvenanceContext = createContext<ProvenanceLookup>(NO_PROVENANCE);
export const MessageProvenanceProvider = ProvenanceContext.Provider;

export function useMessageProvenance(): ProvenanceLookup {
  return useContext(ProvenanceContext);
}

type ProvenanceMap = Record<string, DeliveredMessageProvenance>;

/* Browser-wide, so a revisited conversation answers from memory and a pane
   remount does not refetch what it already resolved. Entries only grow: a
   ledger's queued→delivered records are immutable once written. */
const PROVENANCE_CACHE_PATHS = 48;
const provenanceCache = new BoundedLru<ProvenanceMap>(PROVENANCE_CACHE_PATHS);

export function resetMessageProvenanceCacheForTests(): void {
  provenanceCache.clear();
}

function parseProvenanceMessages(value: unknown): ProvenanceMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const parsed: ProvenanceMap = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!id || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const body = entry as Record<string, unknown>;
    if (body.origin !== "operator" && body.origin !== "agent") continue;
    const senderRole = messageOriginRole(body.senderRole);
    const selectedContext = parseSelectedContextRef(body.selectedContext);
    parsed[id] = {
      origin: body.origin,
      ...(senderRole ? { senderRole } : {}),
      ...(selectedContext ? { selectedContext } : {}),
    };
  }
  return parsed;
}

/** The delivered engine ids the current window still needs evidence for —
    the ONLY trigger for a fetch, so an idle pane never polls. */
function deliveredIdsKey(items: readonly FeedEntry[]): string {
  const ids: string[] = [];
  for (const { item } of items) {
    if (item.kind === "sysmsg" && item.deliveredMessage?.engineMessageId) {
      ids.push(item.deliveredMessage.engineMessageId);
    }
  }
  return ids.join("\n");
}

/**
 * Fetches `/api/log/provenance` for a Claude transcript whenever the window
 * shows a delivered row the cache cannot resolve yet. Failures stay quiet —
 * a row without evidence renders exactly as it does today.
 */
export function useDeliveredMessageProvenance(path: string | null, items: readonly FeedEntry[]): ProvenanceLookup {
  const wantedKey = useMemo(() => (path ? deliveredIdsKey(items) : ""), [path, items]);
  const [map, setMap] = useState<ProvenanceMap | null>(() => (path ? provenanceCache.get(path) ?? null : null));
  useEffect(() => {
    if (!path) return;
    const cached = provenanceCache.get(path) ?? null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync to the path's cache entry on path change
    setMap(cached);
    if (!wantedKey) return;
    const missing = wantedKey.split("\n").some((id) => id && !(cached && id in cached));
    if (!missing) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`/api/log/provenance?path=${encodeURIComponent(path)}`);
        if (!res.ok) return;
        const json = (await res.json()) as { messages?: unknown };
        const merged = { ...(provenanceCache.get(path) ?? {}), ...parseProvenanceMessages(json.messages) };
        provenanceCache.set(path, merged);
        if (alive) setMap(merged);
      } catch {
        /* quiet: absence renders as today's system row */
      }
    })();
    return () => {
      alive = false;
    };
  }, [path, wantedKey]);
  return useMemo<ProvenanceLookup>(
    () => (engineMessageId) => (engineMessageId && map ? map[engineMessageId] ?? null : null),
    [map],
  );
}
