import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveBinary } from "@/lib/agent/cli";
import { statePath } from "@/lib/configDir";
import { AccountMutationBusyError, withAccountMutationLock, withAccountMutationLockAsync } from "./accountMutation";

import type { LoginOperationSummary, LoginPhase, LoginResult } from "./contracts";
import { claudeAccountForSpawn, claudeManagedEnvironment, isManagedClaudeHome, legacyClaudeHome, managedClaudeCredentialIsSafe } from "./claude";

const OUTPUT_LIMIT = 64 * 1024;
const CODE_LIMIT = 8 * 1024;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const TERM_GRACE_MS = 2_000;
/* claude.com / platform.claude.com are what the 2.1.x CLI actually prints
   ("https://claude.com/cai/oauth/authorize?…"); the older hosts stay for
   compatibility. A missing host here shows as "Очікуємо посилання…" forever. */
const URL_HOSTS = new Set(["claude.ai", "claude.com", "platform.claude.com", "console.anthropic.com"]);
/* The OSC branch must stop at the FIRST ST/BEL terminator ([^\x07\x1B]*, not
   [^\x07]*): the CLI wraps the login URL in an OSC-8 hyperlink, and a greedy
   match swallowed the visible URL between the open and close sequences. */
const ANSI = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/g;
const URL_PATTERN = /https:\/\/[^\s"'<>]+/g;

export type LoginOperation = LoginOperationSummary & {
  accountId: string | null;
  pid: number | null;
  startToken: string | null;
  generation: number;
  submitted: boolean;
  startedAt: string;
};

type PersistedOperation = Pick<LoginOperation, "operationId" | "accountId" | "phase" | "pid" | "startToken" | "generation" | "startedAt" | "deadlineAt">;

export interface ClaudeLoginStore {
  load(): PersistedOperation[];
  save(rows: PersistedOperation[]): void;
}

export interface LoginChild {
  pid?: number;
  stdin?: { write(data: string): boolean; end(): void } | null;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  kill?(signal?: NodeJS.Signals): boolean;
}

export interface ClaudeLoginPorts {
  spawn(command: string, args: string[], options: Parameters<typeof spawn>[2]): LoginChild;
  kill(pid: number, signal: NodeJS.Signals): void;
  pidStartToken(pid: number): string | null;
  isExpectedClaude(pid: number): boolean;
  waitForExit(pid: number, startToken: string): Promise<void>;
  status(home: string): Promise<{ loggedIn: boolean; method: string | null; email: string | null; plan: string | null }>;
  now(): number;
  setTimeout(callback: () => void, ms: number): NodeJS.Timeout;
  clearTimeout(timer: NodeJS.Timeout): void;
}

function procStartToken(pid: number): string | null {
  try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[21] ?? null; } catch { return null; }
}

async function waitForProcessExit(pid: number, startToken: string): Promise<void> {
  while (procStartToken(pid) === startToken) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

export function isExpectedClaudeLoginCommand(commandLine: string): boolean {
  const args = commandLine.split("\0").filter(Boolean);
  const direct = /(?:^|\/)claude$/.test(args[0] ?? "") && args.length === 4;
  const wrapped = /(?:^|\/)(?:node|bun)$/.test(args[0] ?? "") && /claude/i.test(args[1] ?? "") && args.length === 5;
  /* Inside the Docker runtime `claude` is the nsenter shim — a /bin/sh script —
     so the spawned pid's cmdline reads `/bin/sh /usr/local/bin/claude auth
     login --claudeai`. Without this form the fence rejects every container
     login with launch_unfenced. */
  const shimmed = /(?:^|\/)(?:sh|dash|bash)$/.test(args[0] ?? "") && /(?:^|\/)claude$/.test(args[1] ?? "") && args.length === 5;
  const offset = direct ? 1 : wrapped || shimmed ? 2 : -1;
  return offset >= 0 && args[offset] === "auth" && args[offset + 1] === "login" && args[offset + 2] === "--claudeai";
}

function expectedClaude(pid: number): boolean {
  try { return isExpectedClaudeLoginCommand(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8")); } catch { return false; }
}

/** A recognized Claude home is either a safe managed home or the exact legacy
    Main home. Both reauthenticate in place; nothing else may direct the login. */
export function isSupervisedClaudeHome(home: string): boolean {
  return isManagedClaudeHome(home) || home === legacyClaudeHome();
}

/** Status reads target the exact account home with inherited provider auth
    variables cleared, so a legacy or managed check reflects the OAuth
    credentials at that home rather than an ambient API key. An unrecognized
    home keeps the plain process environment. */
export function claudeStatusEnvironment(home: string): NodeJS.ProcessEnv {
  return isSupervisedClaudeHome(home) ? claudeManagedEnvironment(home) : process.env;
}

async function structuredStatus(home: string): Promise<{ loggedIn: boolean; method: string | null; email: string | null; plan: string | null }> {
  return await new Promise((resolve) => {
    const child = spawn(resolveBinary("claude"), ["auth", "status", "--json"], { env: claudeStatusEnvironment(home), stdio: ["ignore", "pipe", "ignore"], detached: false });
    let text = "";
    child.stdout?.on("data", (part: Buffer) => { if (text.length < OUTPUT_LIMIT) text += part.toString("utf8"); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ loggedIn: false, method: null, email: null, plan: null }); }, 5_000);
    child.once("close", () => {
      clearTimeout(timer);
      try {
        const raw = JSON.parse(text) as Record<string, unknown>;
        resolve({ loggedIn: raw.loggedIn === true, method: typeof raw.authMethod === "string" ? raw.authMethod : null, email: typeof raw.email === "string" ? raw.email : null, plan: typeof raw.subscriptionType === "string" ? raw.subscriptionType : null });
      } catch { resolve({ loggedIn: false, method: null, email: null, plan: null }); }
    });
    child.once("error", () => { clearTimeout(timer); resolve({ loggedIn: false, method: null, email: null, plan: null }); });
  });
}

export const realClaudeLoginPorts: ClaudeLoginPorts = {
  spawn: (command, args, options) => spawn(command, args, options) as LoginChild,
  kill: (pid, signal) => { try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* process already exited */ } } },
  pidStartToken: procStartToken,
  isExpectedClaude: expectedClaude,
  waitForExit: waitForProcessExit,
  status: structuredStatus,
  now: Date.now,
  setTimeout,
  clearTimeout,
};

const fileClaudeLoginStore: ClaudeLoginStore = {
  load: () => JSON.parse(fs.readFileSync(statePath("claude-auth-operations.json"), "utf8")) as PersistedOperation[],
  save: (rows) => {
    const file = statePath("claude-auth-operations.json");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 });
      const fd = fs.openSync(tmp, "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
      const directory = fs.openSync(path.dirname(file), "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
    finally { fs.rmSync(tmp, { force: true }); }
  },
};

export function cleanClaudeLoginOutput(chunk: string): string { return chunk.replace(ANSI, "").replace(/\r/g, ""); }

/** Only the browser destination from Claude stdout crosses this module's interface. */
export function loginUrlFromOutput(output: string): string | null {
  for (const raw of output.match(URL_PATTERN) ?? []) {
    try {
      const parsed = new URL(raw);
      if (URL_HOSTS.has(parsed.hostname)) return parsed.toString();
    } catch { /* malformed text is never surfaced */ }
  }
  return null;
}

function terminal(phase: LoginPhase): boolean {
  return phase === "authenticated" || phase === "canceled" || phase === "timed_out" || phase === "failed" || phase === "interrupted";
}

export const LIVE_CLAUDE_LOGIN_PHASES: ReadonlySet<LoginPhase> = new Set(["starting", "awaiting_browser", "awaiting_code", "verifying", "canceling"]);

function validPersistedOperation(value: unknown): value is PersistedOperation {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<PersistedOperation>;
  return typeof row.operationId === "string" && row.operationId.length > 0
    && (typeof row.accountId === "string" || row.accountId === null)
    && typeof row.phase === "string" && LIVE_CLAUDE_LOGIN_PHASES.has(row.phase as LoginPhase)
    && (typeof row.pid === "number" && Number.isInteger(row.pid) && row.pid > 0 || row.pid === null)
    && (typeof row.startToken === "string" || row.startToken === null)
    && typeof row.generation === "number" && Number.isInteger(row.generation) && row.generation >= 0
    && typeof row.startedAt === "string" && Number.isFinite(Date.parse(row.startedAt))
    && typeof row.deadlineAt === "string" && Number.isFinite(Date.parse(row.deadlineAt));
}

function loginResult(status: LoginResult["status"], code: string, message: string): LoginResult {
  return { status, code, message };
}

/** Supervises one pipe-backed Claude login without exposing process output or filesystem state. */
export class ClaudeLoginSupervisor {
  private operations = new Map<string, LoginOperation>();
  private children = new Map<string, LoginChild>();
  private timers = new Map<string, NodeJS.Timeout>();
  private output = new Map<string, string>();
  private closed = new Map<string, Promise<void>>();
  private generation = 0;
  private persistDirty = false;
  private deferredPersist: Promise<void> | null = null;

  private readonly recovery: Promise<void>;

  constructor(private readonly ports: ClaudeLoginPorts = realClaudeLoginPorts, private readonly store: ClaudeLoginStore = fileClaudeLoginStore) {
    this.recovery = this.reconcilePersisted();
  }

  /** Waits for persisted login recovery. Tests and startup callers can use this
      before reading a terminal recovery result. */
  whenRecovered(): Promise<void> { return this.recovery; }

  private persistedOperations(): PersistedOperation[] {
    return [...this.operations.values()]
      .filter((item) => !terminal(item.phase))
      .map(({ operationId, accountId, phase, pid, startToken, generation, startedAt, deadlineAt }) => ({ operationId, accountId, phase, pid, startToken, generation, startedAt, deadlineAt }));
  }

  private persist(): void {
    try {
      withAccountMutationLock(() => this.store.save(this.persistedOperations()));
    } catch (error) {
      if (!(error instanceof AccountMutationBusyError)) throw error;
      this.queuePersist();
    }
  }

  private queuePersist(): void {
    this.persistDirty = true;
    if (this.deferredPersist) return;
    const drain = async () => {
      while (this.persistDirty) {
        this.persistDirty = false;
        await withAccountMutationLockAsync(async () => this.store.save(this.persistedOperations()));
      }
    };
    const pending = drain();
    this.deferredPersist = pending;
    void pending.then(
      () => {
        this.deferredPersist = null;
        if (this.persistDirty) this.queuePersist();
      },
      () => {
        this.deferredPersist = null;
        const live = [...this.operations.values()].find((item) => !terminal(item.phase));
        if (live) this.persistenceFailure(live.operationId);
      },
    );
  }

  private refreshDurableOperations(): void {
    let rows: PersistedOperation[];
    try { rows = this.store.load(); } catch { return; }
    for (const row of rows) {
      if (!validPersistedOperation(row)) continue;
      this.generation = Math.max(this.generation, row.generation);
      if (this.operations.has(row.operationId)) continue;
      this.operations.set(row.operationId, {
        ...row,
        loginUrl: null,
        acceptsCode: false,
        result: null,
        submitted: row.phase === "verifying",
      });
    }
  }

  private summary(item: LoginOperation): LoginOperationSummary {
    const { operationId, phase, loginUrl, acceptsCode, deadlineAt, result } = item;
    return { operationId, phase, loginUrl, acceptsCode, deadlineAt, result };
  }

  private update(id: string, patch: Partial<LoginOperation>): LoginOperation {
    const current = this.operations.get(id);
    if (!current) throw new Error("unknown Claude login operation");
    const next = { ...current, ...patch };
    this.operations.set(id, next);
    try { this.persist(); } catch (error) { this.operations.set(id, current); throw error; }
    return next;
  }

  reserve(): LoginOperationSummary {
    this.refreshDurableOperations();
    if ([...this.operations.values()].some((item) => !terminal(item.phase))) throw new Error("a Claude login operation is already running");
    const now = this.ports.now();
    const item: LoginOperation = {
      operationId: crypto.randomUUID(), accountId: null, phase: "starting", loginUrl: null, acceptsCode: false,
      deadlineAt: new Date(now + LOGIN_TIMEOUT_MS).toISOString(), result: null, pid: null, startToken: null,
      generation: ++this.generation, submitted: false, startedAt: new Date(now).toISOString(),
    };
    this.operations.set(item.operationId, item);
    try { this.persist(); } catch (error) { this.operations.delete(item.operationId); throw error; }
    return this.summary(item);
  }

  abandon(operationId: string): void {
    const item = this.operations.get(operationId);
    if (!item || terminal(item.phase)) return;
    try { this.finish(operationId, "failed", loginResult("failure", "account_creation_failed", "Claude account creation could not complete")); }
    catch { this.persistenceFailure(operationId); }
  }

  start(accountId: string, reservationId?: string): LoginOperationSummary {
    let operationId: string | null = null;
    let spawned: LoginOperation | null = null;
    try {
      if (reservationId) {
        const reserved = this.operations.get(reservationId);
        if (!reserved || terminal(reserved.phase) || reserved.accountId !== null) throw new Error("Claude login reservation is unavailable");
        operationId = reservationId;
        this.update(operationId, { accountId });
      } else {
        operationId = this.reserve().operationId;
        this.update(operationId, { accountId });
      }
      const id = operationId;
      if (!id) throw new Error("Claude login operation is unavailable");
      const account = claudeAccountForSpawn(accountId);
      // Legacy Main reauthenticates at its exact legacy home; managed accounts at
      // their safe managed home. claudeManagedEnvironment pins CLAUDE_CONFIG_DIR to
      // that home and strips inherited provider auth variables for either kind.
      if (!isSupervisedClaudeHome(account.home)) throw new Error("unsafe Claude account");
      const child = this.ports.spawn(resolveBinary("claude"), ["auth", "login", "--claudeai"], {
        cwd: osHome(), env: { ...claudeManagedEnvironment(account.home), UMASK: "077" }, detached: true, stdio: ["pipe", "pipe", "pipe"],
      });
      const pid = child.pid ?? null;
      const startToken = pid ? this.ports.pidStartToken(pid) : null;
      if (!pid || !startToken || !this.ports.isExpectedClaude(pid)) {
        child.stdin?.end();
        /* The child was already spawned; without a kill a fence rejection
           leaks a live interactive `claude auth login` process on the host.
           Kill through the child handle, never through ports.kill(pid): the
           pid failed the identity fence, so signaling it by number is exactly
           what the fence exists to prevent. */
        try { child.kill?.("SIGKILL"); } catch { /* already gone */ }
        return this.summary(this.finish(id, "failed", loginResult("failure", "launch_unfenced", "Claude login process could not be verified")));
      }
      const current = this.operations.get(id)!;
      spawned = { ...current, pid, startToken, phase: "awaiting_browser" };
      const started = this.update(id, { pid, startToken, phase: "awaiting_browser" });
      this.children.set(id, child);
      this.captureStdout(id, child.stdout);
      child.stderr?.on("data", () => undefined);
      this.closed.set(id, new Promise((resolve) => child.once("close", () => resolve())));
      child.once("close", () => { void this.reconcileExit(id, account.home).catch(() => this.persistenceFailure(id)); });
      child.once("error", () => {
        const current = this.operations.get(id);
        if (!current || terminal(current.phase)) return;
        try { this.finish(id, "failed", loginResult("failure", "process_failed", "Claude login process ended unexpectedly")); }
        catch { this.persistenceFailure(id); }
      });
      const timer = this.ports.setTimeout(() => { void this.timeout(id).catch(() => this.persistenceFailure(id)); }, LOGIN_TIMEOUT_MS);
      this.timers.set(id, timer);
      return this.summary(started);
    } catch {
      if (spawned) {
        return this.summary(this.persistenceFailure(operationId!, spawned));
      }
      if (operationId) {
        try { return this.summary(this.finish(operationId, "failed", loginResult("failure", "start_failed", "Claude login could not start"))); }
        catch { return this.summary(this.persistenceFailure(operationId)); }
      }
      throw new Error("Claude login could not start");
    }
  }

  private captureStdout(id: string, stream: NodeJS.ReadableStream | null | undefined): void {
    stream?.on("data", (chunk: Buffer | string) => {
      const operation = this.operations.get(id);
      if (!operation || operation.phase !== "awaiting_browser") return;
      const prior = this.output.get(id) ?? "";
      const text = cleanClaudeLoginOutput(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
      const next = (prior + text).slice(-OUTPUT_LIMIT);
      this.output.set(id, next);
      const url = loginUrlFromOutput(next);
      if (!url) return;
      try { this.update(id, { loginUrl: url, phase: "awaiting_code", acceptsCode: true }); }
      catch { this.persistenceFailure(id); }
    });
  }

  async input(operationId: string, code: string): Promise<LoginOperationSummary> {
    this.refreshDurableOperations();
    const item = this.operations.get(operationId);
    if (!item || terminal(item.phase)) throw new Error("login operation is unavailable");
    if (item.submitted) throw new Error("login code was already submitted");
    if (item.phase !== "awaiting_code" || !item.acceptsCode) throw new Error("login operation is not ready for code input");
    if (!/^[\x20-\x7e]{1,8192}$/.test(code) || code.length > CODE_LIMIT) throw new Error("login code is invalid");
    const child = this.children.get(operationId);
    if (!child?.stdin) throw new Error("login process is unavailable");
    let verifying: LoginOperation;
    try { verifying = this.update(operationId, { submitted: true, acceptsCode: false, phase: "verifying" }); }
    catch { return this.summary(this.persistenceFailure(operationId)); }
    try { child.stdin.write(code + "\n"); }
    catch {
      this.terminateWithEscalation(verifying);
      try { return this.summary(this.finish(operationId, "failed", loginResult("failure", "input_failed", "Claude login could not verify the code"))); }
      catch { return this.summary(this.persistenceFailure(operationId)); }
    }
    return this.summary(verifying);
  }

  private ownsProcess(item: LoginOperation): item is LoginOperation & { pid: number; startToken: string } {
    return item.pid !== null && item.startToken !== null
      && this.ports.pidStartToken(item.pid) === item.startToken
      && this.ports.isExpectedClaude(item.pid);
  }

  private terminate(item: LoginOperation, signal: NodeJS.Signals): void {
    if (this.ownsProcess(item)) this.ports.kill(item.pid, signal);
  }

  private terminateWithEscalation(item: LoginOperation): void {
    this.terminate(item, "SIGTERM");
    this.ports.setTimeout(() => this.terminate(item, "SIGKILL"), TERM_GRACE_MS);
  }

  private releaseRuntime(id: string): void {
    const timer = this.timers.get(id);
    if (timer) this.ports.clearTimeout(timer);
    this.timers.delete(id);
    this.children.delete(id);
    this.closed.delete(id);
    this.output.delete(id);
  }

  private persistenceFailure(id: string, fallback?: LoginOperation): LoginOperation {
    const current = fallback ?? this.operations.get(id);
    if (!current) throw new Error("Claude login persistence failed");
    this.terminateWithEscalation(current);
    this.releaseRuntime(id);
    const failed: LoginOperation = {
      ...current,
      phase: "failed",
      acceptsCode: false,
      loginUrl: null,
      result: loginResult("failure", "persistence_failed", "Claude login state could not be saved"),
      pid: null,
      startToken: null,
    };
    this.operations.set(id, failed);
    return failed;
  }

  private async awaitClose(id: string): Promise<void> {
    const closed = this.closed.get(id);
    if (!closed) return;
    await Promise.race([closed, new Promise<void>((resolve) => this.ports.setTimeout(resolve, TERM_GRACE_MS))]);
  }

  async cancel(operationId: string): Promise<LoginOperationSummary> {
    this.refreshDurableOperations();
    const item = this.operations.get(operationId);
    if (!item) throw new Error("unknown Claude login operation");
    if (terminal(item.phase) || item.phase === "canceling") return this.summary(item);
    try { this.update(operationId, { phase: "canceling" }); }
    catch { return this.summary(this.persistenceFailure(operationId)); }
    this.terminate(item, "SIGTERM");
    await new Promise<void>((resolve) => this.ports.setTimeout(resolve, TERM_GRACE_MS));
    const current = this.operations.get(operationId);
    if (current) this.terminate(current, "SIGKILL");
    await this.awaitClose(operationId);
    try { return this.summary(this.finish(operationId, "canceled", loginResult("canceled", "canceled", "Claude login was canceled"))); }
    catch { return this.summary(this.persistenceFailure(operationId)); }
  }

  private async timeout(id: string): Promise<void> {
    const item = this.operations.get(id);
    if (!item || terminal(item.phase) || item.phase === "canceling") return;
    try { this.update(id, { phase: "canceling" }); }
    catch { this.persistenceFailure(id); return; }
    this.terminate(item, "SIGTERM");
    await new Promise<void>((resolve) => this.ports.setTimeout(resolve, TERM_GRACE_MS));
    const current = this.operations.get(id);
    if (current) this.terminate(current, "SIGKILL");
    await this.awaitClose(id);
    try { this.finish(id, "timed_out", loginResult("failure", "timed_out", "Claude login timed out")); }
    catch { this.persistenceFailure(id); }
  }

  private async reconcileExit(id: string, home: string): Promise<void> {
    const item = this.operations.get(id);
    if (!item || terminal(item.phase) || item.phase === "canceling") return;
    try {
      this.update(id, { phase: "verifying" });
      const status = await this.ports.status(home);
      const current = this.operations.get(id);
      if (!current || current.phase !== "verifying") return;
      const credentialsSafe = !status.loggedIn || managedClaudeCredentialIsSafe(home, true);
      try {
        this.finish(
          id,
          status.loggedIn && credentialsSafe ? "authenticated" : "failed",
          status.loggedIn && credentialsSafe
            ? loginResult("success", "authenticated", "Claude authentication completed")
            : loginResult("failure", "verification_failed", "Claude authentication could not be verified"),
        );
      } catch { this.persistenceFailure(id); }
    } catch {
      try { this.finish(id, "failed", loginResult("failure", "verification_failed", "Claude authentication could not be verified")); }
      catch { this.persistenceFailure(id); }
    }
  }

  private finish(id: string, phase: Extract<LoginPhase, "authenticated" | "canceled" | "timed_out" | "failed" | "interrupted">, result: LoginResult): LoginOperation {
    const completed = this.update(id, { phase, acceptsCode: false, result, pid: null, startToken: null });
    this.releaseRuntime(id);
    return completed;
  }

  get(id: string): LoginOperationSummary | null {
    this.refreshDurableOperations();
    const item = this.operations.get(id);
    return item ? this.summary(item) : null;
  }

  forAccount(accountId: string): LoginOperationSummary | null {
    return this.forAccounts([accountId]).get(accountId) ?? null;
  }

  forAccounts(accountIds: readonly string[]): Map<string, LoginOperationSummary | null> {
    let durable: PersistedOperation[] = [];
    let durableReadable = true;
    try { durable = this.store.load().filter(validPersistedOperation); }
    catch { durableReadable = false; }
    return new Map(accountIds.map((accountId) => {
      const persisted = durable.filter((candidate) => candidate.accountId === accountId).sort((a, b) => b.generation - a.generation)[0];
      if (persisted) {
        const local = this.operations.get(persisted.operationId);
        if (local) return [accountId, this.summary(local)];
        return [accountId, {
          operationId: persisted.operationId,
          phase: persisted.phase,
          loginUrl: null,
          acceptsCode: false,
          deadlineAt: persisted.deadlineAt,
          result: null,
        }];
      }
      const item = [...this.operations.values()]
        .filter((candidate) => candidate.accountId === accountId && (terminal(candidate.phase) || !durableReadable))
        .sort((a, b) => b.generation - a.generation)[0];
      return [accountId, item ? this.summary(item) : null];
    }));
  }

  private async terminateInherited(item: LoginOperation): Promise<boolean> {
    if (!this.ownsProcess(item)) return true;
    this.terminate(item, "SIGTERM");
    await this.ports.waitForExit(item.pid, item.startToken);
    if (!this.ownsProcess(item)) return true;
    this.terminate(item, "SIGKILL");
    await this.ports.waitForExit(item.pid, item.startToken);
    return !this.ownsProcess(item);
  }

  private async reconcilePersisted(): Promise<void> {
    try {
      const rows = this.store.load();
      for (const row of rows) {
        if (!validPersistedOperation(row)) continue;
        this.generation = Math.max(this.generation, row.generation);
        const inherited: LoginOperation = { ...row, loginUrl: null, acceptsCode: false, result: null, submitted: false };
        this.operations.set(inherited.operationId, { ...inherited, phase: "canceling" });
        this.persist();

        const terminated = await this.terminateInherited(inherited);
        let authenticated = false;
        if (terminated && typeof inherited.accountId === "string") {
          try {
            const account = claudeAccountForSpawn(inherited.accountId);
            // Verify recovery for either a safe managed home or the exact legacy
            // Main home, and only when its credential file passes the safety check.
            if (isSupervisedClaudeHome(account.home) && managedClaudeCredentialIsSafe(account.home, true)) {
              const status = await this.ports.status(account.home);
              authenticated = status.loggedIn;
            }
          } catch { /* recovery publishes interruption when verification fails */ }
        }

        this.operations.set(inherited.operationId, {
          ...inherited,
          phase: authenticated ? "authenticated" : "interrupted",
          result: authenticated
            ? loginResult("success", "authenticated", "Claude authentication completed")
            : loginResult("failure", "interrupted", "Claude login was interrupted by restart"),
          pid: null,
          startToken: null,
        });
      }
      this.persist();
    } catch { /* absent or corrupt recovery state starts clean */ }
  }
}

function osHome(): string { return process.env.HOME || "/"; }

const defaultClaudeLoginSupervisor = new ClaudeLoginSupervisor();
export let claudeLoginSupervisor = defaultClaudeLoginSupervisor;

export function setClaudeLoginSupervisorForTests(supervisor: ClaudeLoginSupervisor | null): void {
  claudeLoginSupervisor = supervisor ?? defaultClaudeLoginSupervisor;
}
