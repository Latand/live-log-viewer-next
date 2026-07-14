"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import {
  deriveSessionState,
  emptyStore,
  hasBlockingAttention,
  openAttentions,
  type ConnectionState,
  type OperationKind,
  type RuntimeAttention,
  type RuntimeReceipt,
  type RuntimeSession,
  type RuntimeStore,
  type SessionUiState,
} from "@/components/runtime/runtimeModel";

import type { Flow } from "@/lib/flows/types";

import { getRuntimeBus, isRuntimeUiEnabled, type RuntimeBus, type RuntimeBusState } from "./runtimeBus";

const INERT: RuntimeBusState = {
  store: emptyStore(),
  connection: "offline",
  resyncedAt: null,
  lastEventAt: null,
  enabled: false,
  structuredHostsEnabled: false,
};

/**
 * Subscribe React to the tab-wide runtime bus. Inert (and never connects) while
 * the landing-disabled flag is off, so mounting this in the tree is a no-op
 * until slice-one is switched on. Starts the singleton on first mount and
 * leaves it running for the tab (other consumers share it).
 */
export function useRuntimeBusState(): RuntimeBusState {
  const enabled = isRuntimeUiEnabled();
  const bus: RuntimeBus | null = enabled && typeof window !== "undefined" ? getRuntimeBus() : null;

  useEffect(() => {
    if (bus) bus.start();
  }, [bus]);

  const subscribe = useCallback(
    (listener: () => void) => (bus ? bus.subscribe(listener) : () => {}),
    [bus],
  );
  const getSnapshot = useCallback(() => (bus ? bus.getState() : INERT), [bus]);
  return useSyncExternalStore(subscribe, getSnapshot, () => INERT);
}

export interface RuntimeView {
  enabled: boolean;
  structuredHostsEnabled: boolean;
  connection: ConnectionState;
  resyncedAt: number | null;
  store: RuntimeStore;
}

export function useRuntime(): RuntimeView {
  const state = useRuntimeBusState();
  return {
    enabled: state.enabled,
    structuredHostsEnabled: state.structuredHostsEnabled,
    connection: state.connection,
    resyncedAt: state.resyncedAt,
    store: state.store,
  };
}

export interface RuntimeSessionView {
  session: RuntimeSession;
  uiState: SessionUiState;
  attentions: RuntimeAttention[];
  receipts: RuntimeReceipt[];
  legacy: boolean;
  structuredControlsEnabled: boolean;
}

/** Derived view for one hosted session, or null when the bus doesn't carry it. */
export function useRuntimeSession(conversationId: string | null): RuntimeSessionView | null {
  const { store, structuredHostsEnabled } = useRuntime();
  return useMemo(() => {
    if (!conversationId) return null;
    const session = store.sessions[conversationId];
    if (!session) return null;
    const attentions = openAttentions(store, session);
    return {
      session,
      uiState: deriveSessionState(session, hasBlockingAttention(store, session)),
      attentions,
      receipts: session.recentReceipts,
      legacy: session.hostKind === "tmux-legacy",
      structuredControlsEnabled: structuredHostsEnabled,
    };
  }, [store, structuredHostsEnabled, conversationId]);
}

/**
 * Durable receipts for the hosted session backing a transcript path, newest
 * first. Empty while the bus is off or no hosted session carries that artifact
 * — so a legacy/unhosted composer shows nothing new.
 */
export function useRuntimeReceiptsForArtifact(path: string | null, conversationId?: string | null): RuntimeReceipt[] {
  const { store, enabled } = useRuntime();
  return useMemo(() => {
    if (!enabled || (!path && !conversationId)) return [];
    const session = (conversationId ? store.sessions[conversationId] : undefined)
      ?? Object.values(store.sessions).find((s) => s.artifactPath === path);
    return session ? session.recentReceipts : [];
  }, [store, enabled, path, conversationId]);
}

/**
 * The runtime bus's copy of a flow, or null when the bus is off or doesn't
 * carry it. Event-driven flow progression (`flow.state`) lands here first;
 * consumers overlay it on the polled flow so the strip moves on each push
 * without waiting out the poll interval (bus revision wins — Fable precedence).
 */
export function useRuntimeFlow(flowId: string | null): Flow | null {
  const { store, enabled } = useRuntime();
  return useMemo(() => (enabled && flowId ? store.flows[flowId] ?? null : null), [store, enabled, flowId]);
}

/* ------------------------------------------------------------------ *
 * Command helpers (idempotent) — the composers mint the key           *
 * ------------------------------------------------------------------ */

export interface CommandResult {
  ok: boolean;
  operationId?: string;
  receipt?: RuntimeReceipt;
  status?: number;
  error?: string;
}

async function postCommand(url: string, body: unknown): Promise<CommandResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { operationId?: string; receipt?: RuntimeReceipt; error?: string };
    if (!res.ok) return { ok: false, status: res.status, error: json.error };
    return { ok: true, operationId: json.operationId, receipt: json.receipt, status: res.status };
  } catch {
    return { ok: false, error: "network" };
  }
}

export interface SendOptions {
  conversationId: string;
  text: string;
  idempotencyKey: string;
  policy?: "queue" | "steer-if-active";
  images?: string[];
  kind?: OperationKind;
}

/** Send/steer a message. Replaying the same key returns the original receipt
 *  server-side — never a second send. */
export function sendRuntimeMessage(options: SendOptions): Promise<CommandResult> {
  return postCommand("/api/runtime/send", {
    conversationId: options.conversationId,
    text: options.text,
    images: options.images,
    idempotencyKey: options.idempotencyKey,
    policy: options.policy ?? "steer-if-active",
  });
}

export function interruptRuntime(conversationId: string, operationId: string): Promise<CommandResult> {
  return postCommand("/api/runtime/interrupt", { conversationId, operationId });
}

export function answerRuntime(conversationId: string, attentionId: string, resolution: unknown, operationId: string): Promise<CommandResult> {
  return postCommand("/api/runtime/answer", { conversationId, attentionId, resolution, operationId });
}
