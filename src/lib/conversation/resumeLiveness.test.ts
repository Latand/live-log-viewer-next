import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import { listCodexAccounts } from "@/lib/accounts/codex";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import {
  AgentRegistry,
  setAgentRegistryForTests,
  type SpawnReceipt,
  type TmuxHostEvidence,
} from "@/lib/agent/registry";
import {
  beginRegistryResume,
  createTranscriptHostResolver,
  reconcileObservedTranscriptHosts,
  type TranscriptHost,
} from "@/lib/agent/transcriptHost";
import type { ResumeSpec } from "@/lib/agent/cli";
import { statePath } from "@/lib/configDir";
import { conversationDeliverabilityFromRecord } from "./deliverability";
import { deliverConversationMessage, resumeConversation } from "@/lib/delivery";
import type { AgentProcess } from "@/lib/scanner/process";
import type { PaneRef } from "@/lib/tmux";
import type { FileEntry } from "@/lib/types";

const SESSION_ID = "00000000-0000-0000-0000-000000000000";
const TRANSCRIPT_PATH = `/fixtures/codex/rollout-2026-09-01T10-00-00-${SESSION_ID}.jsonl`;

const sandboxes: string[] = [];
const previousAccountEnvironment = {
  stateDir: process.env.LLV_STATE_DIR,
  codexHome: process.env.LLV_CODEX_HOME,
};

afterEach(() => {
  setAgentRegistryForTests(null);
  if (previousAccountEnvironment.stateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousAccountEnvironment.stateDir;
  if (previousAccountEnvironment.codexHome === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = previousAccountEnvironment.codexHome;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function fixtureEntry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: TRANSCRIPT_PATH,
    root: "codex-sessions",
    name: path.basename(TRANSCRIPT_PATH),
    project: "fixture-project",
    cwd: "/fixtures/project",
    title: "Resume liveness fixture",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: "done",
    pid: null,
    model: "fixture-model",
    effort: "high",
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  } as FileEntry;
}

const resumeSpec: ResumeSpec = {
  command: `codex resume ${SESSION_ID}`,
  cwd: "/fixtures/project",
  windowName: "codex-resume-fixture",
  engine: "codex",
  launchProfile: emptyLaunchProfile({ cwd: "/fixtures/project" }),
};

function evidence(host: TranscriptHost): TmuxHostEvidence {
  return {
    kind: "tmux",
    endpoint: "/fixtures/tmux",
    server: { pid: host.tmuxServerPid, startIdentity: "server:900" },
    paneId: host.paneId,
    panePid: { pid: host.panePid, startIdentity: "pane:300" },
    windowName: host.windowName ?? "",
    agent: { pid: host.agentPid, startIdentity: host.agentIdentity },
    argv: host.agentArgv,
  };
}

test("a detector timeout after starting a legacy host settles resume, immediate send, and deliverability from one live record", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-resume-liveness-"));
  sandboxes.push(sandbox);
  const accountStateDir = path.join(sandbox, "account-state");
  const codexHome = path.join(sandbox, "codex-home");
  process.env.LLV_STATE_DIR = accountStateDir;
  process.env.LLV_CODEX_HOME = codexHome;

  const accountReadPaths = [
    statePath("codex-accounts.json"),
    statePath("account-project-bindings.json"),
    ...listCodexAccounts().map((account) => path.join(account.home, "auth.json")),
  ];
  expect(accountReadPaths).toEqual([
    path.join(accountStateDir, "codex-accounts.json"),
    path.join(accountStateDir, "account-project-bindings.json"),
    path.join(codexHome, "auth.json"),
  ]);
  expect(accountReadPaths.every((pathname) => {
    const relative = path.relative(sandbox, pathname);
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  })).toBe(true);

  const registry = new AgentRegistry(path.join(sandbox, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  setAgentRegistryForTests(registry);
  registry.reconcileConversations([{
    engine: "codex",
    path: TRANSCRIPT_PATH,
    accountId: "fixture-account",
    launchProfile: emptyLaunchProfile({ cwd: "/fixtures/project", project: "fixture-project" }),
    turn: { state: "terminal", source: "assistant", terminalAt: "2026-09-01T09:59:00.000Z" },
    observedAt: "2026-09-01T10:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(TRANSCRIPT_PATH)!;
  let currentEntry = fixtureEntry();
  let panes = new Map<number, PaneRef>();
  let agents: AgentProcess[] = [];
  let ppids = new Map<number, number>();
  let launchId: string | null = null;
  let remembered = 0;
  const delivered: string[] = [];

  const resolver = createTranscriptHostResolver({
    listFiles: async () => [currentEntry],
    panes: async () => ({ kind: "available" as const, panes }),
    ppidMap: () => ppids,
    agents: () => agents,
    serverPid: async () => 900,
    resumeRecords: async () => ({ serverPid: 900, records: new Map() }),
    panePid: async (paneId) => [...panes.entries()].find(([, pane]) => pane.paneId === paneId)?.[0] ?? null,
    paneWindowName: async () => resumeSpec.windowName,
    alive: (pid) => agents.some((agent) => agent.pid === pid),
    argv: (pid) => agents.find((agent) => agent.pid === pid)?.argv ?? [],
    parentPid: (pid) => ppids.get(pid) ?? null,
    identity: (pid) => pid === 400 ? "agent:400" : null,
    launchId: async () => launchId,
    conversationIdForPath: (pathname) => pathname === TRANSCRIPT_PATH ? conversation.id : null,
    beginResume: (entry, spec) => beginRegistryResume(entry, spec, registry),
    spawn: async (_spec, _text, receipt?: SpawnReceipt) => {
      if (!receipt) throw new Error("resume receipt is required");
      launchId = receipt.launchId;
      registry.bindSpawnPane(receipt.launchId, {
        endpoint: "/fixtures/tmux",
        server: { pid: 900, startIdentity: "server:900" },
        paneId: "%9",
        panePid: { pid: 300, startIdentity: "pane:300" },
        target: "fixture:9.0",
      });
      panes = new Map([[300, { paneId: "%9", target: "fixture:9.0", windowName: resumeSpec.windowName }]]);
      agents = [{
        pid: 400,
        engine: "codex",
        argv: ["codex", "resume", SESSION_ID],
        cwd: "/fixtures/project",
        tty: 1,
      }];
      ppids = new Map([[400, 300]]);
      currentEntry = fixtureEntry({ pid: 400, proc: "running", activity: "live" });
      registry.failSpawn(receipt.launchId, "agent never reached a launch-ready prompt");
      throw new Error("agent never reached a launch-ready prompt");
    },
    remember: async () => { remembered += 1; },
    deliver: async (paneId, text) => {
      if (!text) throw new Error("no buffer viewer-1788299999999-481516");
      delivered.push(`${paneId}:${text}`);
    },
    reconcile: (hosts) => reconcileObservedTranscriptHosts(hosts, { registry, evidenceForHost: evidence }),
  });
  const sharedOverrides = {
    pathAllowed: () => true,
    listFiles: async () => [currentEntry],
    recover: async () => null,
    resumeSpecFor: () => resumeSpec,
    deliver: resolver.deliverToTranscriptHost,
  };

  const resumed = await resumeConversation(TRANSCRIPT_PATH, {
    ...sharedOverrides,
    registry,
  });

  expect(resumed).toMatchObject({ ok: true, outcome: "resumed", spawned: true });
  expect(remembered).toBe(0);
  const settled = registry.readOnlySnapshot();
  expect(settled.receipts[launchId!]).toMatchObject({ state: "completed", error: null });
  expect(conversationDeliverabilityFromRecord(settled, {
    conversationId: conversation.id,
  })).toMatchObject({
    deliverable: true,
    condition: "deliverable",
    transport: "legacy",
    hostStatus: "live",
  });

  const sent = await deliverConversationMessage({
    pid: null,
    path: TRANSCRIPT_PATH,
    conversationId: conversation.id,
    clientMessageId: "send-after-resume",
    text: "deliver immediately",
    images: [],
  }, sharedOverrides);

  expect(sent).toMatchObject({ ok: true, outcome: "delivered-to-live" });
  expect(delivered).toEqual(["%9:deliver immediately"]);
});
