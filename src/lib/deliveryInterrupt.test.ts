import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, type TmuxHostEvidence } from "./agent/registry";
import { beginLegacySpawnFixture } from "./agent/registryTestFixtures";
import { reconcileObservedTranscriptHosts, type TranscriptHost } from "./agent/transcriptHost";
import { applyConversationAction } from "./conversation/actions";
import { interruptConversation } from "./delivery";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-interrupt-"));
  directories.push(directory);
  const registry = new AgentRegistry(path.join(directory, "registry.json"));
  const sessionId = crypto.randomUUID();
  const root = path.join(directory, `${sessionId}.jsonl`);
  const child = path.join(directory, sessionId, "subagents/agent-child.jsonl");
  const key = { engine: "claude" as const, sessionId };
  const evidence: TmuxHostEvidence = {
    kind: "tmux", endpoint: directory,
    server: { pid: 900, startIdentity: "900:one" },
    paneId: "%1", panePid: { pid: 100, startIdentity: "100:one" },
    windowName: "claude", agent: { pid: 200, startIdentity: "200:one" }, argv: ["claude"],
  };
  const begun = beginLegacySpawnFixture(registry, { engine: "claude", cwd: directory, accountId: "fixture" });
  if (begun.kind !== "created") throw new Error("expected a new launch");
  registry.bindSpawnPane(begun.receipt.launchId, {
    endpoint: evidence.endpoint, server: evidence.server, paneId: evidence.paneId,
    panePid: evidence.panePid, target: "agents:4.0",
  });
  const host: TranscriptHost = {
    tmuxServerPid: 900, paneId: "%1", panePid: 100, agentPid: 200,
    display: "agents:4.0", windowName: "claude", engine: "claude", cwd: directory,
    agentArgv: ["claude"], agentIdentity: "200:one", launchId: begun.receipt.launchId,
    claimedPaths: [child, root], primaryPath: child,
  };
  // Exercise the production rule: an active child becomes primary while the
  // Viewer launch receipt and registry owner stay attached to the root.
  reconcileObservedTranscriptHosts([host], { registry, evidenceForHost: () => evidence });
  expect(registry.readOnlySnapshot().receipts[begun.receipt.launchId]?.artifactPath).toBe(root);
  const registered = registry.readOnlySnapshot().entries[`claude:${sessionId}`]!;
  const effects: TmuxHostEvidence[] = [];
  const overrides = {
    registry, pathAllowed: () => true, livePaneHost: async () => host,
    interruptHost: async (owner: TmuxHostEvidence) => { effects.push(owner); return true; },
  };
  return { registry, key, root, child, evidence, host, effects, overrides, registered };
}

test.each(["root", "child"] as const)("interrupt %s uses the registered root owner when a native child is primary", async (selected) => {
  const f = fixture();
  // Another live pane must never receive the selected conversation's control.
  f.registry.upsert({ ...f.registered, key: { engine: "claude", sessionId: crypto.randomUUID() },
    artifactPath: path.join(path.dirname(f.root), "other.jsonl"),
    host: { ...f.evidence, paneId: "%2", agent: { pid: 201, startIdentity: "201:one" } } });
  const conversation = f.registry.ensureConversation("claude", f[selected], "fixture");
  const unexpected = async () => { throw new Error("unexpected control route"); };
  const result = await applyConversationAction({ action: "interrupt", conversationId: conversation.id,
    transcriptPath: f[selected], operationId: `interrupt-${selected}` }, {
    registry: () => f.registry, structuredEnabled: () => true,
    dispatchStructuredControl: async () => null,
    interruptConversation: (pathname) => interruptConversation(pathname, f.overrides),
    killConversation: unexpected, resumeConversation: unexpected,
    compactConversation: unexpected, answerDialogKey: unexpected,
  });
  expect(result).toMatchObject({ status: 200, body: { ok: true, target: f.host.display } });
  expect(f.effects).toEqual([f.evidence]);
  expect(f.registry.readOnlySnapshot().entries[`claude:${f.key.sessionId}`]?.host).toEqual(f.evidence);
});

test.each(["agentPid", "agentIdentity", "panePid", "tmuxServerPid", "engine", "claimedPaths"] as const)(
  "interrupt refuses mismatched observed %s without affecting a host", async (field) => {
    const f = fixture();
    const changed: Partial<TranscriptHost> = {
      agentPid: 201, agentIdentity: "200:reused", panePid: 101, tmuxServerPid: 901,
      engine: "codex", claimedPaths: [f.child],
    };
    Object.assign(f.host, { [field]: changed[field] });
    expect(await interruptConversation(f.root, f.overrides)).toMatchObject({ ok: false, status: 409 });
    expect(f.effects).toEqual([]);
  },
);

test.each(["before", "under-lock"] as const)("interrupt refuses a shared registered pane %s", async (when) => {
  const f = fixture();
  const duplicate = () => f.registry.upsert({ ...f.registered,
    key: { engine: "claude", sessionId: crypto.randomUUID() }, artifactPath: f.child });
  const original = f.registry.withOperationLock.bind(f.registry);
  const lock = spyOn(f.registry, "withOperationLock").mockImplementation((key, owner, task) =>
    original(key, owner, async () => { if (when === "under-lock") duplicate(); return task(); }));
  try {
    if (when === "before") duplicate();
    expect(await interruptConversation(f.root, f.overrides)).toMatchObject({ ok: false, status: 409 });
    expect(lock).toHaveBeenCalledTimes(when === "under-lock" ? 1 : 0);
    expect(f.effects).toEqual([]);
  } finally { lock.mockRestore(); }
});

test.each(["identity", "artifact"] as const)("interrupt refuses changed %s after the operation lock", async (field) => {
  const f = fixture();
  const original = f.registry.withOperationLock.bind(f.registry);
  const lock = spyOn(f.registry, "withOperationLock").mockImplementation((key, owner, task) =>
    original(key, owner, async () => {
      f.registry.upsert({ ...f.registered,
        ...(field === "identity" ? { host: { ...f.evidence, agent: { pid: 201, startIdentity: "201:one" } } }
          : { artifactPath: path.join(path.dirname(f.root), "other.jsonl") }),
      });
      return task();
    }));
  try {
    expect(await interruptConversation(f.root, f.overrides)).toMatchObject({ ok: false, status: 409 });
    expect(lock).toHaveBeenCalledTimes(1);
    expect(f.effects).toEqual([]);
  } finally { lock.mockRestore(); }
});

test("interrupt reports a host that disappears at the final identity fence", async () => {
  const f = fixture();
  let attempts = 0;
  const result = await interruptConversation(f.child, { ...f.overrides,
    interruptHost: async () => { attempts++; return false; },
  });
  expect(result).toMatchObject({ ok: false, status: 409 });
  expect(attempts).toBe(1);
  expect(f.effects).toEqual([]);
});
