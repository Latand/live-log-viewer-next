import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, mock, test } from "bun:test";

import { NextRequest } from "next/server";

const realResources = { ...(await import("@/lib/resources")) };
const previousCodexHome = process.env.LLV_CODEX_HOME;
const routeCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "llv-tmux-route-codex-"));
const PATHNAME = path.join(routeCodexHome, "sessions", "rollout-019f4906-3f67-\x37b72-9fbc-9ec3b5ad1326.jsonl");
fs.mkdirSync(path.dirname(PATHNAME), { recursive: true });
fs.writeFileSync(PATHNAME, "{}\n");
process.env.LLV_CODEX_HOME = routeCodexHome;
afterAll(() => {
  if (previousCodexHome === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = previousCodexHome;
  fs.rmSync(routeCodexHome, { recursive: true, force: true });
  mock.module("@/lib/resources", () => realResources);
});

let transcriptReads = 0;
let lastTranscriptReadFresh: boolean | undefined;
let lastTranscriptReadFiles: unknown;
let completedScanReads = 0;
let pidResolutionFiles: unknown;
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
let killCalls = 0;
let structuredControlCalls = 0;
let structuredControlRequest: Record<string, unknown> | null = null;
let interruptCalls = 0;
let structuredMessageCalls = 0;
let structuredMessageRequest: Record<string, unknown> | null = null;
let collectedImages: Array<{ base64: string; mime: string }> = [];
let deletedImagePaths: string[][] = [];
let structuredMessageResult:
  | { ok: false; structured: true; outcome: "failed"; error: string; status: number }
  | { ok: true; structured: true; target: string; outcome: "queued"; operationId: string; receipt: { operationId: string; status: "queued" } }
  | null = null;
let structuredControlResult:
  | { status: 200; body: { ok: true; structured: true; target: string; outcome: "delivered" } }
  | { status: 202; body: { ok: true; structured: true; target: string; operationId: string; receipt: { operationId: string; status: string } } }
  | { status: 409; body: { error: string } }
  | null = null;

const host = {
  paneId: "%1",
  panePid: 100,
  agentPid: 200,
  display: "agents:4.0",
  tmuxServerPid: 900,
  engine: "codex" as const,
  cwd: "/repo",
  agentArgv: ["codex", "resume", "019f4906-3f67-\x37b72-9fbc-9ec3b5ad1326"],
  agentIdentity: "200:one",
  claimedPaths: [PATHNAME],
  primaryPath: PATHNAME,
};

const snapshot = {
  hosts: [host],
  observation: "available" as const,
  canonicalFor: (pathname: string) => (pathname === PATHNAME ? host : null),
};

const completedFiles = [{ path: PATHNAME }];

mock.module("@/lib/agent/transcriptHost", () => ({
  canonicalTranscriptTarget: (observed: typeof snapshot, pathname: string) => observed.canonicalFor(pathname)?.display ?? null,
  deliverToTranscriptHost: async () => ({ kind: "unavailable" }),
  readTranscriptHosts: async (fresh?: boolean, files?: unknown) => {
    transcriptReads += 1;
    lastTranscriptReadFresh = fresh;
    lastTranscriptReadFiles = files;
    return snapshot;
  },
}));
mock.module("@/lib/scanner/scanCache", () => ({
  completedFileScan: async () => {
    completedScanReads += 1;
    return { snapshot: { files: completedFiles } };
  },
}));
mock.module("@/lib/runtime/structuredControls", () => ({
  dispatchStructuredControl: async (request: Record<string, unknown>) => {
    structuredControlCalls += 1;
    structuredControlRequest = request;
    return structuredControlResult;
  },
}));
mock.module("@/lib/runtime/structuredMessageDelivery", () => ({
  enqueueStructuredMessage: async (request: Record<string, unknown>) => {
    structuredMessageCalls += 1;
    structuredMessageRequest = request;
    return structuredMessageResult;
  },
}));
mock.module("@/lib/delivery", () => ({
  answerDialogKey: async () => ({ ok: true, target: "" }),
  compactConversation: async () => ({ ok: true, target: "" }),
  deliverConversationMessage: (message: unknown) => delivery(message),
  interruptConversation: async () => {
    interruptCalls += 1;
    return { ok: true, target: "" };
  },
  killConversation: async () => {
    killCalls += 1;
    return killOutcome;
  },
  livePaneTarget: async () => null,
  reconfigureConversation: async () => ({ ok: true, outcome: "reconfigured", target: "agents:4.0" }),
  resumeConversation: async () => ({ ok: true, target: "" }),
}));
mock.module("@/lib/conversation/actions", () => ({
  CONVERSATION_ACTIONS: ["interrupt", "kill", "resume", "compact", "dialog-key"],
  applyConversationAction: async (request: Record<string, unknown>) => {
    if (process.env.LLV_STRUCTURED_HOSTS === "1") {
      structuredControlCalls += 1;
      structuredControlRequest = request;
      if (structuredControlResult) return structuredControlResult;
    }
    if (request.action === "interrupt") {
      interruptCalls += 1;
      return { status: 200, body: { ok: true, target: "" } };
    }
    if (request.action === "kill") {
      killCalls += 1;
      if (killOutcome.ok && !killOutcome.target) {
        return { status: 409, body: { ok: false, outcome: "failed", error: "kill resolved no registered pane" } };
      }
      if (!killOutcome.ok) {
        const { status, ...body } = killOutcome;
        return { status, body };
      }
      return { status: 200, body: killOutcome };
    }
    return { status: 200, body: { ok: true, target: "" } };
  },
}));
mock.module("@/lib/resources", () => ({
  ...realResources,
  allowedKillTarget: (target: string) => target === "agents:9.0"
    ? resourceTarget
    : realResources.allowedKillTarget(target),
  consumeKillTarget: (target: string) => {
    if (target !== "agents:9.0") realResources.consumeKillTarget(target);
  },
}));
mock.module("@/lib/tmux", () => ({
  captureTmuxAttachReference: (value: Record<string, unknown>) => ({ ...value, tmuxServerStartIdentity: "900:one", paneStartIdentity: "100:one" }),
  buildImagePayload: () => ({ payload: "", imagePaths: ["/viewer/inbox/img-one.png"] }),
  collectImagePayloads: () => ({ images: collectedImages, error: null }),
  deleteInboxImages: (paths: string[]) => { deletedImagePaths.push(paths); },
  killPane: async () => {},
  paneScreen: async () => "",
  panePidOf: async () => null,
  resolveRequestedTmuxTarget: async (pid: number | null, files?: unknown) => {
    pidResolutionFiles = files;
    return pid === null ? null : pidTargets.get(pid) ?? null;
  },
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
  completedScanReads = 0;
  lastTranscriptReadFiles = undefined;
  pidTargets = new Map([[77, "agents:9.0"]]);

  const response = await GET(get(`http://127.0.0.1/api/tmux?pid=77&path=${encodeURIComponent(PATHNAME)}`));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ target: "agents:4.0" });
  expect(transcriptReads).toBe(1);
  expect(completedScanReads).toBe(1);
  expect(lastTranscriptReadFiles).toBe(completedFiles);
});

test("/api/tmux attach resolves a fresh transcript host and returns an uncached opaque command", async () => {
  transcriptReads = 0;
  completedScanReads = 0;
  lastTranscriptReadFresh = undefined;
  lastTranscriptReadFiles = undefined;
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
  expect(completedScanReads).toBe(1);
  expect(lastTranscriptReadFiles).toBe(completedFiles);
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
  completedScanReads = 0;
  pidResolutionFiles = undefined;
  pidTargets = new Map([[77, "agents:9.0"]]);

  const response = await GET(get("http://127.0.0.1/api/tmux?pid=77"));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ target: "agents:9.0" });
  expect(completedScanReads).toBe(1);
  expect(pidResolutionFiles).toBe(completedFiles);
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

test("/api/tmux contains structured recovery failures without legacy tmux delivery", async () => {
  const previous = process.env.LLV_STRUCTURED_HOSTS;
  const legacyDeliveries: unknown[] = [];
  structuredMessageCalls = 0;
  structuredMessageResult = {
    ok: false,
    structured: true,
    outcome: "failed",
    error: "recovery spawn failed",
    status: 503,
  };
  delivery = async (message: unknown) => {
    legacyDeliveries.push(message);
    return { ok: true, outcome: "delivered-to-live", target: "agents:4.0" };
  };
  try {
    process.env.LLV_STRUCTURED_HOSTS = "1";
    const response = await POST(post({ path: PATHNAME, text: "preserve draft for retry" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      structured: true,
      outcome: "failed",
      error: "recovery spawn failed",
    });
    expect(structuredMessageCalls).toBe(1);
    expect(legacyDeliveries).toEqual([]);
  } finally {
    structuredMessageResult = null;
    delivery = async () => ({ ok: true, outcome: "delivered-to-live", target: "agents:4.0" });
    if (previous === undefined) delete process.env.LLV_STRUCTURED_HOSTS;
    else process.env.LLV_STRUCTURED_HOSTS = previous;
  }
});

test("/api/tmux forwards structured attachments to runtime image delivery", async () => {
  const previous = process.env.LLV_STRUCTURED_HOSTS;
  structuredMessageCalls = 0;
  structuredMessageRequest = null;
  collectedImages = [{ base64: "encoded", mime: "image/png" }];
  deletedImagePaths = [];
  structuredMessageResult = {
    ok: true,
    structured: true,
    target: "conversation_image",
    outcome: "queued",
    operationId: "op_image",
    receipt: { operationId: "op_image", status: "queued" },
  };
  try {
    process.env.LLV_STRUCTURED_HOSTS = "1";
    const response = await POST(post({
      path: PATHNAME,
      conversationId: "conversation_image",
      text: "inspect",
      images: collectedImages,
    }));

    expect(response.status).toBe(200);
    expect(structuredMessageRequest).toMatchObject({
      path: PATHNAME,
      conversationId: "conversation_image",
      text: "inspect",
      images: [{ base64: "encoded", mime: "image/png" }],
    });
    expect(await response.json()).toMatchObject({ ok: true, structured: true });
    expect(deletedImagePaths).toEqual([]);
  } finally {
    collectedImages = [];
    structuredMessageResult = null;
    structuredMessageRequest = null;
    if (previous === undefined) delete process.env.LLV_STRUCTURED_HOSTS;
    else process.env.LLV_STRUCTURED_HOSTS = previous;
  }
});

test("/api/tmux bypasses persisted structured control state when hosting is disabled", async () => {
  const previous = process.env.LLV_STRUCTURED_HOSTS;
  const legacyDeliveries: unknown[] = [];
  structuredControlCalls = 0;
  interruptCalls = 0;
  structuredControlResult = { status: 409, body: { error: "stale structured projection" } };
  delivery = async (message: unknown) => {
    legacyDeliveries.push(message);
    return { ok: true, outcome: "delivered-to-live", target: "agents:4.0" };
  };
  try {
    process.env.LLV_STRUCTURED_HOSTS = "0";
    const legacy = await POST(post({ path: PATHNAME, action: "resume" }));
    const send = await POST(post({ path: PATHNAME, text: "continue after rollback" }));
    const interrupt = await POST(post({ path: PATHNAME, action: "interrupt" }));
    expect(legacy.status).toBe(200);
    expect(send.status).toBe(200);
    expect(interrupt.status).toBe(200);
    expect(structuredControlCalls).toBe(0);
    expect(legacyDeliveries).toHaveLength(1);
    expect(interruptCalls).toBe(1);

    process.env.LLV_STRUCTURED_HOSTS = "1";
    const structured = await POST(post({ path: PATHNAME, action: "resume" }));
    expect(structured.status).toBe(409);
    expect(await structured.json()).toEqual({ error: "stale structured projection" });
    expect(structuredControlCalls).toBe(1);
  } finally {
    delivery = async () => ({ ok: true, outcome: "delivered-to-live", target: "agents:4.0" });
    structuredControlResult = null;
    if (previous === undefined) delete process.env.LLV_STRUCTURED_HOSTS;
    else process.env.LLV_STRUCTURED_HOSTS = previous;
  }
});

test("/api/tmux admits pane-less kill through the structured control path", async () => {
  const previous = process.env.LLV_STRUCTURED_HOSTS;
  structuredControlCalls = 0;
  structuredControlResult = {
    status: 202,
    body: {
      ok: true,
      structured: true,
      target: "conversation-kill",
      operationId: "kill-one",
      receipt: { operationId: "kill-one", status: "queued" },
    },
  };
  try {
    process.env.LLV_STRUCTURED_HOSTS = "1";
    const response = await POST(post({ path: PATHNAME, action: "kill" }));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      ok: true,
      structured: true,
      operationId: "kill-one",
      receipt: { status: "queued" },
    });
    expect(structuredControlCalls).toBe(1);
  } finally {
    structuredControlResult = null;
    if (previous === undefined) delete process.env.LLV_STRUCTURED_HOSTS;
    else process.env.LLV_STRUCTURED_HOSTS = previous;
  }
});

test("/api/tmux forwards account-aware structured reconfigure as one durable control", async () => {
  const previous = process.env.LLV_STRUCTURED_HOSTS;
  structuredControlCalls = 0;
  structuredControlRequest = null;
  structuredControlResult = {
    status: 202,
    body: {
      ok: true,
      structured: true,
      target: "conversation-reconfigure",
      operationId: "reconfigure-one",
      receipt: { operationId: "reconfigure-one", status: "queued" },
    },
  };
  try {
    process.env.LLV_STRUCTURED_HOSTS = "1";
    const response = await POST(post({
      path: PATHNAME,
      conversationId: "conversation-reconfigure",
      action: "reconfigure",
      model: "gpt-5.6-sol",
      effort: "high",
      fast: true,
      accountId: "work",
    }));
    expect(response.status).toBe(202);
    expect(structuredControlCalls).toBe(1);
    expect(structuredControlRequest as unknown).toEqual({
      path: PATHNAME,
      conversationId: "conversation-reconfigure",
      action: "reconfigure",
      reconfiguration: { model: "gpt-5.6-sol", effort: "high", fast: true, accountId: "work" },
    });
  } finally {
    structuredControlResult = null;
    if (previous === undefined) delete process.env.LLV_STRUCTURED_HOSTS;
    else process.env.LLV_STRUCTURED_HOSTS = previous;
  }
});

test("/api/tmux keeps a conversation-id kill on the structured outcome without legacy fallthrough", async () => {
  const previous = process.env.LLV_STRUCTURED_HOSTS;
  structuredControlCalls = 0;
  killCalls = 0;
  structuredControlResult = {
    status: 200,
    body: {
      ok: true,
      structured: true,
      target: "conversation_dead-replay",
      outcome: "delivered",
    },
  };
  try {
    process.env.LLV_STRUCTURED_HOSTS = "1";
    const response = await POST(post({ conversationId: "conversation_dead-replay", action: "kill" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      structured: true,
      target: "conversation_dead-replay",
      outcome: "delivered",
    });
    expect(structuredControlCalls).toBe(1);
    expect(killCalls).toBe(0);
  } finally {
    structuredControlResult = null;
    if (previous === undefined) delete process.env.LLV_STRUCTURED_HOSTS;
    else process.env.LLV_STRUCTURED_HOSTS = previous;
  }
});

test("/api/tmux POST kill never reports success with an empty target", async () => {
  killOutcome = { ok: true, target: "" };

  const response = await POST(post({ path: PATHNAME, action: "kill" }));

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ ok: false, outcome: "failed", error: "kill resolved no registered pane" });
  killOutcome = { ok: true, target: "agents:4.0" };
});
