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

/* Mobile v2 lane 3 moved the kill REQUEST into `useProcessKill`, so the phone's
   menu row and this desktop control cannot drift apart. What the move must not
   cost the desktop is the escalation: a SIGTERM the host refuses is exactly the
   moment the operator wants SIGKILL, and the armed row already carries it as
   its primary word. Collapsing the row on a failure buries that behind a
   re-arm. */
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

test("a refused SIGTERM keeps the row armed, with SIGKILL one press away (#699/#700)", async () => {
  const posted: { path?: string; force?: boolean }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    posted.push(JSON.parse(String(init?.body)));
    return { ok: true, status: 200, json: async () => ({ ok: false, error: "no such process" }) } as unknown as Response;
  }) as unknown as typeof fetch;
  try {
    const host = openConfirm(runningFile("Rebuild the pipeline registry projection"));
    const yes = [...host.querySelectorAll("button")].find((node) => node.textContent === en["common.yes"]);
    expect(yes).toBeTruthy();
    flushSync(() => { yes!.click(); });
    await settle();

    /* The question is still on screen, and the button that was «Yes» now says
       what the next press will send. */
    expect(host.textContent).toContain("Stop Rebuild the pipeline registry projection?");
    expect(host.textContent).toContain("no such process");
    const escalate = [...host.querySelectorAll("button")].find((node) => node.textContent === "SIGKILL");
    expect(escalate).toBeTruthy();

    flushSync(() => { escalate!.click(); });
    await settle();
    expect(posted).toEqual([
      { path: "/sessions/kill.jsonl", force: false },
      { path: "/sessions/kill.jsonl", force: true },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("an accepted kill collapses the armed row", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ ok: true, pid: 908_010 }) } as unknown as Response)) as unknown as typeof fetch;
  try {
    const host = openConfirm(runningFile("Rebuild the pipeline registry projection"));
    const yes = [...host.querySelectorAll("button")].find((node) => node.textContent === en["common.yes"]);
    flushSync(() => { yes!.click(); });
    await settle();

    expect(host.textContent).not.toContain("Stop Rebuild the pipeline registry projection?");
    expect(host.textContent).toContain("SIGTERM");
  } finally {
    globalThis.fetch = original;
  }
});
