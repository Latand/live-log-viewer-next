import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { LogSubscriber } from "./logBus";
import type { FileEntry, LogChunk } from "@/lib/types";

const actualLogBus = await import("./logBus");
const subscribers = new Map<string, LogSubscriber>();
mock.module("@/hooks/logBus", () => ({
  subscribeLog(subscriber: LogSubscriber) {
    subscribers.set(subscriber.path, subscriber);
    return () => {
      if (subscribers.get(subscriber.path) === subscriber) subscribers.delete(subscriber.path);
    };
  },
}));

const { useLogTail } = await import("./useLogTail");
const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) {
    HAS[key] = key in G;
    SAVED[key] = G[key];
    G[key] = OVERRIDES[key];
  }
});

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const key of Object.keys(OVERRIDES)) {
    if (HAS[key]) G[key] = SAVED[key];
    else delete G[key];
  }
  mock.module("@/hooks/logBus", () => actualLogBus);
});

let roots: Root[] = [];
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  subscribers.clear();
  dom.document.body.replaceChildren();
});

const entry = (path: string): FileEntry => ({
  path,
  root: "codex-sessions",
  name: path.split("/").at(-1) ?? "session.jsonl",
  project: path.includes("project-a") ? "project-a" : "project-b",
  cwd: "/repo",
  projectRoot: "/repo",
  title: path,
  engine: "codex",
  kind: "session",
  fmt: "codex",
  parent: null,
  mtime: 1,
  size: 128,
  activity: "recent",
  proc: null,
  pid: null,
  model: null,
  pendingQuestion: null,
  waitingInput: null,
});

function Probe({ file }: { file: FileEntry }) {
  const tail = useLogTail(file);
  return <output data-offset={tail.linesStart}>{tail.lines.join("|")}</output>;
}

function mount(file: FileEntry): Root {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(<Probe file={file} />));
  roots.push(root);
  return root;
}

const waitForSubscriber = async (path: string) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const subscriber = subscribers.get(path);
    if (subscriber) return subscriber;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`missing log subscriber for ${path}`);
};

const deliver = (subscriber: LogSubscriber, chunk: LogChunk) => {
  flushSync(() => subscriber.onChunk(chunk));
};

test("A to B to A restores cached tail lines before the delayed transport responds", async () => {
  const a = entry("/sessions/project-a/session.jsonl");
  const b = entry("/sessions/project-b/session.jsonl");

  mount(a);
  const aSubscriber = await waitForSubscriber(a.path);
  deliver(aSubscriber, { data: '{"message":"cached A"}\n', offset: 25, size: 25, start: 0 });
  expect(dom.document.querySelector("output")?.textContent).toContain("cached A");

  flushSync(() => roots.pop()!.unmount());
  mount(b);
  const bSubscriber = await waitForSubscriber(b.path);
  deliver(bSubscriber, { data: '{"message":"cached B"}\n', offset: 25, size: 25, start: 0 });
  expect(dom.document.querySelector("output")?.textContent).toContain("cached B");

  flushSync(() => roots.pop()!.unmount());
  mount(a);
  const resumed = await waitForSubscriber(a.path);
  expect(dom.document.querySelector("output")?.textContent).toContain("cached A");
  expect(resumed.getOffset()).toBe(25);
  deliver(resumed, { data: '{"message":"live A"}\n', offset: 48, size: 48, start: 25 });
  expect(dom.document.querySelector("output")?.textContent).toContain("cached A");
  expect(dom.document.querySelector("output")?.textContent).toContain("live A");
});
