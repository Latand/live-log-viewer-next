import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry, type TmuxHostEvidence } from "@/lib/agent/registry";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { reconcileObservedTranscriptHosts, type TranscriptHost } from "@/lib/agent/transcriptHost";
import type { FileEntry } from "@/lib/types";
import type { RuntimeSessionView } from "@/hooks/useRuntime";

/** Real registry reconciliation with synthetic process identities only. */
export function childControlFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "child-owner-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"));
  const sessionId = crypto.randomUUID();
  const rootPath = path.join(directory, `${sessionId}.jsonl`);
  const childPath = path.join(directory, sessionId, "subagents/agent-child.jsonl");
  const evidence: TmuxHostEvidence = {
    kind: "tmux", endpoint: directory, server: { pid: 900, startIdentity: "900:one" },
    paneId: "%1", panePid: { pid: 100, startIdentity: "100:one" }, windowName: "claude",
    agent: { pid: 200, startIdentity: "200:one" }, argv: ["claude"],
  };
  const begun = beginLegacySpawnFixture(registry, { engine: "claude", cwd: directory, accountId: "fixture" });
  if (begun.kind !== "created") throw new Error("fixture spawn admission failed");
  registry.bindSpawnPane(begun.receipt.launchId, { ...evidence, target: "agents:4.0" });
  const observed: TranscriptHost = {
    tmuxServerPid: 900, paneId: "%1", panePid: 100, agentPid: 200,
    display: "agents:4.0", windowName: "claude", engine: "claude", cwd: directory,
    agentArgv: ["claude"], agentIdentity: "200:one", launchId: begun.receipt.launchId,
    claimedPaths: [childPath, rootPath], primaryPath: childPath,
  };
  reconcileObservedTranscriptHosts([observed], { registry, evidenceForHost: () => evidence });
  const rootConversation = registry.ensureConversation("claude", rootPath, "fixture");
  const childConversation = registry.ensureConversation("claude", childPath, "fixture");
  registry.reconcileConversations([{
    engine: "claude", path: childPath, accountId: "fixture",
    launchProfile: childConversation.generations.at(-1)!.launchProfile, turn: childConversation.turn,
    observedAt: new Date().toISOString(), parentArtifactPath: rootPath,
  }]);
  const root: FileEntry = {
    path: rootPath, conversationId: rootConversation.id, root: "claude-projects", engine: "claude",
    kind: "session", name: "root.jsonl", project: "fixture", title: "Root", fmt: "claude",
    mtime: 1, size: 1, model: null, pendingQuestion: null, waitingInput: null,
    parent: null, activity: "live", proc: "running", pid: 200,
  };
  const child: FileEntry = {
    ...root, path: childPath, conversationId: childConversation.id,
    kind: "subagent", parent: rootPath, proc: null, pid: null,
  };
  const stale = {
    session: { conversationId: rootConversation.id, hostKind: "claude-broker", host: "dead", turn: "idle", capabilities: {} },
    legacy: false, structuredControlsEnabled: true,
  } as RuntimeSessionView;
  const fresh: RuntimeSessionView = {
    ...stale, legacy: true, session: { ...stale.session, hostKind: "tmux-legacy", host: "hosted" },
  };
  return { registry, root, child, stale, fresh, observed, rootConversation, childConversation };
}
