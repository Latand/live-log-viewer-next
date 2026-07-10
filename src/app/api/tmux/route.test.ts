import { expect, mock, test } from "bun:test";

import { NextRequest } from "next/server";

const PATHNAME = "/allowed/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";

let transcriptReads = 0;
let pidTargets = new Map<number, string | null>();
let delivery: (message: unknown) => Promise<{ ok: true; outcome: "delivered-to-live" | "resumed"; target: string; spawned?: boolean }> = async () => ({
  ok: true,
  outcome: "delivered-to-live",
  target: "agents:4.0",
});

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
  readTranscriptHosts: async () => {
    transcriptReads += 1;
    return snapshot;
  },
}));
mock.module("@/lib/delivery", () => ({
  answerDialogKey: async () => ({ ok: true, target: "" }),
  compactConversation: async () => ({ ok: true, target: "" }),
  deliverConversationMessage: (message: unknown) => delivery(message),
  interruptConversation: async () => ({ ok: true, target: "" }),
  killConversation: async () => ({ ok: true, target: "" }),
  resumeConversation: async () => ({ ok: true, target: "" }),
}));
mock.module("@/lib/resources", () => ({
  allowedKillTarget: () => null,
  consumeKillTarget: () => {},
}));
mock.module("@/lib/sameOrigin", () => ({ rejectCrossOrigin: () => null }));
mock.module("@/lib/scanner/roots", () => ({ pathAllowed: (pathname: string) => pathname.startsWith("/allowed/") }));
mock.module("@/lib/tmux", () => ({
  collectImagePayloads: () => ({ images: [], error: null }),
  killPane: async () => {},
  panePidOf: async () => null,
  resolveRequestedTmuxTarget: async (pid: number | null) => (pid === null ? null : pidTargets.get(pid) ?? null),
}));

const { GET, POST } = await import("./route");

function get(url: string): NextRequest {
  return new NextRequest(url);
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
