import { describe, expect, test } from "bun:test";

import type { TranscriptHost } from "@/lib/agent/transcriptHost";
import type { FileEntry } from "@/lib/types";

import { allowedKillTarget, buildResourceSnapshot, canonicalResourceEntry, conflictingResourceHost, consumeKillTarget, noteSessionTargets, parseResourcesFixture } from "./resources";

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
  launchId: null,
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

function ref(tmuxServerPid: number, panePid: number, paneId: string) {
  return {
    tmuxServerPid,
    tmuxServerStartIdentity: `${tmuxServerPid}:one`,
    panePid,
    paneStartIdentity: `${panePid}:one`,
    paneId,
  };
}

describe("resource observation", () => {
  test("builds host ownership and metadata from one shared transcript generation", async () => {
    let scans = 0;
    let hostFresh: boolean | null = null;
    const files = [entry];
    const payload = await buildResourceSnapshot(true, {
      readFiles: async () => {
        scans += 1;
        return files;
      },
      readHosts: async (fresh, entries) => {
        hostFresh = fresh;
        expect(entries).toBe(files);
        return {
          hosts: [canonical],
          observation: "available",
          conflicts: [],
          canonicalFor: (pathname: string) => pathname === PATHNAME ? canonical : null,
        };
      },
      proc: {
        systemMemory: () => ({ ramTotal: 1_000, ramAvailable: 750, swapTotal: 100, swapUsed: 25 }),
        ppidMap: () => new Map([[200, 100], [300, 200]]),
        processMemory: () => new Map([
          [100, { rssBytes: 10, swapBytes: 1 }],
          [200, { rssBytes: 20, swapBytes: 2 }],
          [300, { rssBytes: 30, swapBytes: 3 }],
        ]),
      },
      captureAttachReference: () => ref(900, 100, "%1"),
    });

    expect(scans).toBe(1);
    expect(hostFresh).toBeTrue();
    expect(payload.sessions).toEqual([{
      target: "agents:4.0",
      panePid: 100,
      path: PATHNAME,
      engine: "codex",
      hostConflict: false,
      title: "Issue 31",
      project: "live-log-viewer-next",
      activity: "live",
      lastActiveAt: "1970-01-01T00:00:01.000Z",
      cwd: "/repo",
      rssBytes: 60,
      swapBytes: 6,
      procCount: 3,
    }]);
    expect(allowedKillTarget("agents:4.0")).toEqual(ref(900, 100, "%1"));
  });

  test("accepts a deterministic resource fixture", () => {
    const fixture = {
      system: {
        ramTotal: 34_359_738_368,
        ramAvailable: 21_474_836_480,
        swapTotal: 8_589_934_592,
        swapUsed: 1_073_741_824,
        capturedAt: "2100-01-02T12:00:00.000Z",
      },
      sessions: [],
    };

    expect(parseResourcesFixture(JSON.stringify(fixture))).toEqual(fixture);
    expect(() => parseResourcesFixture('{"system":{"ramTotal":-1},"sessions":[]}')).toThrow("invalid resources fixture");
  });

  test("attributes a duplicated transcript only to the shared canonical host", () => {
    const snapshot = { hosts: [duplicate, canonical], observation: "available" as const, canonicalFor: (pathname: string) => (pathname === PATHNAME ? canonical : null) };

    expect(canonicalResourceEntry(snapshot, [duplicate], new Map([[PATHNAME, entry]]))).toBeNull();
    expect(canonicalResourceEntry(snapshot, [canonical], new Map([[PATHNAME, entry]]))).toEqual(entry);
  });

  test("marks every pane in a stable-conversation host conflict", () => {
    const snapshot = {
      hosts: [duplicate, canonical],
      observation: "available" as const,
      conflicts: [{ conversationId: "conversation_test", paths: [PATHNAME], paneIds: ["%1", "%2"] }],
      canonicalFor: () => null,
    };

    expect(conflictingResourceHost(snapshot, duplicate)).toBeTrue();
    expect(conflictingResourceHost(snapshot, canonical)).toBeTrue();
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
      { target: "agents:1.0", ref: ref(900, 111, "%11") },
      { target: "agents:2.0", ref: ref(900, 222, "%22") },
    ]);
    expect(allowedKillTarget("agents:1.0")).toEqual(ref(900, 111, "%11"));
    expect(allowedKillTarget("agents:2.0")).toEqual(ref(900, 222, "%22"));
    expect(allowedKillTarget("agents:3.0")).toBeNull();
    expect(allowedKillTarget("main:0.0")).toBeNull();
  });

  test("a new snapshot fully replaces the allowlist", () => {
    noteSessionTargets([{ target: "agents:1.0", ref: ref(900, 111, "%11") }]);
    noteSessionTargets([{ target: "agents:2.0", ref: ref(900, 222, "%22") }]);
    expect(allowedKillTarget("agents:1.0")).toBeNull();
    expect(allowedKillTarget("agents:2.0")).toEqual(ref(900, 222, "%22"));
  });

  test("a consumed target no longer passes — tmux may reuse its coordinates", () => {
    noteSessionTargets([
      { target: "agents:1.0", ref: ref(900, 111, "%11") },
      { target: "agents:2.0", ref: ref(900, 222, "%22") },
    ]);
    consumeKillTarget("agents:1.0");
    expect(allowedKillTarget("agents:1.0")).toBeNull();
    expect(allowedKillTarget("agents:2.0")).toEqual(ref(900, 222, "%22"));
  });
});
