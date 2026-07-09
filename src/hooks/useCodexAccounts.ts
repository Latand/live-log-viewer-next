"use client";

import { useSyncExternalStore } from "react";

import type { TFunction } from "@/lib/i18n";

export type DeviceAuth = { url: string; code: string };
export type ManagedAttemptState = "pending" | "completed" | "failed" | "stale" | "cancelled";
export type CodexAccountOption = {
  id: string;
  label: string;
  authPresent: boolean;
  loginPending: boolean;
  loginState: ManagedAttemptState | "idle" | "authenticated";
  attemptState?: ManagedAttemptState | null;
  deviceAuth: DeviceAuth | null;
};
export type AccountLoadState = "loading" | "ready" | "error";
export type AccountOperation = "refresh" | "select" | "add";

export interface AccountNotice {
  kind: "error" | "success";
  operation: AccountOperation;
  messageKey: "accounts.refreshFailed" | "accounts.switchFailed" | "accounts.addFailed" | "accounts.loginOpened";
  target?: string;
  action: { type: "retry"; operation: AccountOperation; id?: string; label?: string } | null;
}

export function accountNoticeText(t: TFunction, notice: AccountNotice): string {
  return notice.target ? t(notice.messageKey, { target: notice.target }) : t(notice.messageKey);
}

export function pendingDeviceAuth(accounts: CodexAccountOption[]): DeviceAuth | null {
  return accounts.find((account) => account.loginPending)?.deviceAuth ?? null;
}

/** The account controls are always useful: they create a recoverable path while
    loading, with no quota payload, and after a failed account request. */
export type AccountSwitchView = "switch" | "loading" | "error";
export function accountSwitchView(accounts: CodexAccountOption[], status: AccountLoadState): AccountSwitchView {
  if (accounts.length) return "switch";
  return status === "error" ? "error" : "loading";
}

export function codexEntryPointVisible(_hasLimits: boolean, _status: AccountLoadState): boolean {
  void _hasLimits;
  void _status;
  return true;
}

export interface CodexAccountsSnapshot {
  accounts: CodexAccountOption[];
  active: string;
  /** Changes for each optimistic, confirmed, or reverted account identity. */
  identityVersion: number;
  status: AccountLoadState;
  notice: AccountNotice | null;
  challenge: DeviceAuth | null;
  mutation: AccountOperation | null;
}

export interface CodexAccountsState extends CodexAccountsSnapshot {
  refresh: () => Promise<boolean>;
  select: (id: string) => Promise<boolean>;
  add: (label: string) => Promise<boolean>;
  retryNotice: () => Promise<boolean>;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CodexAccountsStoreOptions {
  fetcher?: Fetcher;
  timeoutMs?: number;
}

export interface CodexAccountsStore extends CodexAccountsState {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => CodexAccountsSnapshot;
}

const INITIAL_SNAPSHOT: CodexAccountsSnapshot = {
  accounts: [],
  active: "",
  identityVersion: 0,
  status: "loading",
  notice: null,
  challenge: null,
  mutation: null,
};

function accountResponse(body: unknown): { active: string; accounts: CodexAccountOption[] } {
  const codex = (body as { codex?: unknown } | null)?.codex as { active?: unknown; accounts?: unknown } | undefined;
  if (typeof codex?.active !== "string" || !Array.isArray(codex.accounts)) throw new Error("accounts response invalid");
  return { active: codex.active, accounts: codex.accounts as CodexAccountOption[] };
}

function refreshFailure(): AccountNotice {
  return {
    kind: "error",
    operation: "refresh",
    messageKey: "accounts.refreshFailed",
    action: { type: "retry", operation: "refresh" },
  };
}

function mutationFailure(operation: "select" | "add", value: string): AccountNotice {
  return {
    kind: "error",
    operation,
    messageKey: operation === "select" ? "accounts.switchFailed" : "accounts.addFailed",
    action: operation === "select"
      ? { type: "retry", operation, id: value }
      : { type: "retry", operation, label: value },
  };
}

/** One narrow state store backs every account control. It owns read ordering,
    mutation serialization, timeout cleanup, and recovery state so a mounted
    Switchboard and footer can never diverge. */
export function createCodexAccountsStore({
  fetcher = globalThis.fetch.bind(globalThis),
  timeoutMs = 10_000,
}: CodexAccountsStoreOptions = {}): CodexAccountsStore {
  let snapshot = INITIAL_SNAPSHOT;
  let requestGeneration = 0;
  let activeRequest: AbortController | null = null;
  let mutationQueued = false;
  let mutationQueue = Promise.resolve();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };
  const setSnapshot = (next: CodexAccountsSnapshot) => {
    snapshot = next;
    updatePolling();
    emit();
  };
  const patchSnapshot = (patch: Partial<CodexAccountsSnapshot>) => setSnapshot({ ...snapshot, ...patch });
  const stopPolling = () => {
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = null;
  };
  const updatePolling = () => {
    const needsPoll = listeners.size > 0 && snapshot.accounts.some((account) => account.loginPending);
    if (!needsPoll) return stopPolling();
    if (pollTimer === null) pollTimer = setInterval(() => void refresh(), 10_000);
  };
  const abortRead = () => {
    requestGeneration += 1;
    activeRequest?.abort();
    activeRequest = null;
  };

  const refresh = async (): Promise<boolean> => {
    abortRead();
    const generation = requestGeneration;
    const controller = new AbortController();
    activeRequest = controller;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher("/api/accounts", { signal: controller.signal });
      if (!response.ok) throw new Error("accounts request failed");
      const { active, accounts } = accountResponse(await response.json());
      if (generation !== requestGeneration) return false;
      activeRequest = null;
      setSnapshot({
        ...snapshot,
        active,
        accounts,
        challenge: pendingDeviceAuth(accounts),
        status: "ready",
        notice: snapshot.notice?.operation === "refresh" ? null : snapshot.notice,
      });
      return true;
    } catch {
      if (generation !== requestGeneration) return false;
      activeRequest = null;
      setSnapshot({ ...snapshot, status: "error", notice: refreshFailure() });
      return false;
    } finally {
      clearTimeout(timeout);
    }
  };

  const runMutation = (operation: "select" | "add", run: () => Promise<boolean>): Promise<boolean> => {
    if (mutationQueued || snapshot.mutation) return Promise.resolve(false);
    mutationQueued = true;
    patchSnapshot({ mutation: operation });
    const result = mutationQueue.then(run, run);
    mutationQueue = result.then(() => undefined, () => undefined);
    return result.finally(() => {
      mutationQueued = false;
      patchSnapshot({ mutation: null });
    });
  };

  const select = (id: string): Promise<boolean> => {
    if (!id || id === snapshot.active) return Promise.resolve(false);
    return runMutation("select", async () => {
      const previous = snapshot.active;
      patchSnapshot({ active: id, identityVersion: snapshot.identityVersion + 1 });
      try {
        const response = await fetcher("/api/accounts/codex/active", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
        });
        if (!response.ok) throw new Error("account selection failed");
      } catch {
        patchSnapshot({ active: previous, identityVersion: snapshot.identityVersion + 1, notice: mutationFailure("select", id) });
        await refresh();
        return false;
      }
      // The optimistic invalidation may have raced the server-side mutation.
      // A confirmed version schedules one authoritative limits read for this id.
      patchSnapshot({ identityVersion: snapshot.identityVersion + 1 });
      await refresh();
      return true;
    });
  };

  const add = (label: string): Promise<boolean> => {
    const trimmed = label.trim();
    if (!trimmed) return Promise.resolve(false);
    return runMutation("add", async () => {
      try {
        const response = await fetcher("/api/accounts/codex", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: trimmed }),
        });
        const body = await response.json().catch(() => null) as { account?: { id?: unknown; label?: unknown; authPresent?: unknown; loginPending?: unknown }; target?: unknown } | null;
        if (!response.ok || typeof body?.account?.id !== "string" || typeof body.account.label !== "string" || typeof body.target !== "string") throw new Error("account creation failed");
        const created: CodexAccountOption = {
          id: body.account.id,
          label: body.account.label,
          authPresent: body.account.authPresent === true,
          loginPending: body.account.loginPending === true,
          loginState: body.account.loginPending === true ? "pending" : "idle",
          deviceAuth: null,
        };
        const accounts = snapshot.accounts.some((account) => account.id === created.id)
          ? snapshot.accounts
          : [...snapshot.accounts, created];
        patchSnapshot({
          accounts,
          challenge: pendingDeviceAuth(accounts),
          notice: { kind: "success", operation: "add", messageKey: "accounts.loginOpened", target: body.target, action: null },
        });
      } catch {
        patchSnapshot({ notice: mutationFailure("add", trimmed) });
        await refresh();
        return false;
      }
      await refresh();
      return true;
    });
  };

  const retryNotice = (): Promise<boolean> => {
    const action = snapshot.notice?.action;
    if (!action) return Promise.resolve(false);
    if (action.operation === "refresh") return refresh();
    if (action.operation === "select" && action.id) return select(action.id);
    if (action.operation === "add" && action.label) return add(action.label);
    return Promise.resolve(false);
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      updatePolling();
      if (snapshot.status === "loading" && activeRequest === null) void refresh();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stopPolling();
          abortRead();
        } else {
          updatePolling();
        }
      };
    },
    getSnapshot: () => snapshot,
    get accounts() { return snapshot.accounts; },
    get active() { return snapshot.active; },
    get identityVersion() { return snapshot.identityVersion; },
    get status() { return snapshot.status; },
    get notice() { return snapshot.notice; },
    get challenge() { return snapshot.challenge; },
    get mutation() { return snapshot.mutation; },
    refresh,
    select,
    add,
    retryNotice,
  };
}

const accountStore = createCodexAccountsStore();

/** Shared account state for the Switchboard and limits footer. */
export function useCodexAccounts(): CodexAccountsState {
  const snapshot = useSyncExternalStore(accountStore.subscribe, accountStore.getSnapshot, accountStore.getSnapshot);
  return {
    ...snapshot,
    refresh: accountStore.refresh,
    select: accountStore.select,
    add: accountStore.add,
    retryNotice: accountStore.retryNotice,
  };
}
