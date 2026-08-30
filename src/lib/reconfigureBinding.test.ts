import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";

import type { AccountContext } from "@/lib/accounts/contracts";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { bindAccountToProject } from "@/lib/accounts/projectBindings";
import { AgentRegistry, setAgentRegistryForTests, type TmuxHostEvidence } from "@/lib/agent/registry";
import { resetProjectAliasesForTests } from "@/lib/projects/aliases";
import type { FileEntry } from "@/lib/types";

import { reconfigureConversation } from "./delivery";

/**
 * #1279 at the reconfigure seam: switching a live conversation onto another
 * account is a pin on that conversation's project's work, so a project that
 * does not allow the named account refuses it — the same answer a spawn or a
 * pipeline stage gives, at the one other door that could move work across the
 * boundary.
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

test("a project bound to one account refuses a switch onto an account outside its set", async () => {
  expect(bindAccountToProject("codex", RESERVED, FENCED_PROJECT).ok).toBe(true);
  const { pathname, registry, entry } = scenario("01", FENCED_PROJECT);
  const counters = { resolved: 0, ticks: 0 };

  const outcome = await reconfigureConversation(
    pathname,
    { model: "gpt-5.6-sol", effort: "high", fast: false, accountId: OUTSIDE },
    overrides(registry, entry, counters),
  );

  expect(outcome).toMatchObject({ ok: false, status: 409 });
  expect((outcome as { error: string }).error).toContain(OUTSIDE);
  expect((outcome as { error: string }).error).toContain(FENCED_PROJECT);
  /* Refused before anything moved: no migration queued, no tick requested. */
  expect(counters.resolved).toBe(0);
  expect(counters.ticks).toBe(0);
  expect(registry.conversationForPath(pathname)?.migration ?? null).toBeNull();
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
