import type { AccountProjectOverride } from "./accountOverrides";
import { conversationProjectKey } from "./conversationProject";
import {
  allowedAccountIdsForProject,
  projectsForAccount,
  type AccountProjectBinding,
  type BindingEngine,
} from "./projectBindings";

/** An account as both directions of the relation render it: id plus label. */
export interface BoundAccount {
  accountId: string;
  label: string;
}

/**
 * The project side of #1279's relation, for one engine: which accounts the
 * project may use, and which of them are carrying its work right now.
 *
 * `restricted: false` is the unbound case, and it reports the full account list
 * as allowed rather than an empty one — a project nobody configured may use
 * every account, and the interface has to say that instead of looking fenced.
 */
export interface ProjectEngineAccounts {
  engine: BindingEngine;
  restricted: boolean;
  allowed: BoundAccount[];
  carrying: BoundAccount[];
  /** Accounts a person or an agent deliberately chose from outside the pool,
      newest first, with who chose and when. The pool is a default for what the
      Viewer picks on its own; a choice that reached past it is shown here
      rather than hidden, so an account carrying work it is not bound to reads
      as somebody's decision instead of a fence that stopped holding. */
  outsidePool: OutsidePoolChoice[];
}

export interface OutsidePoolChoice extends BoundAccount {
  at: string;
  actor: "operator" | "agent";
}

/** A live conversation, reduced to what deciding "carrying" needs. */
export interface CarrierConversation {
  engine: BindingEngine;
  project: string | null;
  accountId: string | null;
  busy: boolean;
}

/** A registered conversation, reduced to what the carrier projection reads. */
export interface CarrierSource {
  engine: BindingEngine;
  busy: boolean;
  accountId: string | null;
  ownership: { project?: string | null } | null | undefined;
  launchProfile: { project?: string | null; cwd?: string | null } | null | undefined;
  /** Transcript path, read only to recover an adopted conversation's cwd. */
  path: string;
}

/**
 * Registered conversations reduced to carriers, keyed to their project by the
 * same resolution the fence uses.
 *
 * `projectForTranscript` is the fallback, and it is here for the reason it is
 * at every fence seam: an ADOPTED conversation carries an EMPTY launch profile
 * — no project, no cwd — so a resolution reading only ownership and profile
 * answers null for it, and the account actually carrying the project's work
 * would silently never be marked. The display side has to resolve a project as
 * carefully as the refusal side does, or it under-reports exactly the sessions
 * an operator opens this strip to understand.
 *
 * Only a BUSY conversation with an account can carry anything, so those are the
 * only ones whose project is resolved at all — the fallback reads a transcript
 * head, and paying that per open turn instead of per known conversation is what
 * keeps this cheap on a registry with a long history.
 */
export function carrierConversations(
  sources: readonly CarrierSource[],
  projectForTranscript: (transcript: string) => string | null,
): CarrierConversation[] {
  return sources.flatMap((source) => {
    if (!source.busy || !source.accountId) return [];
    return [{
      engine: source.engine,
      project: conversationProjectKey(source.ownership, source.launchProfile, {
        /* A getter, so conversationProjectKey's own ordering decides whether the
           read happens at all: a conversation that names its project never
           reaches the transcript. */
        get project() { return projectForTranscript(source.path); },
      }),
      accountId: source.accountId,
      busy: true,
    }];
  });
}

/** Accounts with an open turn on this project's work, in id order. */
export function carryingAccountIds(
  conversations: readonly CarrierConversation[],
  project: string,
  engine: BindingEngine,
): string[] {
  return [...new Set(conversations
    .filter((conversation) => conversation.busy
      && conversation.engine === engine
      && conversation.project === project
      && conversation.accountId !== null)
    .map((conversation) => conversation.accountId!))].sort();
}

export function projectEngineAccounts(
  project: string,
  engine: BindingEngine,
  accounts: readonly BoundAccount[],
  bindings: readonly AccountProjectBinding[],
  carriers: readonly string[],
  overrides: readonly AccountProjectOverride[] = [],
): ProjectEngineAccounts {
  const allowedIds = allowedAccountIdsForProject(project, engine, bindings);
  const labels = new Map(accounts.map((account) => [account.accountId, account.label] as const));
  const named = (accountId: string): BoundAccount => ({ accountId, label: labels.get(accountId) ?? accountId });
  /* One row per account, carrying the most recent choice of it: repeating the
     same switch is one fact about that account, not a list the strip grows by. */
  const latestChoice = new Map<string, OutsidePoolChoice>();
  /* A project with no binding for this engine has no pool to be outside of,
     and an account bound since the choice was made is inside it now. Either
     row would claim a boundary that is not there. */
  const pool = allowedIds;
  if (pool !== null) {
    for (const override of overrides) {
      if (override.engine !== engine || override.project !== project || pool.includes(override.accountId)) continue;
      const existing = latestChoice.get(override.accountId);
      if (!existing || existing.at < override.at) {
        latestChoice.set(override.accountId, { ...named(override.accountId), at: override.at, actor: override.actor });
      }
    }
  }
  return {
    engine,
    outsidePool: [...latestChoice.values()].sort((left, right) =>
      right.at.localeCompare(left.at) || left.accountId.localeCompare(right.accountId)),
    restricted: allowedIds !== null,
    /* A bound account the catalog no longer holds still appears, under its own
       id: the binding is what the project is fenced to, and hiding a row the
       fence is still enforcing would make an unrunnable project look open. */
    allowed: allowedIds === null ? accounts.map((account) => named(account.accountId)) : allowedIds.map(named),
    carrying: carriers.map(named),
  };
}

/** The accounts side of the same relation: the projects one account is bound to. */
export function accountProjectRows(
  engine: BindingEngine,
  accountId: string,
  bindings: readonly AccountProjectBinding[],
  displayNames: Readonly<Record<string, string>> = {},
): { project: string; displayName: string }[] {
  return projectsForAccount(engine, accountId, bindings)
    .map((project) => ({ project, displayName: displayNames[project] ?? project }));
}
