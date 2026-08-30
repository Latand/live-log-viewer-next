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
}

/** A live conversation, reduced to what deciding "carrying" needs. */
export interface CarrierConversation {
  engine: BindingEngine;
  project: string | null;
  accountId: string | null;
  busy: boolean;
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
): ProjectEngineAccounts {
  const allowedIds = allowedAccountIdsForProject(project, engine, bindings);
  const labels = new Map(accounts.map((account) => [account.accountId, account.label] as const));
  const named = (accountId: string): BoundAccount => ({ accountId, label: labels.get(accountId) ?? accountId });
  return {
    engine,
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
