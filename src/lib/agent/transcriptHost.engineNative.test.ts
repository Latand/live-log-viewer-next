import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, type TmuxHostEvidence } from "@/lib/agent/registry";
import { reconcileObservedTranscriptHosts, type TranscriptHost } from "@/lib/agent/transcriptHost";

const ROOT_SID = "019f4906-3f67-7b72-9fbc-9ec3b5ad1326";
const ROOT_PATH = `/home/user/.claude/projects/-repo/${ROOT_SID}.jsonl`;
const CHILD_PATH = `/home/user/.claude/projects/-repo/${ROOT_SID}/subagents/agent-child.jsonl`;

function registry(): AgentRegistry {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-host-engine-native-"));
  return new AgentRegistry(path.join(directory, "registry.json"));
}

function evidence(): TmuxHostEvidence {
  return {
    kind: "tmux",
    endpoint: "/tmp",
    server: { pid: 900, startIdentity: "900:one" },
    paneId: "%1",
    panePid: { pid: 100, startIdentity: "100:one" },
    windowName: "claude",
    agent: { pid: 200, startIdentity: "200:one" },
    argv: ["claude"],
  };
}

test("a same-pane engine-native child never steals the Viewer launch receipt (issue #339)", () => {
  const store = registry();
  const begun = store.beginSpawnRequest({ engine: "claude", cwd: "/repo", accountId: "work" });
  if (begun.kind !== "created") throw new Error("expected create");
  store.bindSpawnPane(begun.receipt.launchId, {
    endpoint: "/tmp",
    server: { pid: 900, startIdentity: "900:one" },
    paneId: "%1",
    panePid: { pid: 100, startIdentity: "100:one" },
    target: "agents:4.0",
  });

  const host: TranscriptHost = {
    tmuxServerPid: 900,
    paneId: "%1",
    panePid: 100,
    agentPid: 200,
    display: "agents:4.0",
    windowName: "claude",
    engine: "claude",
    cwd: "/repo",
    agentArgv: ["claude"],
    agentIdentity: "200:one",
    launchId: begun.receipt.launchId,
    // The subagent child outranks the root as the pane's primary claim, but the
    // receipt must still settle onto the root session.
    claimedPaths: [CHILD_PATH, ROOT_PATH],
    primaryPath: CHILD_PATH,
  };

  reconcileObservedTranscriptHosts([host], { registry: store, evidenceForHost: () => evidence() });

  expect(store.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
    state: "completed",
    artifactPath: ROOT_PATH,
  });
});
