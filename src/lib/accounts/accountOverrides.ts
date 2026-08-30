import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";

import { explicitAccountChoice, type BindingEngine } from "./projectBindings";

/**
 * Attribution for account choices made OUTSIDE a project's pool (issue #1279).
 *
 * The binding is a default for what the Viewer picks on its own, not a veto on
 * what a person or an agent asks for. Automatic selection — the one-click
 * reseat, and anything the system decides for itself when a limit is reached —
 * draws only from the pool and reports a shortage rather than crossing it. A
 * DELIBERATE choice that names an account is a capability and is carried out,
 * including when the named account is outside the pool.
 *
 * What that costs is a record. Every out-of-pool choice is appended here with
 * who made it, when, for which project, and what the pool was at that moment,
 * and the project view renders it beside the pool, so an account carrying work
 * it is not bound to is visibly a decision somebody made rather than a fence
 * that quietly stopped holding.
 *
 * This journal is a REPORT, never an input to a decision. Nothing reads it to
 * decide whether an account may be used, which is why a damaged or absent one
 * answers with an empty list instead of throwing the way the binding record
 * does: an unreadable log must not be able to park work, and cannot widen
 * anything either, because no fence consults it.
 */

const RECORD_NAME = "account-project-overrides.json";
/** Entries retained; the oldest are dropped. The panel shows the newest few. */
const CAPACITY = 200;

export type AccountChoiceActor =
  | { kind: "operator" }
  | { kind: "agent"; conversationId: string };

/** The control the choice came through, so the record names the gesture. */
export type AccountChoiceVia = "structured-reconfigure" | "conversation-switch";

/** Why the choice was outside the pool the project's work is normally drawn from. */
export type AccountOverrideReason =
  /** The project is bound and the named account is not in its set. */
  | "outside-pool"
  /** The binding record could not be read, so no pool could be shown. The
      choice still stands: a damaged record fails closed for the machine's own
      selection and must not veto a person's. */
  | "binding-unreadable";

export interface AccountProjectOverride {
  at: string;
  engine: BindingEngine;
  project: string | null;
  accountId: string;
  /** The pool as it read at that moment; null when the record was unreadable. */
  allowedAccountIds: string[] | null;
  reason: AccountOverrideReason;
  actor: "operator" | "agent";
  /** The agent's own conversation, when an agent made the choice. */
  actorConversationId: string | null;
  /** The conversation whose account was changed. */
  conversationId: string | null;
  via: AccountChoiceVia;
}

interface OverrideFile {
  schemaVersion: 1;
  overrides: AccountProjectOverride[];
}

export interface NamedAccountChoice {
  engine: BindingEngine;
  project: string | null;
  accountId: string;
  conversationId: string | null;
  actor: AccountChoiceActor;
  via: AccountChoiceVia;
  now?: () => string;
}

/**
 * What a caller is told about its own out-of-pool choice, so the answer to the
 * gesture says plainly what was done rather than leaving it to the panel.
 */
export interface AccountOverrideNotice {
  outsidePool: true;
  accountId: string;
  project: string | null;
  allowedAccountIds: string[] | null;
  reason: AccountOverrideReason;
  actor: "operator" | "agent";
  at: string;
  /** False when the choice stands but the journal write did not land. */
  recorded: boolean;
  /** Why the record did not land, present only then, so the answer to the
      gesture can say that this choice will not be visible afterwards. */
  recordFailure?: string;
}

function overridesFile(): string {
  return statePath(RECORD_NAME);
}

function overrideList(value: unknown): AccountProjectOverride[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.at !== "string" || !record.at
      || (record.engine !== "claude" && record.engine !== "codex")
      || typeof record.accountId !== "string" || !record.accountId) return [];
    const allowed = Array.isArray(record.allowedAccountIds)
      ? record.allowedAccountIds.filter((id): id is string => typeof id === "string")
      : null;
    return [{
      at: record.at,
      engine: record.engine,
      project: typeof record.project === "string" && record.project ? record.project : null,
      accountId: record.accountId,
      allowedAccountIds: allowed,
      reason: record.reason === "binding-unreadable" ? "binding-unreadable" : "outside-pool",
      actor: record.actor === "agent" ? "agent" : "operator",
      actorConversationId: typeof record.actorConversationId === "string" && record.actorConversationId
        ? record.actorConversationId
        : null,
      conversationId: typeof record.conversationId === "string" && record.conversationId ? record.conversationId : null,
      via: record.via === "conversation-switch" ? "conversation-switch" : "structured-reconfigure",
    }];
  });
}

/** The journal as it stands. A file this process cannot read reports nothing. */
function readOverrides(): AccountProjectOverride[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(overridesFile(), "utf8")) as Partial<OverrideFile> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return overrideList(parsed.overrides);
  } catch {
    return [];
  }
}

export interface AccountOverrideQuery {
  project?: string | null;
  engine?: BindingEngine;
  conversationId?: string;
  limit?: number;
}

/** Recorded out-of-pool choices, newest first. */
export function accountProjectOverrides(query: AccountOverrideQuery = {}): AccountProjectOverride[] {
  const matched = readOverrides().filter((override) =>
    (query.project === undefined || override.project === query.project)
    && (query.engine === undefined || override.engine === query.engine)
    && (query.conversationId === undefined || override.conversationId === query.conversationId));
  const newestFirst = matched.reverse();
  return query.limit === undefined ? newestFirst : newestFirst.slice(0, Math.max(0, query.limit));
}

/**
 * Appends one record, and names the failure when it could not. The caller's
 * choice still stands — attribution that failed to write is not a reason to
 * refuse a gesture the operator is entitled to make — but the failure is
 * carried out of here rather than reduced to a bare false: a switch nobody can
 * see afterwards is the thing this journal exists to prevent, so the one
 * condition that produces it has to arrive somewhere a person reads.
 *
 * There is no retry here on purpose. The write already queues behind the
 * journal's file transaction for as long as that transaction waits, so what
 * reaches this catch is a durable failure of the state directory itself —
 * unwritable, full, gone — and repeating it changes nothing except how long
 * the switch takes to answer.
 */
function appendOverride(override: AccountProjectOverride): { ok: true } | { ok: false; reason: string } {
  const file = overridesFile();
  try {
    return withFileTransactionSync(file, "the account override journal is busy", () => {
      const next = [...readOverrides(), override].slice(-CAPACITY);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeJsonDurably(file, { schemaVersion: 1, overrides: next } satisfies OverrideFile);
      return { ok: true } as const;
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Classifies a deliberate named-account choice and, when it falls outside the
 * project's pool, records who made it. Returns null for a choice inside the
 * pool or on an unbound project: there is nothing to attribute, and every
 * caller's behaviour there is exactly what it always was.
 *
 * Both explicit switch seams call THIS, so neither can drift into refusing what
 * the other allows. Both call it AFTER their switch has been accepted, which is
 * what makes the record a statement about something that happened: an attempt
 * attributed before authentication, reservation and dispatch left the panel
 * showing an out-of-pool choice that was refused a moment later.
 *
 * A journal that would not take the record does not pass quietly. The notice
 * says `recorded: false` and carries the reason, the caller's answer carries it
 * to whoever made the choice, and the failure is logged here so it is on the
 * Viewer's own record even when nobody is watching the answer.
 */
export function attributeNamedAccountChoice(choice: NamedAccountChoice): AccountOverrideNotice | null {
  const classified = explicitAccountChoice(choice.project, choice.engine, choice.accountId);
  if (classified.kind === "within-pool") return null;
  const at = (choice.now ?? (() => new Date().toISOString()))();
  const override: AccountProjectOverride = {
    at,
    engine: choice.engine,
    project: choice.project,
    accountId: choice.accountId,
    allowedAccountIds: classified.kind === "outside-pool" ? classified.allowedAccountIds : null,
    reason: classified.kind === "outside-pool" ? "outside-pool" : "binding-unreadable",
    actor: choice.actor.kind,
    actorConversationId: choice.actor.kind === "agent" ? choice.actor.conversationId : null,
    conversationId: choice.conversationId,
    via: choice.via,
  };
  const stored = appendOverride(override);
  if (!stored.ok) {
    console.warn("[account-override] an out-of-pool account choice was carried out but not recorded", {
      engine: override.engine,
      project: override.project,
      via: override.via,
      actor: override.actor,
      reason: stored.reason,
    });
  }
  return {
    outsidePool: true,
    accountId: override.accountId,
    project: override.project,
    allowedAccountIds: override.allowedAccountIds,
    reason: override.reason,
    actor: override.actor,
    at,
    recorded: stored.ok,
    ...(stored.ok ? {} : { recordFailure: stored.reason }),
  };
}
