import { describe, expect, test } from "bun:test";

import type { TranscriptHost } from "@/lib/agent/transcriptHost";
import type { FileEntry } from "@/lib/types";

import { allowedKillTarget, canonicalResourceEntry, consumeKillTarget, noteSessionTargets } from "./resources";

const PATHNAME = "/home/user/.codex/sessions/2026/07/10/rollout-2026-07-10-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";

const entry: FileEntry = {
  path: PATHNAME,
  root: "codex-sessions",
  name: PATHNAME,
  project: "live-log-viewer-next",
  title: "Issue 31",
  engine: "codex",
  kind: "session",
  fmt: "codex",
  parent: null,
  mtime: 1,
  size: 1,
  activity: "live",
  proc: "running",
  pid: 200,
  model: "gpt-5.6-terra",
  pendingQuestion: null,
  waitingInput: null,
};

const duplicate: TranscriptHost = {
  tmuxServerPid: 900,
  paneId: "%2",
  panePid: 101,
  agentPid: 201,
  display: "agents:5.0",
  engine: "codex",
  cwd: "/repo",
  agentArgv: ["codex", "resume", "019f4906-3f67-7b72-9fbc-9ec3b5ad1326"],
  agentIdentity: "200:one",
  claimedPaths: [PATHNAME],
  primaryPath: PATHNAME,
};

const canonical: TranscriptHost = {
  ...duplicate,
  paneId: "%1",
  panePid: 100,
  agentPid: 200,
  display: "agents:4.0",
};

describe("resource observation", () => {
  test("attributes a duplicated transcript only to the shared canonical host", () => {
    const snapshot = { hosts: [duplicate, canonical], observation: "available" as const, canonicalFor: (pathname: string) => (pathname === PATHNAME ? canonical : null) };

    expect(canonicalResourceEntry(snapshot, [duplicate], new Map([[PATHNAME, entry]]))).toBeNull();
    expect(canonicalResourceEntry(snapshot, [canonical], new Map([[PATHNAME, entry]]))).toEqual(entry);
  });
});

describe("kill-target allowlist", () => {
  test("nothing is killable before a snapshot exists", () => {
    noteSessionTargets([]);
    expect(allowedKillTarget("agents:1.0")).toBeNull();
    expect(allowedKillTarget("")).toBeNull();
  });

  test("only targets from the last snapshot pass, each with its pane id and pid", () => {
    noteSessionTargets([
      { target: "agents:1.0", ref: { panePid: 111, paneId: "%11" } },
      { target: "agents:2.0", ref: { panePid: 222, paneId: "%22" } },
    ]);
    expect(allowedKillTarget("agents:1.0")).toEqual({ panePid: 111, paneId: "%11" });
    expect(allowedKillTarget("agents:2.0")).toEqual({ panePid: 222, paneId: "%22" });
    expect(allowedKillTarget("agents:3.0")).toBeNull();
    expect(allowedKillTarget("main:0.0")).toBeNull();
  });

  test("a new snapshot fully replaces the allowlist", () => {
    noteSessionTargets([{ target: "agents:1.0", ref: { panePid: 111, paneId: "%11" } }]);
    noteSessionTargets([{ target: "agents:2.0", ref: { panePid: 222, paneId: "%22" } }]);
    expect(allowedKillTarget("agents:1.0")).toBeNull();
    expect(allowedKillTarget("agents:2.0")).toEqual({ panePid: 222, paneId: "%22" });
  });

  test("a consumed target no longer passes — tmux may reuse its coordinates", () => {
    noteSessionTargets([
      { target: "agents:1.0", ref: { panePid: 111, paneId: "%11" } },
      { target: "agents:2.0", ref: { panePid: 222, paneId: "%22" } },
    ]);
    consumeKillTarget("agents:1.0");
    expect(allowedKillTarget("agents:1.0")).toBeNull();
    expect(allowedKillTarget("agents:2.0")).toEqual({ panePid: 222, paneId: "%22" });
  });
});
