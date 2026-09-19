"use client";

import { useEffect, useSyncExternalStore } from "react";

import type { RuntimeSession } from "@/lib/runtime/contracts";
import type { FileEntry } from "@/lib/types";

/*
 * #1846: the account an operator just picked for a conversation, shared by
 * every surface on the page that names that conversation's account — the
 * runtime pill and its sheet, the phone's conversation header, the card's
 * account badge. A tap on any of them writes here, and all of them say
 * «runs on A · next on B» in the same frame, before the server has answered.
 *
 * It only bridges the gap until the runtime session projects the same choice
 * (its pending reconfigure), which every other page reads too; once the
 * projection agrees, or the conversation has moved, the local pick retires.
 */

const picks = new Map<string, string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function readPickedAccount(key: string): string | null {
  return picks.get(key) ?? null;
}

export function setPickedAccount(key: string, accountId: string | null): void {
  if ((picks.get(key) ?? null) === accountId) return;
  if (accountId === null) picks.delete(key);
  else picks.set(key, accountId);
  for (const listener of listeners) listener();
}

export function resetPickedAccountsForTests(): void {
  picks.clear();
  for (const listener of listeners) listener();
}

export interface IntendedAccount {
  /** The account the conversation runs on now. */
  runsOn: string;
  /** Where its next message goes: the picked account while one waits, else `runsOn`. */
  next: string;
}

/**
 * The conversation's account as the operator sees it. `projected` is the
 * account the runtime session's pending reconfigure carries, when it carries one.
 */
export function useIntendedAccount(key: string, runsOn: string, projected: string | null | undefined): IntendedAccount {
  const picked = useSyncExternalStore(subscribe, () => readPickedAccount(key), () => null);
  const projectedNext = projected && projected !== runsOn ? projected : runsOn;
  useEffect(() => {
    if (picked !== null && picked === projectedNext) setPickedAccount(key, null);
  }, [key, picked, projectedNext]);
  return { runsOn, next: picked ?? projectedNext };
}

/**
 * The pick the runtime session projects has been engaged by a message and is moving the conversation now.
 * It can no longer be taken back from an account surface, so none of them offers «cancel switch» for it; the
 * reconfigure route refuses that too (the board cancels a claimed switch through the migration, #1705).
 * The registry's claim counts as well as the receipt: a move waiting on its migration puts the receipt back
 * to `queued` while the claim still holds it.
 */
export function pickApplying(
  session: Pick<RuntimeSession, "pendingReconfigure" | "recentReceipts"> | null | undefined,
  file?: Pick<FileEntry, "switchApplying"> | null,
): boolean {
  const pending = session?.pendingReconfigure;
  if (!pending?.accountId) return false;
  if (file?.switchApplying?.operationId === pending.operationId) return true;
  return (session?.recentReceipts ?? []).some((receipt) => receipt.operationId === pending.operationId && receipt.status === "applying");
}

/** A pick the delivery queue withdrew (the operator took it back) or replaced with a later one: settled, never a failure. */
export function isQuietReconfigureFailure(reason: string | null | undefined): boolean {
  return reason === "cancelled" || reason === "superseded";
}

/* «Pick another account» on a held message sits apart from the runtime pill that owns the account choice;
   it asks that pill to open, by conversation. */
const choiceRequests = new Map<string, Set<() => void>>();

export function onAccountChoiceRequest(key: string, open: () => void): () => void {
  const set = choiceRequests.get(key) ?? new Set();
  set.add(open);
  choiceRequests.set(key, set);
  return () => {
    set.delete(open);
    if (set.size === 0) choiceRequests.delete(key);
  };
}

export function requestAccountChoice(key: string): void {
  for (const open of choiceRequests.get(key) ?? []) open();
}
