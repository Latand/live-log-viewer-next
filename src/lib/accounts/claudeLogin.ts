import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveBinary } from "@/lib/agent/cli";
import { statePath } from "@/lib/configDir";

import type { LoginOperationSummary, LoginPhase } from "./contracts";
import { claudeAccountForSpawn, claudeManagedEnvironment, isManagedClaudeHome, managedClaudeCredentialIsSafe } from "./claude";

const OUTPUT_LIMIT = 64 * 1024;
const CODE_LIMIT = 8 * 1024;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const TERM_GRACE_MS = 2_000;
const URL_HOSTS = new Set(["claude.ai", "console.anthropic.com"]);
const ANSI = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const URL_PATTERN = /https:\/\/[^\s"'<>]+/g;

export type LoginOperation = LoginOperationSummary & { accountId: string | null; pid: number | null; startToken: string | null; generation: number; submitted: boolean; error: string | null; startedAt: string };
type PersistedOperation = Pick<LoginOperation, "operationId" | "accountId" | "phase" | "pid" | "startToken" | "generation" | "startedAt" | "deadlineAt">;

export interface LoginChild {
  pid?: number;
  stdin?: { write(data: string): boolean; end(): void } | null;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}
export interface ClaudeLoginPorts {
  spawn(command: string, args: string[], options: Parameters<typeof spawn>[2]): LoginChild;
  kill(pid: number, signal: NodeJS.Signals): void;
  pidStartToken(pid: number): string | null;
  isExpectedClaude(pid: number): boolean;
  status(home: string): Promise<{ loggedIn: boolean; method: string | null; email: string | null; plan: string | null }>;
  now(): number;
  setTimeout(callback: () => void, ms: number): NodeJS.Timeout;
  clearTimeout(timer: NodeJS.Timeout): void;
}

function procStartToken(pid: number): string | null { try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[21] ?? null; } catch { return null; } }
function expectedClaude(pid: number): boolean { try { return /(^|\0|\/)claude(?:\0|$)/.test(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8")); } catch { return false; } }
export function claudeStatusEnvironment(home: string): NodeJS.ProcessEnv {
  return isManagedClaudeHome(home) ? claudeManagedEnvironment(home) : process.env;
}

async function structuredStatus(home: string): Promise<{ loggedIn: boolean; method: string | null; email: string | null; plan: string | null }> {
  return await new Promise((resolve) => {
    const child = spawn(resolveBinary("claude"), ["auth", "status", "--json"], { env: claudeStatusEnvironment(home), stdio: ["ignore", "pipe", "ignore"], detached: false });
    let text = ""; child.stdout?.on("data", (part: Buffer) => { if (text.length < OUTPUT_LIMIT) text += part.toString("utf8"); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ loggedIn: false, method: null, email: null, plan: null }); }, 5_000);
    child.once("close", () => { clearTimeout(timer); try { const raw = JSON.parse(text) as Record<string, unknown>; resolve({ loggedIn: raw.loggedIn === true, method: typeof raw.authMethod === "string" ? raw.authMethod : null, email: typeof raw.email === "string" ? raw.email : null, plan: typeof raw.subscriptionType === "string" ? raw.subscriptionType : null }); } catch { resolve({ loggedIn: false, method: null, email: null, plan: null }); } });
    child.once("error", () => { clearTimeout(timer); resolve({ loggedIn: false, method: null, email: null, plan: null }); });
  });
}

export const realClaudeLoginPorts: ClaudeLoginPorts = {
  spawn: (command, args, options) => spawn(command, args, options) as LoginChild,
  kill: (pid, signal) => { try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* gone */ } } },
  pidStartToken: procStartToken,
  isExpectedClaude: expectedClaude,
  status: structuredStatus,
  now: Date.now,
  setTimeout,
  clearTimeout,
};

export function cleanClaudeLoginOutput(chunk: string): string { return chunk.replace(ANSI, "").replace(/\r/g, ""); }
export function loginUrlFromOutput(output: string): string | null {
  for (const raw of output.match(URL_PATTERN) ?? []) { try { const parsed = new URL(raw); if (URL_HOSTS.has(parsed.hostname)) return parsed.toString(); } catch { /* invalid URL */ } }
  return null;
}
function terminal(phase: LoginPhase): boolean { return phase === "authenticated" || phase === "canceled" || phase === "timed_out" || phase === "failed" || phase === "interrupted"; }
function safeError(error: unknown): string { return error instanceof Error ? error.message.replace(/https:\/\/\S+/g, "[redacted]").slice(0, 160) : "login process failed"; }

/** Supervised, pipe-backed Claude auth. It deliberately has no tmux dependency. */
export class ClaudeLoginSupervisor {
  private operations = new Map<string, LoginOperation>();
  private children = new Map<string, LoginChild>();
  private timers = new Map<string, NodeJS.Timeout>();
  private output = new Map<string, string>();
  private closed = new Map<string, Promise<void>>();
  private generation = 0;
  constructor(private readonly ports: ClaudeLoginPorts = realClaudeLoginPorts, private readonly enabled = () => process.env.LLV_ENABLE_CLAUDE_LOGIN === "1" && process.env.LLV_CLAUDE_LOGIN_POLICY_ACCEPTED === "1") { this.reconcilePersisted(); }

  private persist(): void {
    const data = [...this.operations.values()].filter((item) => !terminal(item.phase)).map(({ operationId, accountId, phase, pid, startToken, generation, startedAt, deadlineAt }) => ({ operationId, accountId, phase, pid, startToken, generation, startedAt, deadlineAt }));
    const file = statePath("claude-auth-operations.json"); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const tmp = `${file}.${process.pid}.tmp`; try { fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 }); fs.renameSync(tmp, file); } finally { fs.rmSync(tmp, { force: true }); }
  }
  private summary(item: LoginOperation): LoginOperationSummary { const { operationId, phase, loginUrl, acceptsCode, deadlineAt } = item; return { operationId, phase, loginUrl, acceptsCode, deadlineAt }; }
  private update(id: string, patch: Partial<LoginOperation>): LoginOperation { const current = this.operations.get(id); if (!current) throw new Error("unknown Claude login operation"); const next = { ...current, ...patch }; this.operations.set(id, next); this.persist(); return next; }

  reserve(): LoginOperationSummary {
    if (!this.enabled()) throw new Error("Claude login is disabled until LLV_ENABLE_CLAUDE_LOGIN=1 and LLV_CLAUDE_LOGIN_POLICY_ACCEPTED=1 are set");
    if ([...this.operations.values()].some((item) => !terminal(item.phase))) throw new Error("a Claude login operation is already running");
    const now = this.ports.now(); const item: LoginOperation = { operationId: crypto.randomUUID(), accountId: null, phase: "starting", loginUrl: null, acceptsCode: false, deadlineAt: new Date(now + LOGIN_TIMEOUT_MS).toISOString(), pid: null, startToken: null, generation: ++this.generation, submitted: false, error: null, startedAt: new Date(now).toISOString() };
    this.operations.set(item.operationId, item); this.persist(); return this.summary(item);
  }

  abandon(operationId: string): void {
    const item = this.operations.get(operationId); if (item && !terminal(item.phase)) this.finish(operationId, "failed", "Claude account creation did not complete");
  }

  start(accountId: string, reservationId?: string): LoginOperationSummary {
    let operationId: string;
    if (reservationId) {
      const reserved = this.operations.get(reservationId);
      if (!reserved || terminal(reserved.phase) || reserved.accountId !== null) throw new Error("Claude login reservation is unavailable");
      operationId = reservationId; this.update(operationId, { accountId });
    } else {
      operationId = this.reserve().operationId; this.update(operationId, { accountId });
    }
    try {
      const account = claudeAccountForSpawn(accountId); if (account.kind !== "managed" || !isManagedClaudeHome(account.home)) throw new Error("Claude login requires a safe managed account");
      const child = this.ports.spawn(resolveBinary("claude"), ["auth", "login", "--claudeai"], { cwd: osHome(), env: { ...claudeManagedEnvironment(account.home), UMASK: "077" }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      const pid = child.pid ?? null; const started = this.update(operationId, { pid, startToken: pid ? this.ports.pidStartToken(pid) : null, phase: "awaiting_browser" }); this.children.set(operationId, child); this.capture(operationId, child.stdout); this.capture(operationId, child.stderr); this.closed.set(operationId, new Promise((resolve) => child.once("close", () => resolve())));
      child.once("close", () => { void this.reconcileExit(operationId, account.home); }); child.once("error", (error) => { this.finish(operationId, "failed", safeError(error)); });
      const timer = this.ports.setTimeout(() => { void this.timeout(operationId); }, LOGIN_TIMEOUT_MS); this.timers.set(operationId, timer); return this.summary(started);
    } catch (error) { return this.summary(this.finish(operationId, "failed", safeError(error))); }
  }
  private capture(id: string, stream: NodeJS.ReadableStream | null | undefined): void { stream?.on("data", (chunk: Buffer | string) => { const prior = this.output.get(id) ?? ""; const text = cleanClaudeLoginOutput(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk); const next = (prior + text).slice(-OUTPUT_LIMIT); this.output.set(id, next); const url = loginUrlFromOutput(next); if (url) this.update(id, { loginUrl: url, phase: "awaiting_code", acceptsCode: true }); }); }
  async input(operationId: string, code: string): Promise<LoginOperationSummary> { const item = this.operations.get(operationId); if (!item || terminal(item.phase)) throw new Error("login operation is unavailable"); if (item.submitted) throw new Error("login code was already submitted"); if (!/^[\x20-\x7e]{1,8192}$/.test(code) || code.length > CODE_LIMIT) throw new Error("login code is invalid"); const child = this.children.get(operationId); if (!child?.stdin) throw new Error("login process is unavailable"); child.stdin.write(code + "\n"); this.update(operationId, { submitted: true, acceptsCode: false, phase: "verifying" }); return this.summary(this.operations.get(operationId)!); }
  private async awaitClose(id: string): Promise<void> { const closed = this.closed.get(id); if (!closed) return; await Promise.race([closed, new Promise<void>((resolve) => this.ports.setTimeout(resolve, TERM_GRACE_MS))]); }
  async cancel(operationId: string): Promise<LoginOperationSummary> { const item = this.operations.get(operationId); if (!item) throw new Error("unknown Claude login operation"); if (terminal(item.phase)) return this.summary(item); this.update(operationId, { phase: "canceling" }); if (item.pid) this.ports.kill(item.pid, "SIGTERM"); await new Promise<void>((resolve) => this.ports.setTimeout(resolve, TERM_GRACE_MS)); const current = this.operations.get(operationId); if (current?.pid && this.ports.pidStartToken(current.pid) === current.startToken) this.ports.kill(current.pid, "SIGKILL"); await this.awaitClose(operationId); return this.summary(this.finish(operationId, "canceled")); }
  private async timeout(id: string): Promise<void> { const item = this.operations.get(id); if (!item || terminal(item.phase)) return; this.update(id, { phase: "canceling" }); if (item.pid) this.ports.kill(item.pid, "SIGTERM"); await new Promise<void>((resolve) => this.ports.setTimeout(resolve, TERM_GRACE_MS)); const current = this.operations.get(id); if (current?.pid && this.ports.pidStartToken(current.pid) === current.startToken) this.ports.kill(current.pid, "SIGKILL"); await this.awaitClose(id); this.finish(id, "timed_out"); }
  private async reconcileExit(id: string, home: string): Promise<void> { const item = this.operations.get(id); if (!item || terminal(item.phase)) return; this.update(id, { phase: "verifying" }); try { const status = await this.ports.status(home); const credentialsSafe = !status.loggedIn || managedClaudeCredentialIsSafe(home, true); this.finish(id, status.loggedIn && credentialsSafe ? "authenticated" : "failed", status.loggedIn ? (credentialsSafe ? null : "Claude credentials failed safety checks") : "Claude authentication did not complete"); } catch { this.finish(id, "failed", "Claude authentication status could not be verified"); } }
  private finish(id: string, phase: Extract<LoginPhase, "authenticated" | "canceled" | "timed_out" | "failed" | "interrupted">, error: string | null = null): LoginOperation { const timer = this.timers.get(id); if (timer) this.ports.clearTimeout(timer); this.timers.delete(id); this.children.delete(id); this.closed.delete(id); this.output.delete(id); const result = this.update(id, { phase, acceptsCode: false, error, pid: null, startToken: null }); return result; }
  canStart(): boolean { return this.enabled(); }
  get(id: string): LoginOperationSummary | null { const item = this.operations.get(id); return item ? this.summary(item) : null; }
  forAccount(accountId: string): LoginOperationSummary | null { const item = [...this.operations.values()].filter((candidate) => candidate.accountId === accountId).sort((a, b) => b.generation - a.generation)[0]; return item ? this.summary(item) : null; }
  private reconcilePersisted(): void { try { const rows = JSON.parse(fs.readFileSync(statePath("claude-auth-operations.json"), "utf8")) as PersistedOperation[]; for (const row of rows) { if (!row || typeof row.operationId !== "string" || typeof row.accountId !== "string") continue; const safeCredentials = (() => { try { const account = claudeAccountForSpawn(row.accountId); return account.kind === "managed" && managedClaudeCredentialIsSafe(account.home, true); } catch { return false; } })(); if (!safeCredentials && typeof row.pid === "number" && this.ports.pidStartToken(row.pid) === row.startToken && this.ports.isExpectedClaude(row.pid)) { this.ports.kill(row.pid, "SIGTERM"); const pid = row.pid; const token = row.startToken; this.ports.setTimeout(() => { if (this.ports.pidStartToken(pid) === token && this.ports.isExpectedClaude(pid)) this.ports.kill(pid, "SIGKILL"); }, TERM_GRACE_MS); } const item: LoginOperation = { ...row, phase: safeCredentials ? "authenticated" : "interrupted", loginUrl: null, acceptsCode: false, submitted: false, error: safeCredentials ? null : "login interrupted by restart", pid: null, startToken: null }; this.operations.set(item.operationId, item); } this.persist(); } catch { /* no persisted operation */ } }
}

function osHome(): string { return process.env.HOME || "/"; }
export const claudeLoginSupervisor = new ClaudeLoginSupervisor();
