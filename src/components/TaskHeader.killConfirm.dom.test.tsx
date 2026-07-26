import { afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { en } from "@/lib/i18n/en";
import type { FileEntry } from "@/lib/types";

/* Issue #700: in compact mode `task.confirmKill` was not rendered at all — the
   confirm read "Kill 908010 / No", so no question was posed and the only
   identifier was a PID. `compact` is passed unconditionally by every canvas
   card and branch pane, so this held at every width, not only on the phone. */

mock.module("./useAgentCapabilities", () => ({
  useAgentCapabilities: () => ({
    caps: { controls: { kill: { state: "enabled" } } },
    runtime: null,
    structuredSession: null,
    runtimeEnabled: false,
    attachMode: "tmux",
  }),
}));

const { ProcessStatusControls } = await import("./TaskHeader");

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
});

afterEach(() => {
  document.body.replaceChildren();
});

function runningFile(title: string): FileEntry {
  return {
    path: "/sessions/kill.jsonl",
    root: "claude-projects",
    name: "kill.jsonl",
    project: "demo",
    title,
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1_000,
    size: 1,
    activity: "live",
    proc: "running",
    pid: 908_010,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  } as unknown as FileEntry;
}

function openConfirm(file: FileEntry): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => { root.render(<ProcessStatusControls file={file} compact />); });
  const kill = [...host.querySelectorAll("button")].find((node) => node.textContent === en["task.kill"]);
  expect(kill).toBeTruthy();
  flushSync(() => { kill!.click(); });
  return host as unknown as HTMLElement;
}

test("a compact kill confirmation asks a question and names the conversation", () => {
  const host = openConfirm(runningFile("Rebuild the pipeline registry projection"));

  /* The question survives compact mode, and it names the target. */
  expect(host.textContent).toContain("Stop Rebuild the pipeline registry projection?");
  /* Yes/No now negate an actual question. */
  expect(host.textContent).toContain(en["common.yes"]);
  expect(host.textContent).toContain(en["common.no"]);
  /* The PID stays available, demoted to a secondary chip. */
  expect(host.textContent).toContain("PID 908010");
  /* …and it is no longer the confirm button's only content. */
  const confirm = [...host.querySelectorAll("button")].find((node) => node.textContent === en["common.yes"]);
  expect(confirm).toBeTruthy();
  expect(confirm!.textContent).not.toContain("908010");
});

test("an untitled conversation still gets a question rather than a bare PID", () => {
  const host = openConfirm(runningFile(""));
  expect(host.textContent).toContain(`Stop ${en["task.confirmKillUntitled"]}?`);
});
