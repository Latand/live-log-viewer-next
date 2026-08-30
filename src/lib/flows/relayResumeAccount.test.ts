import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";

import type { Flow } from "./types";

/*
 * #1279, the ninth account-selecting path: the LEGACY relay resume.
 *
 * `sendToImplementer`'s tmux ladder built its resume spec without naming an
 * account, and on a cut-over machine every account's `projects` is a symlink
 * into ONE shared root, so the transcript path names no owner (#935). The
 * ownership fallback then answered with the engine's ACTIVE account: a review
 * verdict could be handed back to the implementer under an account nobody
 * chose for it, with neither the project's pool nor any quota consulted.
 *
 * The fix is continuity, not a new selection — the registry already records
 * which account the work runs on, exactly as `deliverConversationMessage`
 * reads it. These two cases are the before and after of that read.
 */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-relay-account-test-"));
const STATE = path.join(SANDBOX, "state");
const RECORD = path.join(STATE, "account-project-bindings.json");
process.env.LLV_STATE_DIR = STATE;
process.env.LLV_CLAUDE_HOME = path.join(SANDBOX, "legacy-claude");

const claude = await import("@/lib/accounts/claude");
const { agentRegistry } = await import("@/lib/agent/registry");
const { sendToImplementer } = await import("./engine");

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

/** The cut-over layout: two managed homes whose `projects` both point at the
    one shared root, and a transcript sitting in it that names neither. */
function sharedStoreMachine(name: string): { transcript: string; homes: string[] } {
  const shared = claude.sharedClaudeProjectsRoot();
  fs.mkdirSync(shared, { recursive: true, mode: 0o700 });
  const legacy = process.env.LLV_CLAUDE_HOME!;
  fs.mkdirSync(legacy, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(path.join(legacy, "projects"))) fs.symlinkSync(shared, path.join(legacy, "projects"));
  const homes: string[] = [];
  for (const label of ["Account A", "Account B"]) {
    const account = claude.listClaudeAccounts().find((item) => item.label === label)
      ?? claude.createManagedClaudeAccount(label);
    fs.rmSync(path.join(account.home, "projects"), { recursive: true, force: true });
    if (!fs.existsSync(path.join(account.home, "projects"))) fs.symlinkSync(shared, path.join(account.home, "projects"));
    /* Present enough to be a candidate the automatic rule may draw. */
    fs.writeFileSync(path.join(account.home, ".credentials.json"), "{}", { mode: 0o600 });
    homes.push(account.home);
  }
  const project = path.join(shared, "-repo");
  fs.mkdirSync(project, { recursive: true, mode: 0o700 });
  /* Assembled from parts: a session-id-shaped literal is a publication
     violation in this repository even when the value is invented. */
  const sessionId = ["12345678", "1234", "1234", "1234", name].join("-");
  const transcript = path.join(project, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, "{}\n", { mode: 0o600 });
  return { transcript, homes };
}

function claudeEntry(pathname: string): FileEntry {
  return {
    path: pathname,
    root: "claude-projects",
    name: path.basename(pathname),
    project: "repo",
    title: "implementer",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    mtime: Date.now() / 1_000,
    size: 1,
    cwd: "/repo",
  } as unknown as FileEntry;
}

const PROJECT = "project-atlas";

/** The project's pool, as the accounts panel writes it. */
function bind(accountId: string): void {
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(RECORD, JSON.stringify({
    schemaVersion: 1,
    bindings: [{ engine: "claude", accountId, project: PROJECT, createdAt: new Date(Date.now() - 60_000).toISOString() }],
  }), "utf8");
}

/** A fresh, live, believed sample with `usedPercent` already burned. */
function burn(accountId: string, usedPercent: number): void {
  const now = Date.now();
  agentRegistry().recordQuotaEvaluation({
    engine: "claude",
    observations: [{
      engine: "claude",
      accountId,
      authenticated: true,
      authCheckedAt: new Date(now - 1_000).toISOString(),
      limits: {
        session: { usedPercent, resetsAt: Math.floor(now / 1_000) + 3_600 },
        weekly: null,
        plan: "max",
        capturedAt: Math.floor((now - 1_000) / 1_000),
      },
      provenance: { source: "live", reason: null, staleSince: null },
      observedAt: new Date(now - 1_000).toISOString(),
      bootId: "boot-flow-relay-account",
    }],
    signature: null,
    bootId: "boot-flow-relay-account",
    now: new Date(now).toISOString(),
    minimumGapMs: 60_000,
  });
}

async function relaySpecFor(transcript: string, project: string | null = null): Promise<string> {
  const conversation = agentRegistry().conversationForPath(transcript);
  const flow = {
    id: "flow-relay-account",
    cwd: "/repo",
    project,
    implementerPath: transcript,
    implementerConversationId: conversation?.id ?? null,
    hostClaim: null,
  } as unknown as Flow;
  let command = "";
  await sendToImplementer(flow, new Map([[transcript, claudeEntry(transcript)]]), "APPROVE", {
    /* No structured host: the legacy tmux ladder is the path under test. */
    recover: async () => null,
    deliver: async ({ spec }) => {
      command = spec.command;
      return { ok: true, outcome: "delivered-to-live", target: "%1" };
    },
  });
  return command;
}

test("a legacy relay resumes the implementer on the account the work is recorded on, not the routed one", async () => {
  const { transcript, homes } = sharedStoreMachine("aaaaaaaaaaaa");
  const accounts = claude.listClaudeAccounts().filter((item) => homes.includes(item.home));
  const recorded = accounts.at(-1)!;
  const routed = accounts[0]!;
  expect(recorded.id).not.toBe(routed.id);
  /* Containment can only guess here: both homes resolve to the same root. */
  expect(new Set(accounts.map((item) => item.projectsDir)).size).toBe(1);
  claude.setActiveClaudeAccount(routed.id);
  agentRegistry().ensureConversation("claude", transcript, recorded.id);

  const command = await relaySpecFor(transcript);

  expect(command).toContain(recorded.home);
  expect(command).not.toContain(routed.home);
});

test("a legacy relay for work recorded on the routed account is unchanged", async () => {
  const { transcript, homes } = sharedStoreMachine("bbbbbbbbbbbb");
  const accounts = claude.listClaudeAccounts().filter((item) => homes.includes(item.home));
  const routed = accounts[0]!;
  claude.setActiveClaudeAccount(routed.id);
  agentRegistry().ensureConversation("claude", transcript, routed.id);

  const command = await relaySpecFor(transcript);

  expect(command).toContain(routed.home);
});

/*
 * The tenth path, and the half the ninth left open: a relay whose implementer
 * records NO account. Passing provenance is only continuity when there IS
 * provenance — an adopted thread has none, and the ownership fallback then
 * answered from the engine's ACTIVE account for any transcript in the shared
 * store. That is a pick, so it obeys the automatic rule like every other one.
 */
test("a legacy relay for work that records no account draws from the project's pool (#1279)", async () => {
  const { transcript, homes } = sharedStoreMachine("cccccccccccc");
  const accounts = claude.listClaudeAccounts().filter((item) => homes.includes(item.home));
  const routed = accounts[0]!;
  const pooled = accounts.at(-1)!;
  expect(routed.id).not.toBe(pooled.id);
  claude.setActiveClaudeAccount(routed.id);
  agentRegistry().setEngineRouting("claude", routed.id);
  /* Deliberately NOT recorded: this is the adopted conversation. */
  bind(pooled.id);

  const command = await relaySpecFor(transcript, PROJECT);

  expect(command).toContain(pooled.home);
  expect(command).not.toContain(routed.home);
});

test("a legacy relay on an unbound project keeps the fallback it always had (#1279)", async () => {
  const { transcript, homes } = sharedStoreMachine("dddddddddddd");
  const accounts = claude.listClaudeAccounts().filter((item) => homes.includes(item.home));
  const routed = accounts[0]!;
  claude.setActiveClaudeAccount(routed.id);
  agentRegistry().setEngineRouting("claude", routed.id);
  fs.rmSync(RECORD, { force: true });

  const command = await relaySpecFor(transcript, PROJECT);

  expect(command).toContain(routed.home);
});

test("a legacy relay refuses rather than deliver on a pooled account with no capacity (#1279)", async () => {
  const { transcript, homes } = sharedStoreMachine("eeeeeeeeeeee");
  const accounts = claude.listClaudeAccounts().filter((item) => homes.includes(item.home));
  const routed = accounts[0]!;
  const pooled = accounts.at(-1)!;
  claude.setActiveClaudeAccount(routed.id);
  agentRegistry().setEngineRouting("claude", routed.id);
  bind(pooled.id);
  /* The pool's one account is spent and the routed one is idle beside it.
     Reaching for the idle one is the boundary crossing the pool prevents. */
  burn(pooled.id, 100);

  const refused = await relaySpecFor(transcript, PROJECT).then(() => null, (error: unknown) => error);
  expect((refused as Error).name).toBe("ProjectAccountRefusedError");
  expect((refused as Error).message).toContain("no allowed claude account has capacity");
  expect((refused as Error).message).not.toContain(routed.id);
});

test("a damaged binding record refuses a legacy relay before it delivers anything (#1279)", async () => {
  const { transcript, homes } = sharedStoreMachine("ffffffffffff");
  const routed = claude.listClaudeAccounts().filter((item) => homes.includes(item.home))[0]!;
  claude.setActiveClaudeAccount(routed.id);
  agentRegistry().setEngineRouting("claude", routed.id);
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(RECORD, '{"schemaVersion":1,"bindings":[{"engine":"claude"', "utf8");

  const refused = await relaySpecFor(transcript, PROJECT).then(() => null, (error: unknown) => error);
  expect((refused as Error).name).toBe("AccountProjectBindingsUnreadableError");
  fs.rmSync(RECORD, { force: true });
});
