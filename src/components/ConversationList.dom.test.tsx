import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import type { FileEntry } from "@/lib/types";

import { QuietFileRow } from "./ProjectTrash";

const dom = new Window({ width: 390, height: 844 });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
});
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: /max-width/.test(query),
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

afterEach(() => document.body.replaceChildren());

test("390px conversation rows keep both actions at 44px and the title shrinkable", () => {
  const file: FileEntry = {
    path: "/sessions/quiet.jsonl",
    root: "codex-sessions",
    name: "quiet.jsonl",
    project: "viewer",
    title: "A long conversation title that must stay inside a narrow phone row",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1024,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
  const host = document.createElement("div");
  host.style.width = "390px";
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<QuietFileRow file={file} activeSubtree={false} showProject onOpen={() => {}} />));

  const buttons = host.querySelectorAll("button");
  expect(buttons).toHaveLength(2);
  expect(buttons[0]!.className).toContain("min-h-11");
  expect(buttons[1]!.className).toContain("h-11");
  expect(buttons[0]!.className).toContain("min-w-0");
  expect(buttons[0]!.textContent).toContain("viewer");
  flushSync(() => root.unmount());
});
