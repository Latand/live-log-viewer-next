import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { POST as SEND } from "@/app/api/tasks/[id]/send/route";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { recordDirectOperatorWakatimeActivity } from "@/lib/wakatime/operatorActivity";
import { enqueueProductionOperatorHeartbeat, type WakatimeStateV1 } from "@/lib/wakatime/sync";

import { BulkActionBar } from "./BulkActionBar";
import type { SchemeNode } from "./layout";

/*
 * Issue #763: one operator input must produce exactly one operator heartbeat.
 * A bulk submit fans out one request per selected target, so without a shared
 * gesture identity a two-target submit counted the operator twice. The whole
 * chain is exercised here — the bar's per-target requests run through the real
 * send route, the real recorder and the real heartbeat queue — because the
 * defect lived in the seam between them, not inside any one of them.
 */

const AT_MS = Date.parse("2026-08-26T09:00:00.000Z");
const TASK_ID = "task-bulk-gesture";
const PROJECT = "project-fixture";

const dom = new Window({ url: "http://127.0.0.1/" });
const G = globalThis as Record<string, unknown>;

const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  matchMedia: (query: string) => ({
    matches: false,
    media: String(query),
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
  }),
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};

const tick = async () => {
  for (let step = 0; step < 8; step += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

function entry(target: string, engine: "claude" | "codex"): FileEntry {
  return {
    path: target,
    root: engine === "claude" ? "claude-projects" : "codex-sessions",
    name: `${engine}.jsonl`,
    project: PROJECT,
    title: `${engine} target`,
    engine,
    kind: "session",
    fmt: engine,
    parent: null,
    mtime: 1,
    size: 1,
    activity: "recent",
    proc: "running",
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

function node(file: FileEntry, x: number): SchemeNode {
  return { file, tasks: [], under: [], isRoot: true, x, y: 0, w: 240, h: 140 };
}

const TARGETS = [entry("/sessions/a.jsonl", "claude"), entry("/sessions/b.jsonl", "codex")];

const task: BoardTask = {
  id: TASK_ID,
  project: PROJECT,
  status: "inbox",
  text: "Rebuild the release notes",
  placement: "pinned",
  assignments: [],
  createdAt: "2026-08-26T08:59:00.000Z",
  updatedAt: "2026-08-26T08:59:00.000Z",
};

let stateDirectory = "";
let stateFile = "";
let sentBodies: Array<{ paths: string[]; clientRequestId?: string }> = [];

/** The send route, wired to fixtures for everything except the two things
    under test: the real operator recorder and the real heartbeat queue. */
function sendDependencies() {
  return {
    loadTasks: () => [task],
    listFiles: async () => TARGETS,
    deliverConversationMessage: async () => ({ ok: true as const, outcome: "delivered" as const, target: "structured" }),
    mutateTasks: <R,>(mutator: (tasks: BoardTask[]) => { tasks?: BoardTask[]; result: R }) => mutator([task]).result,
    recordOperatorActivity: (input: Parameters<typeof recordDirectOperatorWakatimeActivity>[0]) =>
      recordDirectOperatorWakatimeActivity(input, {
        enabled: () => true,
        now: () => AT_MS,
        enqueue: (action) => enqueueProductionOperatorHeartbeat(action, stateFile, () => true),
      }),
  } as unknown as Parameters<typeof SEND.withDependencies>[2];
}

async function handleFetch(url: string, init: { method?: string; body?: string }): Promise<Response> {
  const body = init.body ? JSON.parse(init.body) as Record<string, unknown> : {};
  if (url === "/api/tasks") return Response.json({ task });
  if (url === `/api/tasks/${TASK_ID}/send`) {
    sentBodies.push(body as { paths: string[]; clientRequestId?: string });
    const request = new NextRequest(`http://127.0.0.1${url}`, {
      method: "POST",
      headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: init.body,
    });
    return await SEND.withDependencies(request, { params: Promise.resolve({ id: TASK_ID }) }, sendDependencies());
  }
  throw new Error(`unexpected request: ${url}`);
}

let roots: Root[] = [];

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) {
    HAS[key] = key in G;
    SAVED[key] = G[key];
    G[key] = OVERRIDES[key];
  }
  (dom as unknown as { matchMedia: unknown }).matchMedia = OVERRIDES.matchMedia;
});

afterAll(async () => {
  await tick();
  for (const key of Object.keys(OVERRIDES)) {
    if (HAS[key]) G[key] = SAVED[key];
    else delete G[key];
  }
});

beforeEach(() => {
  stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-bulk-gesture-"));
  stateFile = path.join(stateDirectory, "wakatime-state.json");
  sentBodies = [];
  roots = [];
  dom.document.body.replaceChildren();
  G.fetch = (url: string, init: { method?: string; body?: string } = {}) => handleFetch(url, init);
});

afterEach(async () => {
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  await tick();
  fs.rmSync(stateDirectory, { recursive: true, force: true });
});

function mount(nodes: SchemeNode[]) {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(
    <BulkActionBar
      project={PROJECT}
      nodes={nodes}
      flowsByImpl={new Map()}
      onRemove={() => {}}
      onFit={() => {}}
      onExit={() => {}}
    />,
  ));
  roots.push(root);
  return host as unknown as HTMLElement;
}

/** React props off the rendered element: the same handler the operator's own
    keystroke and click reach, without depending on synthetic event plumbing. */
function reactProps<T>(element: Element): T {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, T>)[key]!;
}

async function submitBroadcast(host: HTMLElement, text: string) {
  const textarea = host.querySelector("textarea")!;
  flushSync(() => reactProps<{ onChange(event: unknown): void }>(textarea).onChange({ target: { value: text } }));
  /* Enter is the operator's own send gesture, and it runs the same composer
     submit the form and the Send button do. */
  flushSync(() => reactProps<{ onKeyDown(event: unknown): void }>(textarea).onKeyDown({
    key: "Enter",
    shiftKey: false,
    nativeEvent: { isComposing: false },
    preventDefault() {},
  }));
  await tick();
}

function pendingHeartbeats(): WakatimeStateV1["pending"] {
  if (!fs.existsSync(stateFile)) return [];
  return (JSON.parse(fs.readFileSync(stateFile, "utf8")) as WakatimeStateV1).pending;
}

test("a two-target bulk submit records exactly one operator heartbeat under one gesture id (#763)", async () => {
  const host = mount(TARGETS.map((file, index) => node(file, index * 300)));

  await submitBroadcast(host, "Rebuild the release notes");

  /* Both targets were delivered — one request each, as the bar has always
     done — and the operator was counted once for the whole submit. */
  expect(sentBodies.map((body) => body.paths)).toEqual([["/sessions/a.jsonl"], ["/sessions/b.jsonl"]]);
  const pending = pendingHeartbeats();
  expect(pending).toHaveLength(1);

  /* That single heartbeat is keyed by the one gesture id every request carried. */
  const gestureIds = new Set(sentBodies.map((body) => body.clientRequestId));
  expect(gestureIds.size).toBe(1);
  const gestureId = [...gestureIds][0]!;
  expect(gestureId).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  const gestureKey = crypto.createHash("sha256")
    .update(["llv-wakatime-direct-operator-v1", `task-send:${gestureId}`].join("\0"))
    .digest("hex");
  expect(pending[0]).toMatchObject({
    kind: "activity",
    stream: gestureKey,
    heartbeat: { project: PROJECT, time: AT_MS / 1_000, ai_session: gestureKey },
  });
});

test("a second bulk submit is a second operator input and records its own heartbeat (#763)", async () => {
  const host = mount(TARGETS.map((file, index) => node(file, index * 300)));

  await submitBroadcast(host, "Rebuild the release notes");
  await submitBroadcast(host, "Now publish them");

  expect(sentBodies).toHaveLength(4);
  expect(pendingHeartbeats()).toHaveLength(2);
  expect(new Set(sentBodies.map((body) => body.clientRequestId)).size).toBe(2);
});
