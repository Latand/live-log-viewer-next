import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  MouseEvent: dom.MouseEvent,
  Event: dom.Event,
  localStorage: dom.localStorage,
});

const { CornerStatus } = await import("./CornerStatus");
const { buildAttentionQueue } = await import("./attention");
const { isAwaitingUser } = await import("@/hooks/useSwitchboardData");
type FileEntry = import("@/lib/types").FileEntry;
type SwitchboardData = import("@/hooks/useSwitchboardData").SwitchboardData;
type SwitchboardItem = import("@/hooks/useSwitchboardData").SwitchboardItem;

const NOW = 1_800_000_000;

/* A finished user turn: the agent answered and idles as "recent". The
   switchboard counts it as waiting (the reply is yours to write), while the
   attention queue — hard blocks and live stalls only — never carries it. */
function finishedTurn(path: string): FileEntry {
  return {
    root: "claude-projects",
    name: path,
    path,
    project: "atlas",
    title: path,
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: NOW - 120,
    size: 10,
    activity: "recent",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
}

function item(file: FileEntry): SwitchboardItem {
  return { file, project: "atlas", title: file.title, descendants: 0, smt: file.mtime, kind: "waiting", statusLine: "" };
}

function data(waiting: SwitchboardItem[]): SwitchboardData {
  return { waiting, working: [], recent: [], older: [], livePreview: [] };
}

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();
});

test("a finished turn is a switchboard-only waiting signal: outside the attention queue, yet counted by the corner pill", async () => {
  const file = finishedTurn("/atlas-finished-turn");
  /* The signal exists only on the switchboard side of the split. */
  expect(isAwaitingUser(file, NOW)).toBeTrue();
  expect(buildAttentionQueue([file], NOW)).toEqual([]);

  /* So the corner pill must keep saying it — the attention island's count
     (queue-derived) cannot stand in for it (issue #963 review). */
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<CornerStatus data={data([item(file)])} onOpen={() => {}} />);
  });
  const button = host.querySelector("button")!;
  expect(button.textContent).toContain("1 waiting");
  expect(button.innerHTML).toContain("text-warning");
});

test("an arriving waiting signal still pulses the corner pill", async () => {
  const first = finishedTurn("/atlas-first");
  const second = finishedTurn("/atlas-second");
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<CornerStatus data={data([item(first)])} onOpen={() => {}} />);
  });
  expect(host.querySelector("button")!.className).not.toContain("scale-110");
  await act(async () => {
    root!.render(<CornerStatus data={data([item(first), item(second)])} onOpen={() => {}} />);
  });
  expect(host.querySelector("button")!.className).toContain("scale-110");
});
