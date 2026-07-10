import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { accountManager } from "@/lib/accounts/manager";
import type { AccountContext, AccountManager } from "@/lib/accounts/contracts";
import { CodexAppServerClient } from "@/lib/accounts/codexAppServer";
import { realClaudeLoginPorts } from "@/lib/accounts/claudeLogin";
import { claudeSuccessorSpecFor } from "@/lib/agent/cli";
import { spawnAgentWithPrompt } from "@/lib/tmux";

import type { LaunchProfile, ProviderReceipt, SuccessorProviderPort } from "./contracts";
import { hashValidatedHistory, safeCopyHistory, validateHistorySource } from "./safeHistoryCopy";

export interface ProviderDependencies {
  accounts: Pick<AccountManager, "resolveSpawn" | "resolveTranscriptOwner">;
  startCodex(home: string): Promise<CodexAppServerClient>;
  claudeStatus(home: string): Promise<{ loggedIn: boolean }>;
  spawnClaude(spec: ReturnType<typeof claudeSuccessorSpecFor>): Promise<{ paneId: string; panePid?: number }>;
  now(): string;
}

const defaultDependencies: ProviderDependencies = {
  accounts: accountManager,
  startCodex: (home) => CodexAppServerClient.start({ home }),
  claudeStatus: (home) => realClaudeLoginPorts.status(home),
  spawnClaude: (spec) => spawnAgentWithPrompt(spec, ""),
  now: () => new Date().toISOString(),
};

function candidateUuid(operationId: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) return operationId;
  const bytes = Buffer.from(crypto.createHash("sha256").update(operationId).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertRegisteredRoots(source: AccountContext | null, target: AccountContext, sourcePath: string): AccountContext {
  if (!source || source.engine !== target.engine) throw new Error("source account ownership is unavailable");
  validateHistorySource(sourcePath, source.transcriptRoot);
  return source;
}

function findCodexRollout(root: string, nativeId: string): string {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let visited = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (current.depth > 6) continue;
    for (const entry of fs.readdirSync(current.dir, { withFileTypes: true })) {
      if (++visited > 20_000) throw new Error("forked Codex history was not found within the scan bound");
      const candidate = path.join(current.dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push({ dir: candidate, depth: current.depth + 1 });
      else if (entry.isFile() && entry.name.endsWith(`${nativeId}.jsonl`)) return candidate;
    }
  }
  throw new Error("forked Codex history was not found");
}

function ensureTargetRoot(account: AccountContext): void {
  const home = fs.lstatSync(account.home);
  if (!home.isDirectory() || home.isSymbolicLink() || (process.getuid && home.uid !== process.getuid()) || (home.mode & 0o077) !== 0) {
    throw new Error("target account home failed safety checks");
  }
  if (path.dirname(path.resolve(account.transcriptRoot)) !== path.resolve(account.home)) throw new Error("target transcript root is outside its account home");
  try { fs.mkdirSync(account.transcriptRoot, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const root = fs.lstatSync(account.transcriptRoot);
  if (!root.isDirectory() || root.isSymbolicLink() || (process.getuid && root.uid !== process.getuid()) || (root.mode & 0o077) !== 0) {
    throw new Error("target transcript root failed safety checks");
  }
}

export class RegisteredSuccessorProvider implements SuccessorProviderPort {
  constructor(private readonly dependencies: ProviderDependencies = defaultDependencies) {}

  async create(input: Parameters<SuccessorProviderPort["create"]>[0]): Promise<ProviderReceipt> {
    const target = this.dependencies.accounts.resolveSpawn(input.engine, input.targetAccountId);
    const source = assertRegisteredRoots(this.dependencies.accounts.resolveTranscriptOwner(input.engine, input.source.path), target, input.source.path);
    ensureTargetRoot(target);
    return input.engine === "codex"
      ? this.createCodex(input.operationId, input.source.id, input.source.launchProfile, source, target)
      : this.createClaude(input.operationId, input.source.path, input.source.launchProfile, source, target);
  }

  async verify(receipt: ProviderReceipt, input: { engine: "claude" | "codex"; targetAccountId: string; launchProfile: LaunchProfile }): Promise<void> {
    const target = this.dependencies.accounts.resolveSpawn(input.engine, input.targetAccountId);
    ensureTargetRoot(target);
    if (input.engine === "claude") {
      const status = await this.dependencies.claudeStatus(target.home);
      if (!status.loggedIn) throw new Error("target Claude account is not authenticated");
      if (!receipt.path.startsWith(target.transcriptRoot + path.sep)) throw new Error("target Claude history is outside its registered root");
      return;
    }
    const client = await this.dependencies.startCodex(target.home);
    try {
      const account = await client.readAccount();
      if (!account.account || account.requiresOpenaiAuth) throw new Error("target Codex account is not authenticated");
      const thread = await client.readThread(receipt.nativeId);
      if (thread.id !== receipt.nativeId) throw new Error("target Codex thread identity does not match");
    } finally { client.close(); }
  }

  private async createClaude(operationId: string, sourcePath: string, profile: LaunchProfile, source: AccountContext, target: AccountContext): Promise<ProviderReceipt> {
    const status = await this.dependencies.claudeStatus(target.home);
    if (!status.loggedIn) throw new Error("target Claude account is not authenticated");
    const history = hashValidatedHistory(sourcePath, source.transcriptRoot);
    const nativeId = candidateUuid(operationId);
    const spec = claudeSuccessorSpecFor({ sourcePath, candidateId: nativeId, targetHome: target.home, targetProjectsDir: target.transcriptRoot, profile });
    const pane = await this.dependencies.spawnClaude(spec);
    return {
      operationId,
      nativeId,
      path: spec.transcript ?? path.join(target.transcriptRoot, `${nativeId}.jsonl`),
      historyHash: history.hash,
      host: { kind: "claude-stream", identity: `${pane.paneId}:${pane.panePid ?? "unknown"}`, epoch: 1, verifiedAt: this.dependencies.now() },
    };
  }

  private async createCodex(operationId: string, sourceNativeId: string, profile: LaunchProfile, source: AccountContext, target: AccountContext): Promise<ProviderReceipt> {
    const sourceClient = await this.dependencies.startCodex(source.home);
    let fork: Awaited<ReturnType<CodexAppServerClient["forkThread"]>>;
    try {
      const account = await sourceClient.readAccount();
      if (!account.account || account.requiresOpenaiAuth) throw new Error("source Codex account is not authenticated");
      fork = await sourceClient.forkThread(sourceNativeId);
    } finally { sourceClient.close(); }
    const sourceFork = fork.path ?? findCodexRollout(source.transcriptRoot, fork.id);
    const relative = path.relative(source.transcriptRoot, sourceFork);
    const copied = safeCopyHistory({
      sourcePath: sourceFork,
      sourceRoot: source.transcriptRoot,
      targetRoot: target.transcriptRoot,
      destinationRelative: relative,
      operationId,
    });
    const targetClient = await this.dependencies.startCodex(target.home);
    try {
      const account = await targetClient.readAccount();
      if (!account.account || account.requiresOpenaiAuth) throw new Error("target Codex account is not authenticated");
      const approvalPolicy = profile.permissionMode && ["never", "on-request", "untrusted"].includes(profile.permissionMode)
        ? profile.permissionMode
        : null;
      const resumed = await targetClient.resumeThread(fork.id, {
        path: copied.path,
        cwd: profile.cwd,
        model: profile.model,
        effort: profile.effort,
        fast: profile.fast,
        approvalPolicy,
        sandbox: profile.readOnly ? "read-only" : null,
      });
      if (resumed.id !== fork.id) throw new Error("target Codex resume returned another thread");
      if (profile.title) await targetClient.setThreadName(fork.id, profile.title);
      if (profile.goal?.objective) await targetClient.setThreadGoal(fork.id, profile.goal.objective, profile.goal.status);
      const verified = await targetClient.readThread(fork.id);
      if (verified.id !== fork.id) throw new Error("target Codex history verification failed");
    } finally { targetClient.close(); }
    return {
      operationId,
      nativeId: fork.id,
      path: copied.path,
      historyHash: copied.hash,
      host: { kind: "codex-app-server", identity: fork.id, epoch: 1, verifiedAt: this.dependencies.now() },
    };
  }
}

export function accountMigrationActivationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LLV_ACCOUNT_MIGRATION_ACTIVATE === "1" && env.LLV_ACCOUNT_MIGRATION_PROVIDER === "registered";
}
