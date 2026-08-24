"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

import type { DeliveredMessageProvenance } from "@/lib/runtime/messageOrigin";
import { messageOriginRole } from "@/lib/runtime/messageOrigin";
import { parseSelectedContextRef } from "@/lib/selection/selectedContext";

import type { FeedEntry } from "./parse";
import { BoundedLru } from "./scrollMemory";

/**
 * Delivery-evidence provenance for the feed (#1117): a delivered Claude
 * "system" row resolves by its engine message id into the operator's own
 * bubble or an internal relay card, and a flow-relayed message — legacy tmux
 * paste on either engine, or a pre-#1117 structured relay — resolves by its
 * own text against the flow store's reconstruction of what was relayed.
 * Codex structured rows need neither join: their authorship rides the
 * structured-user marker the parser already decodes.
 *
 * The lookup travels by context so every FeedItem — focused pane, compact
 * canvas pane — reads the same map without threading a prop through the row
 * tree. A surface that mounts no provider (demo renderer, tests) gets the
 * empty lookup and keeps today's rendering.
 */
export interface ProvenanceLookup {
  byId(engineMessageId: string | null): DeliveredMessageProvenance | null;
  byText(text: string): DeliveredMessageProvenance | null;
}

export const NO_PROVENANCE: ProvenanceLookup = { byId: () => null, byText: () => null };
const ProvenanceContext = createContext<ProvenanceLookup>(NO_PROVENANCE);
export const MessageProvenanceProvider = ProvenanceContext.Provider;

export function useMessageProvenance(): ProvenanceLookup {
  return useContext(ProvenanceContext);
}

type ProvenanceMap = Record<string, DeliveredMessageProvenance>;
interface PathProvenance {
  messages: ProvenanceMap;
  relayedTexts: ProvenanceMap;
}

/* Browser-wide, so a revisited conversation answers from memory and a pane
   remount does not refetch what it already resolved. Entries only grow: a
   ledger's queued→delivered records and a settled flow round are immutable
   once written. */
const PROVENANCE_CACHE_PATHS = 48;
const provenanceCache = new BoundedLru<PathProvenance>(PROVENANCE_CACHE_PATHS);

/** The ledger can record a delivery's engine message id AFTER the transcript
    row is already visible, so an unresolved id revalidates on this bounded
    schedule instead of waiting for a remount. Historical rows that will never
    resolve cost exactly this many extra fetches per pane, then stop. */
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1_500, 4_000, 10_000];
let retryDelaysMs = DEFAULT_RETRY_DELAYS_MS;

export function resetMessageProvenanceCacheForTests(): void {
  provenanceCache.clear();
}

export function setMessageProvenanceRetryScheduleForTests(delays: readonly number[] | null): void {
  retryDelaysMs = delays ?? DEFAULT_RETRY_DELAYS_MS;
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

/** Short stable digest so a long row text contributes a bounded token to the
    trigger key. Collisions only cost a skipped refetch, never a wrong join —
    resolution always compares the full text. */
function textToken(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
  }
  return `t${hash.toString(16)}:${text.length}`;
}

interface WantedEvidence {
  /** Delivered engine ids still unresolved — the only revalidation driver. */
  ids: string[];
  /** Trimmed texts of rows a relay join could reclassify. */
  texts: string[];
}

/** The evidence the current window could still use — the ONLY trigger for a
    fetch, so an idle pane never polls. */
function wantedEvidence(items: readonly FeedEntry[]): WantedEvidence {
  const ids: string[] = [];
  const texts: string[] = [];
  for (const { item } of items) {
    if (item.kind === "sysmsg" && item.deliveredMessage?.engineMessageId) {
      ids.push(item.deliveredMessage.engineMessageId);
      const trimmed = item.text.trim();
      if (trimmed) texts.push(trimmed);
    } else if (item.kind === "user" && !item.selectedContext) {
      const trimmed = item.text.trim();
      if (trimmed) texts.push(trimmed);
    }
  }
  return { ids, texts };
}

function lookupFor(data: PathProvenance | null): ProvenanceLookup {
  if (!data) return NO_PROVENANCE;
  return {
    byId: (engineMessageId) => (engineMessageId ? data.messages[engineMessageId] ?? null : null),
    byText: (text) => {
      const trimmed = text.trim();
      return trimmed ? data.relayedTexts[trimmed] ?? null : null;
    },
  };
}

/**
 * Fetches `/api/log/provenance` whenever the window shows a row the cache
 * cannot resolve yet, and revalidates unresolved delivered ids on the bounded
 * schedule above (the transcript row can appear before the ledger records its
 * engine message id). Failures stay quiet — a row without evidence renders
 * exactly as it does today.
 */
export function useDeliveredMessageProvenance(path: string | null, items: readonly FeedEntry[]): ProvenanceLookup {
  const wanted = useMemo<WantedEvidence>(
    () => (path ? wantedEvidence(items) : { ids: [], texts: [] }),
    [path, items],
  );
  const wantedKey = useMemo(
    () => [...wanted.ids, ...wanted.texts.map(textToken)].join("\n"),
    [wanted],
  );
  /* The fetch effect keys on the bounded `wantedKey`, not on `wanted` (whose
     identity changes every poll tick and would kill the retry timer); the ref
     hands it the equivalent current evidence for the same key. */
  const wantedRef = useRef<WantedEvidence>(wanted);
  useEffect(() => {
    wantedRef.current = wanted;
  }, [wanted]);
  const [data, setData] = useState<PathProvenance | null>(() => (path ? provenanceCache.get(path) ?? null : null));
  useEffect(() => {
    if (!path) return;
    const cached = provenanceCache.get(path) ?? null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync to the path's cache entry on path change
    setData(cached);
    if (!wantedKey) return;
    const wanted = wantedRef.current;
    const missing = wanted.ids.some((id) => !(cached && id in cached.messages))
      || wanted.texts.some((text) => !(cached && text in cached.relayedTexts));
    if (!missing) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const attempt = async (retry: number): Promise<void> => {
      try {
        const res = await fetch(`/api/log/provenance?path=${encodeURIComponent(path)}`);
        if (!res.ok) return;
        const json = (await res.json()) as { messages?: unknown; relayedTexts?: unknown };
        const previous = provenanceCache.get(path);
        const merged: PathProvenance = {
          messages: { ...(previous?.messages ?? {}), ...parseProvenanceMessages(json.messages) },
          relayedTexts: { ...(previous?.relayedTexts ?? {}), ...parseProvenanceMessages(json.relayedTexts) },
        };
        provenanceCache.set(path, merged);
        if (!alive) return;
        setData(merged);
        const unresolvedIds = wanted.ids.some((id) => !(id in merged.messages));
        if (unresolvedIds && retry < retryDelaysMs.length) {
          timer = setTimeout(() => void attempt(retry + 1), retryDelaysMs[retry]);
        }
      } catch {
        /* quiet: absence renders as today's row */
      }
    };
    void attempt(0);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [path, wantedKey]);
  return useMemo(() => lookupFor(data), [data]);
}
