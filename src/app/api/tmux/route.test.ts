import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, mock, test } from "bun:test";

import { NextRequest } from "next/server";

const previousCodexHome = process.env.LLV_CODEX_HOME;
const routeCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "llv-tmux-route-codex-"));
const PATHNAME = path.join(routeCodexHome, "sessions", "rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl");
fs.mkdirSync(path.dirname(PATHNAME), { recursive: true });
fs.writeFileSync(PATHNAME, "{}\n");
process.env.LLV_CODEX_HOME = routeCodexHome;
afterAll(() => {
  if (previousCodexHome === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = previousCodexHome;
  fs.rmSync(routeCodexHome, { recursive: true, force: true });
});

let transcriptReads = 0;
let lastTranscriptReadFresh: boolean | undefined;
let pidTargets = new Map<number, string | null>();
let resourceTarget: Record<string, unknown> | null = null;
const endpoint = {
  kind: "tmux-tmpdir" as const,
  tmuxTmpdir: "/run/user/1000/agent-log-viewer",
  socketName: "default" as const,
  socketPath: "/run/user/1000/agent-log-viewer/tmux-1000/default",
};
let attachResolution: unknown = {
  ok: true,
  target: "agents:4.0",
  endpoint,
  command: "TMUX_TMPDIR='/run/user/1000/agent-log-viewer' tmux attach-session -t 'agents:4.0'",
  readOnlyCommand: "TMUX_TMPDIR='/run/user/1000/agent-log-viewer' tmux attach-session -r -t 'agents:4.0'",
};
let delivery: (message: unknown) => Promise<{ ok: true; outcome: "delivered-to-live" | "resumed"; target: string; spawned?: boolean }> = async () => ({
  ok: true,
  outcome: "delivered-to-live",
  target: "agents:4.0",
});
let killOutcome: { ok: true; target: string } | { ok: false; outcome: "failed"; error: string; status: number } = { ok: true, target: "agents:4.0" };

const host = {
  paneId: "%1",
  panePid: 100,
  agentPid: 200,
  display: "agents:4.0",
  tmuxServerPid: 900,
  engine: "codex" as const,
  cwd: "/repo",
  agentArgv: ["codex", "resume", "019f4906-3f67-7b72-9fbc-9ec3b5ad1326"],
  agentIdentity: "200:one",
  claimedPaths: [PATHNAME],
  primaryPath: PATHNAME,
};

const snapshot = {
  hosts: [host],
  observation: "available" as const,
  canonicalFor: (pathname: string) => (pathname === PATHNAME ? host : null),
};

mock.module("@/lib/agent/transcriptHost", () => ({
  canonicalTranscriptTarget: (observed: typeof snapshot, pathname: string) => observed.canonicalFor(pathname)?.display ?? null,
  deliverToTranscriptHost: async () => ({ kind: "unavailable" }),
  readTranscriptHosts: async (fresh?: boolean) => {
    transcriptReads += 1;
    lastTranscriptReadFresh = fresh;
    return snapshot;
  },
}));
mock.module("@/lib/runtime/structuredControls", () => ({ dispatchStructuredControl: async () => null }));
mock.module("@/lib/delivery", () => ({
  answerDialogKey: async () => ({ ok: true, target: "" }),
  compactConversation: async () => ({ ok: true, target: "" }),
  deliverConversationMessage: (message: unknown) => delivery(message),
  interruptConversation: async () => ({ ok: true, target: "" }),
  killConversation: async () => killOutcome,
  livePaneTarget: async () => null,
  reconfigureConversation: async () => ({ ok: true, outcome: "reconfigured", target: "agents:4.0" }),
  resumeConversation: async () => ({ ok: true, target: "" }),
}));
mock.module("@/lib/resources", () => ({
  allowedKillTarget: (target: string) => (target === "agents:9.0" ? resourceTarget : null),
  consumeKillTarget: () => {},
}));
mock.module("@/lib/tmux", () => ({
  captureTmuxAttachReference: (value: Record<string, unknown>) => ({ ...value, tmuxServerStartIdentity: "900:one", paneStartIdentity: "100:one" }),
  collectImagePayloads: () => ({ images: [], error: null }),
  killPane: async () => {},
  panePidOf: async () => null,
  resolveRequestedTmuxTarget: async (pid: number | null) => (pid === null ? null : pidTargets.get(pid) ?? null),
  resolveTarget: async (pid: number) => pidTargets.get(pid) ?? null,
  knownLivePids: async () => new Set<number>(),
  panePidMap: async () => new Map<number, string>(),
  paneInfo: async () => null,
  targetForKnownPid: async (pid: number) => pidTargets.get(pid) ?? null,
  verifyTmuxHostEvidence: async () => true,
  resolveTmuxAttach: async () => attachResolution,
  spawnAgentWithPrompt: async () => ({ paneId: "%91", display: "agents:worker.0" }),
  spawnCommandWindow: async () => ({ paneId: "%90", display: "agents:view.0" }),
  tmuxEndpointDescriptor: () => endpoint,
}));

const { GET, POST } = await import("./route");

function get(url: string): NextRequest {
  return new NextRequest(url, { headers: { host: "127.0.0.1" } });
}

function post(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1/api/tmux", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("/api/tmux GET uses the transcript host when a recycled pid disagrees", async () => {
  transcriptReads = 0;
  pidTargets = new Map([[77, "agents:9.0"]]);

  const response = await GET(get(`http://127.0.0.1/api/tmux?pid=77&path=${encodeURIComponent(PATHNAME)}`));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ target: "agents:4.0" });
  expect(transcriptReads).toBe(1);
});

test("/api/tmux attach resolves a fresh transcript host and returns an uncached opaque command", async () => {
  transcriptReads = 0;
  lastTranscriptReadFresh = undefined;
  attachResolution = {
    ok: true,
    target: "agents:8.0",
    endpoint,
    command: "TMUX_TMPDIR='/run/user/1000/agent-log-viewer' tmux attach-session -t 'agents:8.0'",
    readOnlyCommand: "TMUX_TMPDIR='/run/user/1000/agent-log-viewer' tmux attach-session -r -t 'agents:8.0'",
  };

  const response = await GET(get(`http://127.0.0.1/api/tmux?attach=1&path=${encodeURIComponent(PATHNAME)}`));

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    attach: {
      target: "agents:8.0",
      command: "TMUX_TMPDIR='/run/user/1000/agent-log-viewer' tmux attach-session -t 'agents:8.0'",
      readOnlyCommand: "TMUX_TMPDIR='/run/user/1000/agent-log-viewer' tmux attach-session -r -t 'agents:8.0'",
    },
    endpoint,
  });
  expect(transcriptReads).toBe(1);
  expect(lastTranscriptReadFresh === true).toBe(true);
});

test("/api/tmux attach resolves an allowlisted orphan resource target", async () => {
  resourceTarget = { tmuxServerPid: 900, tmuxServerStartIdentity: "900:one", paneId: "%9", panePid: 109, paneStartIdentity: "109:one" };
  attachResolution = { ok: false, reason: "stale-pane" };

  const response = await GET(get("http://127.0.0.1/api/tmux?attach=1&target=agents%3A9.0"));

  expect(response.status).toBe(409);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ reason: "stale-pane", error: "This pane changed or closed. Refresh and try again." });
});

test("/api/tmux attach reports a restarted server and rejects malformed, cross-origin requests", async () => {
  attachResolution = { ok: false, reason: "server-restarted" };
  const restarted = await GET(get(`http://127.0.0.1/api/tmux?attach=1&path=${encodeURIComponent(PATHNAME)}`));
  expect(restarted.status).toBe(409);
  expect(await restarted.json()).toEqual({ reason: "server-restarted", error: "The tmux server restarted. Refresh and try again." });

  const malformed = await GET(get("http://127.0.0.1/api/tmux?attach=1&path=/allowed/a&target=agents%3A9.0"));
  expect(malformed.status).toBe(400);

  const hostile = await GET(new NextRequest(`http://127.0.0.1/api/tmux?attach=1&path=${encodeURIComponent(PATHNAME)}`, {
    headers: { host: "127.0.0.1", origin: "https://evil.example", "sec-fetch-site": "cross-site" },
  }));
  expect(hostile.status).toBe(403);
});

test("/api/tmux GET keeps pid lookup for pid-only compatibility requests", async () => {
  pidTargets = new Map([[77, "agents:9.0"]]);

  const response = await GET(get("http://127.0.0.1/api/tmux?pid=77"));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ target: "agents:9.0" });
});

test("/api/tmux POST carries concurrent sends through the delivery seam", async () => {
  const received: unknown[] = [];
  delivery = async (message: unknown) => {
    received.push(message);
    return { ok: true, outcome: "resumed" as const, target: "agents:5.0", spawned: true };
  };

  const responses = await Promise.all([
    POST(post({ path: PATHNAME, text: "first" })),
    POST(post({ path: PATHNAME, text: "second" })),
  ]);

  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
    { ok: true, outcome: "resumed", target: "agents:5.0", spawned: true },
    { ok: true, outcome: "resumed", target: "agents:5.0", spawned: true },
  ]);
  expect(received).toEqual([
    { pid: null, path: PATHNAME, text: "first", images: [] },
    { pid: null, path: PATHNAME, text: "second", images: [] },
  ]);
});

test("/api/tmux POST kill never reports success with an empty target", async () => {
  killOutcome = { ok: true, target: "" };

  const response = await POST(post({ path: PATHNAME, action: "kill" }));

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ ok: false, outcome: "failed", error: "kill resolved no registered pane" });
  killOutcome = { ok: true, target: "agents:4.0" };
});
