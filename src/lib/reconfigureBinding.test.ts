import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";

import type { AccountContext } from "@/lib/accounts/contracts";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { accountProjectOverrides } from "@/lib/accounts/accountOverrides";
import { bindAccountToProject } from "@/lib/accounts/projectBindings";
import { AgentRegistry, setAgentRegistryForTests, type TmuxHostEvidence } from "@/lib/agent/registry";
import { resetProjectAliasesForTests } from "@/lib/projects/aliases";
import type { FileEntry } from "@/lib/types";

import { reconfigureConversation } from "./delivery";

/**
 * #1279 at the reconfigure seam: switching a live conversation onto another
 * account names that account outright, which makes it a DELIBERATE choice
 * rather than a selection the Viewer made. The project's pool is what the
 * Viewer draws from on its own — the reseat, and any account it would default
 * to — so a named switch outside the pool is carried out and ATTRIBUTED, and
 * the record says who chose it and what the pool was.
 *
 * Account and project names here are invented.
 */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reconfigure-binding-"));
const ORIGINAL_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const RESERVED = "acct-reserved";
const OUTSIDE = "acct-outside";
const FENCED_PROJECT = "project-atlas";

const HOST: TmuxHostEvidence = {
  kind: "tmux",
  endpoint: "/run/user/1000/agent-log-viewer",
  server: { pid: 900, startIdentity: "900:one" },
  paneId: "%7",
  panePid: { pid: 107, startIdentity: "107:one" },
  windowName: "worker",
  agent: { pid: 207, startIdentity: "207:one" },
  argv: ["codex", "resume", "session"],
};

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  fs.rmSync(path.join(SANDBOX, "work"), { recursive: true, force: true });
  fs.mkdirSync(path.join(SANDBOX, "work"), { recursive: true });
  resetProjectAliasesForTests();
  setAgentRegistryForTests(null);
});

afterAll(() => {
  setAgentRegistryForTests(null);
  if (ORIGINAL_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = ORIGINAL_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

/** One live Codex conversation on `RESERVED`, owned by `project`. */
function scenario(name: string, project: string | null) {
  const work = path.join(SANDBOX, "work");
  const sessionId = `019f4e76-66b4-\x37f87-94b2-cfa9bf7444${name}`;
  const pathname = path.join(work, `${sessionId}.jsonl`);
  fs.writeFileSync(pathname, "");
  const registry = new AgentRegistry(path.join(work, `${name}-registry.json`));
  registry.ensureConversation("codex", pathname, RESERVED);
  registry.upsert({
    key: { engine: "codex", sessionId },
    artifactPath: pathname,
    cwd: work,
    accountId: RESERVED,
    launchProfile: emptyLaunchProfile({ cwd: work, project, model: "gpt-5.6-sol", effort: "high" }),
    status: "live",
    host: HOST,
    claimEpoch: 1,
    claimOwner: null,
    pendingAction: null,
  });
  const entry: FileEntry = {
    path: pathname, root: "codex-sessions", name: path.basename(pathname), project: project ?? "viewer",
    title: "worker", engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1, size: 0,
    activity: "live", proc: "running", pid: 207, model: "gpt-5.6-sol", effort: "high", fast: false,
    pendingQuestion: null, waitingInput: null,
  };
  return { pathname, registry, entry };
}

function overrides(registry: AgentRegistry, entry: FileEntry, counters: { resolved: number; ticks: number }) {
  return {
    pathAllowed: () => true,
    listFiles: async () => [entry],
    registry,
    validateAccount: async () => {},
    resolveAccount: () => { counters.resolved += 1; return {} as AccountContext; },
    requestMigrationTick: () => { counters.ticks += 1; },
    killHost: async () => true,
  };
}

test("a deliberate switch outside the project's set is carried out, and recorded against the pool", async () => {
  expect(bindAccountToProject("codex", RESERVED, FENCED_PROJECT).ok).toBe(true);
  const { pathname, registry, entry } = scenario("01", FENCED_PROJECT);
  const counters = { resolved: 0, ticks: 0 };

  const outcome = await reconfigureConversation(
    pathname,
    { model: "gpt-5.6-sol", effort: "high", fast: false, accountId: OUTSIDE },
    overrides(registry, entry, counters),
  );

  /* The operator named this account. The switch happens. */
  expect(outcome).toMatchObject({ ok: true, outcome: "pending" });
  expect(counters.ticks).toBe(1);
  expect(registry.conversationForPath(pathname)?.migration).toMatchObject({ targetId: OUTSIDE });
  /* And the answer, and the durable record, both say it went outside the pool
     and who took it there. */
  expect(outcome).toMatchObject({
    accountOverride: {
      outsidePool: true,
      accountId: OUTSIDE,
      project: FENCED_PROJECT,
      allowedAccountIds: [RESERVED],
      reason: "outside-pool",
      actor: "operator",
      recorded: true,
    },
  });
  expect(accountProjectOverrides({ project: FENCED_PROJECT, engine: "codex" })).toMatchObject([{
    accountId: OUTSIDE,
    actor: "operator",
    actorConversationId: null,
    reason: "outside-pool",
    via: "conversation-switch",
    allowedAccountIds: [RESERVED],
  }]);
});

test("an agent's out-of-pool switch is recorded under the agent that made it", async () => {
  expect(bindAccountToProject("codex", RESERVED, FENCED_PROJECT).ok).toBe(true);
  const { pathname, registry, entry } = scenario("05", FENCED_PROJECT);
  const counters = { resolved: 0, ticks: 0 };

  const outcome = await reconfigureConversation(
    pathname,
    { model: "gpt-5.6-sol", effort: "high", fast: false, accountId: OUTSIDE },
    { ...overrides(registry, entry, counters), actor: { kind: "agent" as const, conversationId: "conversation_caller" } },
  );

  expect(outcome).toMatchObject({ ok: true, accountOverride: { actor: "agent" } });
  expect(accountProjectOverrides({ project: FENCED_PROJECT })).toMatchObject([{
    actor: "agent",
    actorConversationId: "conversation_caller",
  }]);
});

test("a binding record that cannot be read does not veto a named switch, and is recorded as unreadable", async () => {
  fs.mkdirSync(process.env.LLV_STATE_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "account-project-bindings.json"), "{ not json", "utf8");
  const { pathname, registry, entry } = scenario("06", FENCED_PROJECT);
  const counters = { resolved: 0, ticks: 0 };

  const outcome = await reconfigureConversation(
    pathname,
    { model: "gpt-5.6-sol", effort: "high", fast: false, accountId: OUTSIDE },
    overrides(registry, entry, counters),
  );

  /* A damaged file fails closed for what the Viewer picks on its own; it is not
     a decision anybody made, so it cannot stand in for the operator's. */
  expect(outcome).toMatchObject({
    ok: true,
    outcome: "pending",
    accountOverride: { reason: "binding-unreadable", allowedAccountIds: null },
  });
  expect(counters.ticks).toBe(1);
  expect(accountProjectOverrides()).toMatchObject([{ reason: "binding-unreadable", accountId: OUTSIDE }]);
});

test("the same switch onto an account the project allows goes through", async () => {
  expect(bindAccountToProject("codex", RESERVED, FENCED_PROJECT).ok).toBe(true);
  expect(bindAccountToProject("codex", OUTSIDE, FENCED_PROJECT).ok).toBe(true);
  const { pathname, registry, entry } = scenario("02", FENCED_PROJECT);
  const counters = { resolved: 0, ticks: 0 };

  const outcome = await reconfigureConversation(
    pathname,
    { model: "gpt-5.6-sol", effort: "high", fast: false, accountId: OUTSIDE },
    overrides(registry, entry, counters),
  );

  expect(outcome).toMatchObject({ ok: true, outcome: "pending" });
  expect(counters.ticks).toBe(1);
  expect(registry.conversationForPath(pathname)?.migration).toMatchObject({ targetId: OUTSIDE });
  /* Inside the pool there is nothing to attribute. */
  expect(outcome).not.toHaveProperty("accountOverride");
  expect(accountProjectOverrides()).toEqual([]);
});

test("an unbound project switches accounts exactly as it always did", async () => {
  const { pathname, registry, entry } = scenario("03", "project-unbound");
  const counters = { resolved: 0, ticks: 0 };

  const outcome = await reconfigureConversation(
    pathname,
    { model: "gpt-5.6-sol", effort: "high", fast: false, accountId: OUTSIDE },
    overrides(registry, entry, counters),
  );

  expect(outcome).toMatchObject({ ok: true, outcome: "pending" });
  expect(counters.ticks).toBe(1);
  expect(registry.conversationForPath(pathname)?.migration).toMatchObject({ targetId: OUTSIDE });
  /* An unbound project has no pool to be outside of. */
  expect(outcome).not.toHaveProperty("accountOverride");
  expect(accountProjectOverrides()).toEqual([]);
});

test("a binding on one project leaves another project's switch alone", async () => {
  expect(bindAccountToProject("codex", RESERVED, FENCED_PROJECT).ok).toBe(true);
  const { pathname, registry, entry } = scenario("04", "project-beacon");
  const counters = { resolved: 0, ticks: 0 };

  const outcome = await reconfigureConversation(
    pathname,
    { model: "gpt-5.6-sol", effort: "high", fast: false, accountId: OUTSIDE },
    overrides(registry, entry, counters),
  );

  /* The fence belongs to the project that configured it; a project that never
     bound anything is untouched, including onto the reserved account. */
  expect(outcome).toMatchObject({ ok: true, outcome: "pending" });
  expect(counters.ticks).toBe(1);
});
