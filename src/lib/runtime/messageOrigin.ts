/**
 * Who authored a structured/MCP-delivered message (#1117).
 *
 * Every structured delivery flows through one admission chokepoint, and the
 * feed cannot tell the operator's own words from inter-agent relays without a
 * durable authorship fact stamped there. This module is that fact's vocabulary:
 *
 *  - `operator` — typed (or spoken) by the human on a Viewer surface.
 *  - `agent`    — sent by another session through MCP `send_message`, a flow
 *    relay, or a delegated spawn's first message. `role` names the sender as
 *    the server attributed it (orchestrator, reviewer, a role preset id, …).
 *
 * Scaffold rows carry NO origin: absence means "no delivery evidence", and the
 * feed keeps rendering such rows exactly as before. Classification must never
 * guess, so parsing drops anything it cannot validate; nothing is coerced.
 *
 * Pure and dependency-free on purpose: the Codex marker decode runs in the
 * browser feed parser, so this module must not pull in Node-only helpers.
 */

import type { SelectedContextRef } from "@/lib/selection/selectedContext";

export interface MessageOrigin {
  kind: "operator" | "agent";
  /** Sender role for agent origins, as attributed server-side at admission.
      Bounded to one marker-safe token so it can ride the structured-user
      marker and a journaled ledger record without a second escaping scheme. */
  role?: string;
}

/**
 * The feed-facing authorship of one delivered message, keyed by the transcript
 * row's engine message id: the wire shape of `/api/log/provenance` and the
 * value the renderer resolves a delivered system row with. Client-safe on
 * purpose — the server join module and the browser share this one type.
 */
export interface DeliveredMessageProvenance {
  origin: "operator" | "agent";
  senderRole?: string;
  /** Carried through for operator rows so the bubble renders the same
      selected-card badge the composer showed at submission (#844). */
  selectedContext?: SelectedContextRef;
}

/**
 * One delivered message's occurrence evidence: the join for deliveries that
 * leave no per-row identity — a legacy tmux paste on either engine, a flow
 * relay, a pre-#1117 structured send. `textDigest` is the registry's content
 * digest of the delivered text (see `messageTextDigest`) and `deliveredAt`
 * its settlement time, so the feed can attach the evidence to exactly ONE
 * transcript row: the nearest-in-time row carrying the same text. The time is
 * what makes the join occurrence-specific — an operator's own message that
 * happens to repeat a relay's text stays the operator's.
 */
export interface DeliveredMessageOccurrence extends DeliveredMessageProvenance {
  textDigest: string;
  deliveredAt: string;
}

/** Same grammar as the other opaque marker tokens: no whitespace, no `>`. */
const ROLE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;

export function messageOriginRole(value: unknown): string | undefined {
  return typeof value === "string" && ROLE_TOKEN.test(value) ? value : undefined;
}

/**
 * Validate an untrusted origin — a request body, a journal payload, a replayed
 * record. Returns null when the value is not an origin at all; a corrupt role
 * costs only the role, never the record's authorship kind.
 */
export function parseMessageOrigin(value: unknown): MessageOrigin | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.kind !== "operator" && body.kind !== "agent") return null;
  const role = body.kind === "agent" ? messageOriginRole(body.role) : undefined;
  return { kind: body.kind, ...(role ? { role } : {}) };
}
