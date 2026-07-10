"use client";

import { useSyncExternalStore } from "react";

import {
  type AccountEffective,
  type AutoBalance,
  type EngineMigration,
  type MigrationPreview,
  parseAutoBalance,
  parseEffective,
  parseEngineMigration,
  parseMigrationPreview,
} from "@/lib/accounts/migration";
import type { TFunction } from "@/lib/i18n";

export type Engine = "claude" | "codex";

export type DeviceAuth = { url: string; code: string };
export type ManagedAttemptState = "pending" | "completed" | "failed" | "stale" | "cancelled";

/** Typed, secret-free projection of a Claude login operation (issue #61). The
    supervisor never emits browser URLs or CLI output beyond `loginUrl`, which the
    route vets to claude.ai / console.anthropic.com before it reaches the client. */
export type ClaudeLoginPhase =
  | "starting" | "awaiting_browser" | "awaiting_code" | "verifying" | "canceling"   // nonterminal
  | "authenticated" | "canceled" | "timed_out" | "failed" | "interrupted";          // terminal
export type ClaudeLoginResult = { status: "success" | "failure" | "canceled"; code: string; message: string };
export type ClaudeLoginView = {
  operationId: string;
  phase: ClaudeLoginPhase;
  loginUrl: string | null;
  acceptsCode: boolean;
  deadlineAt: string;
  result: ClaudeLoginResult | null;
};

const CLAUDE_LOGIN_PHASES = new Set<ClaudeLoginPhase>([
  "starting", "awaiting_browser", "awaiting_code", "verifying", "canceling",
  "authenticated", "canceled", "timed_out", "failed", "interrupted",
]);
/** Phases in which the operation is still live: the client keeps fast-polling and
    the row keeps its login affordances until one of these clears. */
export const NONTERMINAL_CLAUDE_LOGIN_PHASES = new Set<ClaudeLoginPhase>([
  "starting", "awaiting_browser", "awaiting_code", "verifying", "canceling",
]);

/** Crash-safe validation of the supervisor's login summary. An unknown phase, a
    malformed field, or a non-object yields `null` — never a throw — so a stray
    payload can never break the accounts read. */
export function parseClaudeLogin(raw: unknown): ClaudeLoginView | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.operationId !== "string") return null;
  if (typeof row.phase !== "string" || !CLAUDE_LOGIN_PHASES.has(row.phase as ClaudeLoginPhase)) return null;
  if (row.loginUrl !== null && typeof row.loginUrl !== "string") return null;
  if (typeof row.acceptsCode !== "boolean") return null;
  if (typeof row.deadlineAt !== "string") return null;
  let result: ClaudeLoginResult | null = null;
  if (row.result !== null && row.result !== undefined) {
    const r = row.result as Record<string, unknown>;
    if (r.status !== "success" && r.status !== "failure" && r.status !== "canceled") return null;
    if (typeof r.code !== "string" || typeof r.message !== "string") return null;
    result = { status: r.status, code: r.code, message: r.message };
  }
  return {
    operationId: row.operationId,
    phase: row.phase as ClaudeLoginPhase,
    loginUrl: (row.loginUrl as string | null) ?? null,
    acceptsCode: row.acceptsCode,
    deadlineAt: row.deadlineAt,
    result,
  };
}

/** Sanitized error copy (C7): the client renders i18n keyed on `result.code` /
    route `code`, never the server's raw message. Unknown codes fall back to a
    generic actionable line. */
export type ClaudeLoginErrKey =
  | "accounts.claudeLogin.err.timed_out"
  | "accounts.claudeLogin.err.interrupted"
  | "accounts.claudeLogin.err.verification_failed"
  | "accounts.claudeLogin.err.input_failed"
  | "accounts.claudeLogin.err.login_busy"
  | "accounts.claudeLogin.err.generic";
export function claudeLoginErrKey(code: string | null | undefined): ClaudeLoginErrKey {
  switch (code) {
    case "timed_out": return "accounts.claudeLogin.err.timed_out";
    case "interrupted": return "accounts.claudeLogin.err.interrupted";
    case "verification_failed": return "accounts.claudeLogin.err.verification_failed";
    case "input_failed": return "accounts.claudeLogin.err.input_failed";
    case "login_busy": return "accounts.claudeLogin.err.login_busy";
    default: return "accounts.claudeLogin.err.generic";
  }
}

export type AccountOption = {
  id: string;
  label: string;
  /** Managed accounts own the sign-in/retry affordances; legacy ones never do. */
  kind?: "legacy" | "managed";
  authPresent: boolean;
  loginPending: boolean;
  loginState: ManagedAttemptState | "idle" | "authenticated";
  attemptState?: ManagedAttemptState | null;
  deviceAuth: DeviceAuth | null;
  /** Typed Claude login operation for this account, when one exists (issue #61). */
  login?: ClaudeLoginView | null;
  /** Effective remaining capacity chip (min across quota windows), when known. */
  effective?: AccountEffective | null;
};
export type AccountLoadState = "loading" | "ready" | "error";
export type AccountOperation = "refresh" | "add" | "migrate" | "policy" | "login";

/** A retry action carries exactly the identifier its endpoint needs. The account
    target id drives the preview → migrate path; the durable intent id drives the
    stop and retry-failed endpoints. Each operation retries through its own path,
    so an intent id can never reach the account preview route (the recovery-retry
    bug where a `"migrate"` action fed an intent uuid to `/accounts/{engine}/active`). */
export type AccountRetryAction =
  | { type: "retry"; kind: "refresh" }
  | { type: "retry"; kind: "add"; label: string }
  | { type: "retry"; kind: "migrate"; accountId: string }
  | { type: "retry"; kind: "stop"; intentId: string }
  | { type: "retry"; kind: "retryFailed"; intentId: string }
  | { type: "retry"; kind: "loginRetry"; accountId: string };

export type AccountNoticeKey =
  | "accounts.refreshFailed" | "accounts.switchFailed" | "accounts.addFailed" | "accounts.loginOpened"
  | "accounts.claudeLoginStarted"
  | ClaudeLoginErrKey;

export interface AccountNotice {
  kind: "error" | "success";
  operation: AccountOperation;
  messageKey: AccountNoticeKey;
  target?: string;
  action: AccountRetryAction | null;
}

export function accountNoticeText(t: TFunction, notice: AccountNotice): string {
  // A single carrier field feeds both the codex `{target}` copy and the claude
  // `{label}` copy; interpolate() only substitutes placeholders the message uses.
  return notice.target ? t(notice.messageKey, { target: notice.target, label: notice.target }) : t(notice.messageKey);
}

export function pendingDeviceAuth(accounts: AccountOption[]): DeviceAuth | null {
  return accounts.find((account) => account.loginPending)?.deviceAuth ?? null;
}

/** The account controls are always useful: they create a recoverable path while
    loading, with no quota payload, and after a failed account request. */
export type AccountSwitchView = "switch" | "loading" | "error";
export function accountSwitchView(accounts: AccountOption[], status: AccountLoadState): AccountSwitchView {
  if (accounts.length) return "switch";
  return status === "error" ? "error" : "loading";
}

/** The account entry point never disappears: loading, empty limits, and failed
    reads all keep a recoverable trigger visible. */
export function accountEntryPointVisible(_hasLimits: boolean, _status: AccountLoadState): boolean {
  void _hasLimits;
  void _status;
  return true;
}

export interface EngineAccountsSnapshot {
  accounts: AccountOption[];
  active: string;
  /** Changes for each optimistic, confirmed, or reverted account identity. */
  identityVersion: number;
  status: AccountLoadState;
  notice: AccountNotice | null;
  challenge: DeviceAuth | null;
  mutation: AccountOperation | null;
  /** Draining account-migration intent for this engine, or null. */
  migration: EngineMigration | null;
  /** Per-engine auto-balance status, or null when the coordinator is absent.
      Presence also signals the migration coordinator is available. */
  autoBalance: AutoBalance | null;
}

export interface EngineAccountsState extends EngineAccountsSnapshot {
  engine: Engine;
  refresh: () => Promise<boolean>;
  add: (label: string) => Promise<boolean>;
  retryNotice: () => Promise<boolean>;
  /** Non-mutating scope preview for the confirm step; null when it fails. Every
      switch surface previews first — there is no mode-less bare switch anymore. */
  preview: (id: string) => Promise<MigrationPreview | null>;
  /** Confirmed engine-wide migration to `id`; coalesces to the latest target.
      Also the zero-scope path when a preview finds nothing live to move. */
  selectAndMigrate: (id: string, previewRevision?: number) => Promise<boolean>;
  /** Halts a draining intent (idempotent). */
  stopMigration: () => Promise<boolean>;
  /** Re-runs the failed sessions of the current intent (idempotent). */
  retryFailedMigration: () => Promise<boolean>;
  /** Toggles the per-engine auto-balancer. */
  setAutoBalance: (enabled: boolean) => Promise<boolean>;
  /** Submits the pasted authorization code for a Claude login operation
      (claude only; codex resolves `false`). Optimistically enters `verifying`. */
  submitLoginCode: (operationId: string, code: string) => Promise<boolean>;
  /** Cancels an in-flight Claude login operation (claude only). Optimistic
      `canceling`; the account row is never removed. */
  cancelLogin: (operationId: string) => Promise<boolean>;
  /** Restarts sign-in for an existing managed Claude account (claude only) —
      recovers a canceled/failed/broken account without deleting it. */
  retryLogin: (accountId: string) => Promise<boolean>;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface EngineAccountsStoreOptions {
  fetcher?: Fetcher;
  timeoutMs?: number;
}

export interface EngineAccountsStore extends EngineAccountsState {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => EngineAccountsSnapshot;
}

const INITIAL_SNAPSHOT: EngineAccountsSnapshot = {
  accounts: [],
  active: "",
  identityVersion: 0,
  status: "loading",
  notice: null,
  challenge: null,
  mutation: null,
  migration: null,
  autoBalance: null,
};

interface EngineResponse {
  active: string;
  accounts: AccountOption[];
  migration: EngineMigration | null;
  autoBalance: AutoBalance | null;
}

function accountResponse(body: unknown, engine: Engine): EngineResponse {
  const section = (body as Record<string, unknown> | null)?.[engine] as { active?: unknown; accounts?: unknown; migration?: unknown; autoBalance?: unknown } | undefined;
  if (typeof section?.active !== "string" || !Array.isArray(section.accounts)) throw new Error("accounts response invalid");
  const accounts = section.accounts.map((raw): AccountOption => {
    const account = raw as AccountOption & { effective?: unknown; login?: unknown };
    const login = engine === "claude" ? parseClaudeLogin(account.login) : null;
    // The phase is authoritative for pending state (C3): a nonterminal login
    // keeps the row pending even when the server's raw `loginPending` lags.
    const loginPending = login ? NONTERMINAL_CLAUDE_LOGIN_PHASES.has(login.phase) : account.loginPending === true;
    return { ...account, login, loginPending, effective: parseEffective(account.effective) };
  });
  return {
    active: section.active,
    accounts,
    migration: parseEngineMigration(section.migration),
    autoBalance: parseAutoBalance(section.autoBalance),
  };
}

function refreshFailure(): AccountNotice {
  return { kind: "error", operation: "refresh", messageKey: "accounts.refreshFailed", action: { type: "retry", kind: "refresh" } };
}

function addFailure(label: string): AccountNotice {
  return { kind: "error", operation: "add", messageKey: "accounts.addFailed", action: { type: "retry", kind: "add", label } };
}

function codeOf(body: unknown): string | null {
  const code = (body as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/** A failed Claude add maps the route `code` to sanitized copy (C7) while keeping
    the `add` retry action so the draft label survives (C10). */
function claudeAddFailure(code: string | null | undefined, label: string): AccountNotice {
  return { kind: "error", operation: "add", messageKey: claudeLoginErrKey(code), action: { type: "retry", kind: "add", label } };
}

/** A failed account switch retries by re-previewing the account target and
    committing a fresh, revision-fenced migration. */
function migrateFailure(accountId: string): AccountNotice {
  return { kind: "error", operation: "migrate", messageKey: "accounts.switchFailed", action: { type: "retry", kind: "migrate", accountId } };
}

/** Stop and retry-failed retries address the durable intent by its id and read a
    fresh revision fence when they re-issue, so both route to
    `/api/account-migrations/{intentId}` and stay off the account preview route. */
function stopFailure(intentId: string): AccountNotice {
  return { kind: "error", operation: "migrate", messageKey: "accounts.switchFailed", action: { type: "retry", kind: "stop", intentId } };
}
function retryFailedFailure(intentId: string): AccountNotice {
  return { kind: "error", operation: "migrate", messageKey: "accounts.switchFailed", action: { type: "retry", kind: "retryFailed", intentId } };
}

/** One narrow state store backs every account control of one engine. It owns
    read ordering, mutation serialization, timeout cleanup, and recovery state
    so a mounted Switchboard, footer, and Accounts panel can never diverge. */
export function createEngineAccountsStore(
  engine: Engine,
  { fetcher = globalThis.fetch.bind(globalThis), timeoutMs = 10_000 }: EngineAccountsStoreOptions = {},
): EngineAccountsStore {
  const activeUrl = `/api/accounts/${engine}/active`;
  const addUrl = `/api/accounts/${engine}`;
  let snapshot = INITIAL_SNAPSHOT;
  let requestGeneration = 0;
  let activeRequest: AbortController | null = null;
  let mutationQueued = false;
  let mutationQueue = Promise.resolve();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollIntervalMs: number | null = null;
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };
  const setSnapshot = (next: EngineAccountsSnapshot) => {
    snapshot = next;
    updatePolling();
    emit();
  };
  const patchSnapshot = (patch: Partial<EngineAccountsSnapshot>) => setSnapshot({ ...snapshot, ...patch });
  const stopPolling = () => {
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = null;
    pollIntervalMs = null;
  };
  /** The desired poll cadence, or `null` for none. A live Claude login polls
      fast (2 500 ms) so the browser link and code state land within a beat; a
      codex device login or a draining migration keeps the slower 10 000 ms. */
  const desiredIntervalMs = (): number | null => {
    if (listeners.size === 0) return null;
    const fastLogin = snapshot.accounts.some(
      (account) => account.login != null && NONTERMINAL_CLAUDE_LOGIN_PHASES.has(account.login.phase),
    );
    if (fastLogin) return 2_500;
    if (snapshot.accounts.some((account) => account.loginPending) || snapshot.migration?.state === "draining") return 10_000;
    return null;
  };
  const updatePolling = () => {
    // Recompute only when the cadence class changes, so a steady phase never
    // resets the interval mid-cycle.
    const desired = desiredIntervalMs();
    if (desired === pollIntervalMs) return;
    stopPolling();
    if (desired !== null) {
      pollTimer = setInterval(() => void refresh(), desired);
      pollIntervalMs = desired;
    }
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
      const { active, accounts, migration, autoBalance } = accountResponse(await response.json(), engine);
      if (generation !== requestGeneration) return false;
      activeRequest = null;
      setSnapshot({
        ...snapshot,
        active,
        accounts,
        migration,
        autoBalance,
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

  const runMutation = (operation: AccountOperation, run: () => Promise<boolean>): Promise<boolean> => {
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

  const add = (label: string): Promise<boolean> => {
    const trimmed = label.trim();
    if (!trimmed) return Promise.resolve(false);
    return runMutation("add", async () => {
      try {
        const response = await fetcher(addUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: trimmed }),
        });
        const body = await response.json().catch(() => null) as {
          account?: { id?: unknown; label?: unknown; authPresent?: unknown; loginPending?: unknown };
          login?: unknown; target?: unknown; code?: unknown;
        } | null;
        if (engine === "claude") {
          // Claude's create returns 202 { account, login } — `target` is a
          // transitional field the new client ignores (Sol/Fable answer 1).
          if (!response.ok) {
            patchSnapshot({ notice: claudeAddFailure(codeOf(body), trimmed) });
            await refresh();
            return false;
          }
          const login = parseClaudeLogin(body?.login);
          if (typeof body?.account?.id !== "string" || typeof body.account.label !== "string" || !login) throw new Error("account creation failed");
          const created: AccountOption = {
            id: body.account.id,
            label: body.account.label,
            kind: "managed",
            authPresent: body.account.authPresent === true,
            login,
            loginPending: NONTERMINAL_CLAUDE_LOGIN_PHASES.has(login.phase),
            loginState: "pending",
            deviceAuth: null,
          };
          // Upsert by id so a raced refresh never duplicates the optimistic row.
          const accounts = snapshot.accounts.some((account) => account.id === created.id)
            ? snapshot.accounts.map((account) => (account.id === created.id ? { ...account, ...created } : account))
            : [...snapshot.accounts, created];
          patchSnapshot({
            accounts,
            challenge: pendingDeviceAuth(accounts),
            notice: { kind: "success", operation: "add", messageKey: "accounts.claudeLoginStarted", target: created.label, action: null },
          });
        } else {
          // Codex keeps the existing device-login contract: a string `target`.
          if (!response.ok || typeof body?.account?.id !== "string" || typeof body.account.label !== "string" || typeof body.target !== "string") throw new Error("account creation failed");
          const created: AccountOption = {
            id: body.account.id,
            label: body.account.label,
            authPresent: body.account.authPresent === true,
            loginPending: body.account.loginPending === true,
            loginState: body.account.loginPending === true ? "pending" : "idle",
            deviceAuth: null,
            login: null,
          };
          const accounts = snapshot.accounts.some((account) => account.id === created.id) ? snapshot.accounts : [...snapshot.accounts, created];
          patchSnapshot({
            accounts,
            challenge: pendingDeviceAuth(accounts),
            notice: { kind: "success", operation: "add", messageKey: "accounts.loginOpened", target: body.target, action: null },
          });
        }
      } catch {
        patchSnapshot({ notice: engine === "claude" ? claudeAddFailure(null, trimmed) : addFailure(trimmed) });
        await refresh();
        return false;
      }
      await refresh();
      return true;
    });
  };

  /** Non-mutating scope preview: every switch surface runs this first, so the
      only writes to `/active` are `mode:"preview"` and `mode:"migrate"` — never a
      mode-less bare switch. The route treats `mode:"preview"` as read-only. */
  const preview = async (id: string): Promise<MigrationPreview | null> => {
    if (!id) return null;
    // The client already knows the target it asked to preview, so it canonicalises
    // the response into the target-aware DTO even when the coordinator returns the
    // leaner counts-and-revision shape. A `null` therefore means the preview truly
    // failed (non-OK / unreachable), which the panel surfaces as a recoverable error.
    const fallback = { targetId: id, targetLabel: snapshot.accounts.find((account) => account.id === id)?.label ?? id };
    try {
      const response = await fetcher(activeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, mode: "preview" }),
      });
      if (!response.ok) return null;
      return parseMigrationPreview(await response.json().catch(() => null), fallback);
    } catch {
      return null;
    }
  };

  const selectAndMigrate = (id: string, previewRevision?: number): Promise<boolean> => {
    if (!id) return Promise.resolve(false);
    return runMutation("migrate", async () => {
      const previous = snapshot.active;
      // New spawns use the target the moment the intent commits (Sol invariant 7).
      patchSnapshot({ active: id, identityVersion: snapshot.identityVersion + 1 });
      try {
        const response = await fetcher(activeUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, mode: "migrate", migrate: true, previewRevision, requestId: mintRequestId() }),
        });
        if (!response.ok) throw new Error("migration request failed");
      } catch {
        patchSnapshot({ active: previous, identityVersion: snapshot.identityVersion + 1, notice: migrateFailure(id) });
        await refresh();
        return false;
      }
      // A committed migration clears any lingering switch-failure notice so a
      // recovered retry doesn't leave a stale error behind.
      patchSnapshot({ identityVersion: snapshot.identityVersion + 1, notice: snapshot.notice?.operation === "migrate" ? null : snapshot.notice });
      await refresh();
      return true;
    });
  };

  const stopMigration = (): Promise<boolean> => {
    const intentId = snapshot.migration?.intentId;
    if (!intentId) return Promise.resolve(false);
    return runMutation("migrate", async () => {
      try {
        // Frozen stop route (Sol contract): the durable intent is addressed by
        // its own id under /api/account-migrations.
        const response = await fetcher(`/api/account-migrations/${encodeURIComponent(intentId)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "stop", expectedRevision: snapshot.migration?.revision }),
        });
        if (!response.ok) throw new Error("stop failed");
      } catch {
        patchSnapshot({ notice: stopFailure(intentId) });
        await refresh();
        return false;
      }
      await refresh();
      return true;
    });
  };

  const retryFailedMigration = (): Promise<boolean> => {
    const intentId = snapshot.migration?.intentId;
    if (!intentId) return Promise.resolve(false);
    return runMutation("migrate", async () => {
      try {
        // Frozen retry-failed route (Sol contract): re-run only the
        // failed-recoverable sessions of the intent, fenced by its revision.
        const response = await fetcher(`/api/account-migrations/${encodeURIComponent(intentId)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "retry-failed", expectedRevision: snapshot.migration?.revision }),
        });
        if (!response.ok) throw new Error("retry-failed failed");
      } catch {
        patchSnapshot({ notice: retryFailedFailure(intentId) });
        await refresh();
        return false;
      }
      await refresh();
      return true;
    });
  };

  const setAutoBalance = (enabled: boolean): Promise<boolean> => {
    return runMutation("policy", async () => {
      const previous = snapshot.autoBalance;
      if (previous) patchSnapshot({ autoBalance: { ...previous, enabled, state: enabled ? "idle" : "disabled" } });
      try {
        // Frozen policy route (Sol contract): PATCH the account policy with the
        // `automaticSwitching` flag. The old POST …/auto-balance {enabled} route
        // never existed. Mutations carry a request id for idempotent retries.
        const response = await fetcher(`/api/accounts/${engine}/policy`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ automaticSwitching: enabled, requestId: mintRequestId() }),
        });
        if (!response.ok) throw new Error("policy update failed");
      } catch {
        if (previous) patchSnapshot({ autoBalance: previous });
        await refresh();
        return false;
      }
      await refresh();
      return true;
    });
  };

  /** Optimistic in-place patch of one account's live login op, keyed by operation
      id, re-deriving `loginPending` from the new phase. */
  const patchAccountLogin = (operationId: string, updater: (login: ClaudeLoginView) => ClaudeLoginView) => {
    const accounts = snapshot.accounts.map((account) => {
      if (!account.login || account.login.operationId !== operationId) return account;
      const login = updater(account.login);
      return { ...account, login, loginPending: NONTERMINAL_CLAUDE_LOGIN_PHASES.has(login.phase) };
    });
    patchSnapshot({ accounts });
  };

  const submitLoginCode = (operationId: string, code: string): Promise<boolean> => {
    if (engine !== "claude") return Promise.resolve(false);
    const trimmed = code.trim();
    if (!trimmed) return Promise.resolve(false);
    return runMutation("login", async () => {
      // Optimistically enter verifying so the code field yields to a spinner and
      // no second submit is possible; the next refresh reconciles the truth.
      patchAccountLogin(operationId, (login) => ({ ...login, phase: "verifying", acceptsCode: false }));
      try {
        const response = await fetcher(`/api/accounts/claude/login/${encodeURIComponent(operationId)}/input`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: trimmed }),
        });
        if (!response.ok) {
          patchSnapshot({ notice: { kind: "error", operation: "login", messageKey: "accounts.claudeLogin.err.input_failed", action: null } });
          await refresh();
          return false;
        }
      } catch {
        patchSnapshot({ notice: { kind: "error", operation: "login", messageKey: "accounts.claudeLogin.err.input_failed", action: null } });
        await refresh();
        return false;
      }
      await refresh();
      return true;
    });
  };

  const cancelLogin = (operationId: string): Promise<boolean> => {
    if (engine !== "claude") return Promise.resolve(false);
    return runMutation("login", async () => {
      patchAccountLogin(operationId, (login) => ({ ...login, phase: "canceling", acceptsCode: false }));
      try {
        const response = await fetcher(`/api/accounts/claude/login/${encodeURIComponent(operationId)}`, { method: "DELETE" });
        if (!response.ok) throw new Error("cancel failed");
      } catch {
        // A failed cancel keeps the account and restores real state from the read.
        await refresh();
        return false;
      }
      await refresh();
      return true;
    });
  };

  const retryLogin = (accountId: string): Promise<boolean> => {
    if (engine !== "claude") return Promise.resolve(false);
    return runMutation("login", async () => {
      try {
        const response = await fetcher(addUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "retry", id: accountId }),
        });
        const body = await response.json().catch(() => null) as { account?: { id?: unknown }; login?: unknown } | null;
        if (response.status === 409) {
          // Another sign-in already holds the supervisor: surface it, keep the row.
          patchSnapshot({ notice: { kind: "error", operation: "login", messageKey: "accounts.claudeLogin.err.login_busy", action: null } });
          return false;
        }
        const login = parseClaudeLogin(body?.login);
        if (response.status !== 202 || !login) throw new Error("login retry failed");
        // Replace the account's login op in place — the row is never removed (C8).
        const label = snapshot.accounts.find((account) => account.id === accountId)?.label ?? accountId;
        const accounts = snapshot.accounts.map((account) =>
          account.id === accountId
            ? { ...account, login, authPresent: false, loginState: "pending" as const, loginPending: NONTERMINAL_CLAUDE_LOGIN_PHASES.has(login.phase) }
            : account,
        );
        patchSnapshot({
          accounts,
          notice: { kind: "success", operation: "login", messageKey: "accounts.claudeLoginStarted", target: label, action: null },
        });
      } catch {
        patchSnapshot({ notice: { kind: "error", operation: "login", messageKey: "accounts.claudeLogin.err.generic", action: { type: "retry", kind: "loginRetry", accountId } } });
        await refresh();
        return false;
      }
      await refresh();
      return true;
    });
  };

  const retryNotice = async (): Promise<boolean> => {
    const action = snapshot.notice?.action;
    if (!action) return false;
    switch (action.kind) {
      case "refresh":
        return refresh();
      case "add":
        return add(action.label);
      case "loginRetry":
        return retryLogin(action.accountId);
      case "migrate": {
        // A migrate retry re-fences against a fresh preview revision: the stored
        // one is stale once the intent moved on or another switch raced, so it
        // would 409. Fail closed when the preview cannot be obtained.
        const fresh = await preview(action.accountId);
        if (!fresh) return false;
        return selectAndMigrate(action.accountId, fresh.previewRevision);
      }
      case "stop":
        // Re-issues the stop against the durable intent; stopMigration reads the
        // current revision fence when it runs.
        return stopMigration();
      case "retryFailed":
        // Re-issues retry-failed against the durable intent with the current
        // revision fence.
        return retryFailedMigration();
    }
  };

  return {
    engine,
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
    get migration() { return snapshot.migration; },
    get autoBalance() { return snapshot.autoBalance; },
    refresh,
    add,
    retryNotice,
    preview,
    selectAndMigrate,
    stopMigration,
    retryFailedMigration,
    setAutoBalance,
    submitLoginCode,
    cancelLogin,
    retryLogin,
  };
}

/** randomUUID needs a secure context; LAN http access gets a plain fallback. */
function mintRequestId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return "req-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const stores: Record<Engine, EngineAccountsStore> = {
  codex: createEngineAccountsStore("codex"),
  claude: createEngineAccountsStore("claude"),
};

/** Shared per-engine account state for the Switchboard, limits footer, and the
    unified Accounts panel. Every surface of one engine reads one singleton. */
export function useEngineAccounts(engine: Engine): EngineAccountsState {
  const store = stores[engine];
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return {
    ...snapshot,
    engine,
    refresh: store.refresh,
    add: store.add,
    retryNotice: store.retryNotice,
    preview: store.preview,
    selectAndMigrate: store.selectAndMigrate,
    stopMigration: store.stopMigration,
    retryFailedMigration: store.retryFailedMigration,
    setAutoBalance: store.setAutoBalance,
    submitLoginCode: store.submitLoginCode,
    cancelLogin: store.cancelLogin,
    retryLogin: store.retryLogin,
  };
}
