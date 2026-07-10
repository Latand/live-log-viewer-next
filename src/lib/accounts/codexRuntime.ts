import fs from "node:fs";
import path from "node:path";

import type { CodexAccount } from "./codex";
import { statePath } from "../configDir";
import {
  CodexAppServerClient,
  type AppServerAccountRead,
  type AppServerRateLimits,
  type DeviceCodeChallenge,
} from "./codexAppServer";
import type { AppServerEnvelope } from "./codexAppServerProtocol";

/** Authentication is only asserted after `account/read`; attempt state is a
 * separate recoverable record for device-login supervision. */
export type ManagedLoginState = "pending" | "completed" | "failed" | "stale" | "cancelled" | "idle" | "authenticated";
export type PersistedAttemptState = Exclude<ManagedLoginState, "idle" | "authenticated">;

export interface ManagedLoginAttempt {
  accountId: string;
  loginId: string;
  verificationUrl: string;
  userCode: string;
  startedAt: number;
}

export interface ManagedLoginSnapshot {
  state: ManagedLoginState;
  attemptState: PersistedAttemptState | null;
  deviceAuth: { url: string; code: string } | null;
}

export interface ManagedCodexRuntimeOptions {
  startClient?: (home: string) => Promise<CodexAppServerClient>;
  now?: () => number;
  stateFile?: string;
}

export interface CodexQuotaProbe {
  account: AppServerAccountRead;
  rateLimits: AppServerRateLimits;
  authenticated: boolean;
  envelope: AppServerEnvelope | null;
}

type AttemptReason = "child-died" | "login-unsuccessful" | "cancelled" | "viewer-restarted" | "account-read-failed" | "start-failed";

interface PersistedAttempt {
  accountId: string;
  generation: number;
  state: PersistedAttemptState;
  startedAt: number;
  updatedAt: number;
  reason: AttemptReason | null;
}

interface StoredAttempts {
  version: 1;
  attempts: Record<string, PersistedAttempt>;
}

interface ActiveAttempt extends PersistedAttempt {
  home: string;
  client: CodexAppServerClient | null;
  loginId: string | null;
  verificationUrl: string | null;
  userCode: string | null;
  startPromise: Promise<ManagedLoginAttempt>;
}

function canonicalHome(home: string): string {
  const resolved = path.resolve(home);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function safeStoredAttempt(value: unknown): value is PersistedAttempt {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PersistedAttempt>;
  return typeof item.accountId === "string" && typeof item.generation === "number" &&
    typeof item.startedAt === "number" && typeof item.updatedAt === "number" &&
    (item.state === "pending" || item.state === "completed" || item.state === "failed" || item.state === "stale" || item.state === "cancelled") &&
    (item.reason === null || item.reason === "child-died" || item.reason === "login-unsuccessful" || item.reason === "cancelled" || item.reason === "viewer-restarted" || item.reason === "account-read-failed" || item.reason === "start-failed");
}

function readStoredAttempts(file: string): Map<string, PersistedAttempt> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StoredAttempts>;
    if (parsed.version !== 1 || !parsed.attempts || typeof parsed.attempts !== "object") return new Map();
    return new Map(Object.entries(parsed.attempts).filter((entry): entry is [string, PersistedAttempt] => safeStoredAttempt(entry[1])));
  } catch {
    return new Map();
  }
}

/**
 * Supervises one device-login child per canonical CODEX_HOME. Persistent state
 * deliberately contains no challenge, login id, token, or auth-file contents.
 */
export class ManagedCodexRuntime {
  private readonly active = new Map<string, ActiveAttempt>();
  private readonly records: Map<string, PersistedAttempt>;
  private readonly startClient: (home: string) => Promise<CodexAppServerClient>;
  private readonly now: () => number;
  private readonly stateFile: string;

  constructor(options: ManagedCodexRuntimeOptions = {}) {
    this.startClient = options.startClient ?? ((home) => CodexAppServerClient.start({ home }));
    this.now = options.now ?? (() => Date.now());
    this.stateFile = options.stateFile ?? statePath("codex-login-attempts.json");
    this.records = readStoredAttempts(this.stateFile);
  }

  async startLogin(account: CodexAccount): Promise<ManagedLoginAttempt> {
    return this.beginLogin(account, false);
  }

  /** Replaces a stranded attempt for an existing managed account. */
  async retryLogin(account: CodexAccount): Promise<ManagedLoginAttempt> {
    return this.beginLogin(account, true);
  }

  private beginLogin(account: CodexAccount, replace: boolean): Promise<ManagedLoginAttempt> {
    if (account.kind !== "managed") return Promise.reject(new Error("only managed Codex accounts can start an app-server login"));
    const home = canonicalHome(account.home);
    const existing = this.active.get(home);
    if (existing && !replace) return existing.startPromise;

    const previous = existing ?? null;
    const recorded = this.records.get(home);
    const now = this.now();
    const generation = Math.max(recorded?.generation ?? 0, previous?.generation ?? 0) + 1;
    // This reservation happens before the first await. Concurrent callers share
    // this promise and therefore own one child and one challenge deterministically.
    const attempt = {
      accountId: account.id,
      generation,
      state: "pending" as const,
      startedAt: now,
      updatedAt: now,
      reason: null,
      home,
      client: null,
      loginId: null,
      verificationUrl: null,
      userCode: null,
      startPromise: null as unknown as Promise<ManagedLoginAttempt>,
    } satisfies Omit<ActiveAttempt, "startPromise"> & { startPromise: Promise<ManagedLoginAttempt> };
    this.active.set(home, attempt);
    this.record(home, attempt);
    attempt.startPromise = this.launch(account, attempt, previous);
    return attempt.startPromise;
  }

  private async launch(account: CodexAccount, attempt: ActiveAttempt, previous: ActiveAttempt | null): Promise<ManagedLoginAttempt> {
    if (previous) await this.stopSuperseded(previous);
    try {
      const client = await this.startClient(account.home);
      if (!this.owns(attempt)) {
        client.close();
        throw new Error("a newer managed login owns this Codex home");
      }
      attempt.client = client;
      client.onLifecycle((event) => {
        if (event.type === "failed") this.settle(attempt, "failed", "child-died", false);
      });
      client.onNotification((notification) => {
        if (notification.method !== "account/login/completed" || !isCompletion(notification.params, attempt.loginId)) return;
        this.settle(attempt, notification.params.success ? "completed" : "failed", notification.params.success ? null : "login-unsuccessful", true);
      });
      const challenge = await client.startDeviceLogin();
      if (!this.owns(attempt)) {
        client.close();
        throw new Error("a newer managed login owns this Codex home");
      }
      attempt.loginId = challenge.loginId;
      attempt.verificationUrl = challenge.verificationUrl;
      attempt.userCode = challenge.userCode;
      return publicAttempt(attempt);
    } catch (error) {
      this.settle(attempt, "failed", "start-failed", true);
      throw error;
    }
  }

  async cancelLogin(accountId: string): Promise<boolean> {
    const active = [...this.active.values()].find((attempt) => attempt.accountId === accountId);
    if (active) {
      await this.cancelAttempt(active, "cancelled");
      return true;
    }
    const stored = [...this.records.entries()].find(([, attempt]) => attempt.accountId === accountId);
    if (!stored) return false;
    this.record(stored[0], { ...stored[1], state: "cancelled", updatedAt: this.now(), reason: "cancelled" });
    return true;
  }

  private async cancelAttempt(attempt: ActiveAttempt, reason: AttemptReason): Promise<void> {
    if (!this.owns(attempt)) return;
    const client = attempt.client;
    this.settle(attempt, "cancelled", reason, false);
    if (!client) {
      await attempt.startPromise.catch(() => undefined);
      return;
    }
    if (!attempt.loginId) {
      client.close();
      await attempt.startPromise.catch(() => undefined);
      return;
    }
    try { await client.cancelLogin(attempt.loginId); } catch { /* closing the child finalizes the cancellation */ }
    finally { client.close(); }
  }

  /** A replacement already owns the map slot, so the usual generation fence
   * must not prevent its predecessor from being reaped. Its persisted record
   * is intentionally left alone: the newer generation is authoritative. */
  private async stopSuperseded(attempt: ActiveAttempt): Promise<void> {
    const client = attempt.client;
    if (!client || !attempt.loginId) {
      client?.close();
      return;
    }
    try { await client.cancelLogin(attempt.loginId); } catch { /* close below completes supersession */ }
    finally { client.close(); }
  }

  async loginSnapshot(account: CodexAccount): Promise<ManagedLoginSnapshot> {
    if (account.kind !== "managed") return { state: account.authPresent ? "authenticated" : "idle", attemptState: null, deviceAuth: null };
    const home = canonicalHome(account.home);
    const active = this.active.get(home);
    const stored = this.records.get(home);
    try {
      const status = await this.readAccount(active?.client ?? null, account.home);
      if (isSupportedChatGptAccount(status)) {
        if (active) this.settle(active, "completed", null, true);
        else if (stored) this.record(home, { ...stored, state: "completed", updatedAt: this.now(), reason: null });
        return { state: "authenticated", attemptState: "completed", deviceAuth: null };
      }
      if (active?.state === "pending" && active.verificationUrl && active.userCode) {
        return { state: "pending", attemptState: "pending", deviceAuth: { url: active.verificationUrl, code: active.userCode } };
      }
      if (stored?.state === "pending") {
        const stale = { ...stored, state: "stale" as const, updatedAt: this.now(), reason: "viewer-restarted" as const };
        this.record(home, stale);
        return { state: "stale", attemptState: "stale", deviceAuth: null };
      }
      return stored ? { state: stored.state, attemptState: stored.state, deviceAuth: null } : { state: "idle", attemptState: null, deviceAuth: null };
    } catch {
      const base = stored ?? active;
      if (base) {
        const stale = { ...base, state: "stale" as const, updatedAt: this.now(), reason: "account-read-failed" as const };
        this.settle(active ?? null, "stale", "account-read-failed", true);
        if (!active) this.record(home, stale);
        return { state: "stale", attemptState: "stale", deviceAuth: null };
      }
      return { state: "stale", attemptState: "stale", deviceAuth: null };
    }
  }

  /** Request-safe in-memory projection. Authentication probes and persisted
   * attempt transitions remain owned by the background controller. */
  peekLogin(account: CodexAccount): ManagedLoginSnapshot {
    if (account.kind !== "managed") return { state: account.authPresent ? "authenticated" : "idle", attemptState: null, deviceAuth: null };
    const home = canonicalHome(account.home);
    const active = this.active.get(home);
    if (active?.state === "pending" && active.verificationUrl && active.userCode) {
      return { state: "pending", attemptState: "pending", deviceAuth: { url: active.verificationUrl, code: active.userCode } };
    }
    const stored = this.records.get(home);
    return stored
      ? { state: stored.state, attemptState: stored.state, deviceAuth: null }
      : { state: "idle", attemptState: null, deviceAuth: null };
  }

  /** Reads a structured rate snapshot through an active login child when one exists. */
  async readRateLimits(account: CodexAccount): Promise<AppServerRateLimits> {
    return (await this.probeQuota(account)).rateLimits;
  }

  async verifyAuthentication(account: CodexAccount): Promise<boolean> {
    return (await this.probeQuota(account)).authenticated;
  }

  /** Performs the two read-only account calls on one app-server client. */
  async probeQuota(account: CodexAccount): Promise<CodexQuotaProbe> {
    const active = this.active.get(canonicalHome(account.home));
    if (active?.client) return this.probeQuotaFrom(active.client);
    const client = await this.startClient(account.home);
    try { return await this.probeQuotaFrom(client); }
    finally { client.close(); }
  }

  private async readAccount(existing: CodexAppServerClient | null, home: string) {
    if (existing) return existing.readAccount();
    const client = await this.startClient(home);
    try { return await client.readAccount(); }
    finally { client.close(); }
  }

  private async probeQuotaFrom(client: CodexAppServerClient): Promise<CodexQuotaProbe> {
    const account = await client.readAccount();
    const rateLimits = (await client.readRateLimits()).rateLimits;
    return { account, rateLimits, authenticated: isSupportedChatGptAccount(account), envelope: client.inboundEnvelope() };
  }

  private owns(attempt: ActiveAttempt): boolean {
    return this.active.get(attempt.home)?.generation === attempt.generation;
  }

  private settle(attempt: ActiveAttempt | null, state: PersistedAttemptState, reason: AttemptReason | null, close: boolean): void {
    if (!attempt || !this.owns(attempt)) return;
    this.active.delete(attempt.home);
    this.record(attempt.home, { ...attempt, state, updatedAt: this.now(), reason });
    if (close) attempt.client?.close();
  }

  private record(home: string, attempt: PersistedAttempt): void {
    this.records.set(home, {
      accountId: attempt.accountId,
      generation: attempt.generation,
      state: attempt.state,
      startedAt: attempt.startedAt,
      updatedAt: attempt.updatedAt,
      reason: attempt.reason,
    });
    const stored: StoredAttempts = { version: 1, attempts: Object.fromEntries(this.records) };
    const dir = path.dirname(this.stateFile);
    const tmp = path.join(dir, `.${path.basename(this.stateFile)}.${process.pid}.${Date.now()}.tmp`);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify(stored, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, this.stateFile);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
}

function isSupportedChatGptAccount(account: AppServerAccountRead): boolean {
  return account.account?.type === "chatgpt";
}

function publicAttempt(attempt: ActiveAttempt): ManagedLoginAttempt {
  if (!attempt.loginId || !attempt.verificationUrl || !attempt.userCode) throw new Error("managed login challenge is incomplete");
  return { accountId: attempt.accountId, loginId: attempt.loginId, verificationUrl: attempt.verificationUrl, userCode: attempt.userCode, startedAt: attempt.startedAt };
}

function isCompletion(value: unknown, loginId: string | null): value is { loginId?: unknown; success: boolean } {
  if (!value || typeof value !== "object" || !loginId) return false;
  const completion = value as { loginId?: unknown; success?: unknown };
  return completion.loginId === loginId && typeof completion.success === "boolean";
}

let defaultRuntime: ManagedCodexRuntime | null = null;

export function managedCodexRuntime(): ManagedCodexRuntime {
  defaultRuntime ??= new ManagedCodexRuntime();
  return defaultRuntime;
}

/** Test seam: routes keep their production surface while tests supply fake stdio children. */
export function setManagedCodexRuntimeForTests(runtime: ManagedCodexRuntime | null): void {
  defaultRuntime = runtime;
}

export function deviceChallengeFrom(response: DeviceCodeChallenge): { url: string; code: string } {
  return { url: response.verificationUrl, code: response.userCode };
}
