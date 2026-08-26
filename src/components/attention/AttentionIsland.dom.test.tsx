import { afterEach, expect, test } from "bun:test";
import { act, useEffect } from "react";
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
  KeyboardEvent: dom.KeyboardEvent,
  Event: dom.Event,
  localStorage: dom.localStorage,
});

const { AttentionIsland, AttentionQueueRow } = await import("./AttentionIsland");
const { advanceAttentionCycle, buildAttentionQueue } = await import("../attention");
type FileEntry = import("@/lib/types").FileEntry;
type AttentionItem = import("../attention").AttentionItem;

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();
});

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(node);
  });
  return host;
}

function island(overrides: Partial<Parameters<typeof AttentionIsland>[0]> = {}) {
  return (
    <AttentionIsland
      count={3}
      mobile={false}
      queueOpen={false}
      filterActive={false}
      onToggleQueue={() => {}}
      onNext={() => {}}
      onToggleFilter={() => {}}
      {...overrides}
    />
  );
}

const click = (element: Element, init: { shiftKey?: boolean } = {}) =>
  act(async () => {
    element.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true, ...init }) as never);
  });

test("the count opens the queue and announces itself with the shared badge wording", async () => {
  const toggles: string[] = [];
  const host = await render(island({ count: 6, onToggleQueue: () => toggles.push("queue") }));
  const count = host.querySelector("[data-attention-count]")!;
  expect(count.textContent).toContain("Needs you");
  expect(count.textContent).toContain("6");
  expect(count.getAttribute("aria-label")).toBe("6 waiting");
  expect(count.getAttribute("aria-expanded")).toBe("false");
  await click(count);
  expect(toggles).toEqual(["queue"]);
});

test("Next advances forward on click and backward on Shift-click, mirroring N/Shift-N", async () => {
  const advances: Array<1 | -1> = [];
  const host = await render(island({ onNext: (dir) => advances.push(dir) }));
  const next = host.querySelector("[data-attention-next]")!;
  expect(next.getAttribute("aria-keyshortcuts")).toBe("n shift+n");
  await click(next);
  await click(next, { shiftKey: true });
  expect(advances).toEqual([1, -1]);
});

test("the filter toggle keeps its pressed state and accessible labels", async () => {
  const toggles: string[] = [];
  let host = await render(island({ onToggleFilter: () => toggles.push("filter") }));
  const filter = host.querySelector("[data-attention-filter]")!;
  expect(filter.getAttribute("aria-pressed")).toBe("false");
  expect(filter.getAttribute("aria-label")).toContain("(F)");
  await click(filter);
  expect(toggles).toEqual(["filter"]);
  await act(async () => { root?.unmount(); });
  document.body.replaceChildren();

  host = await render(island({ filterActive: true }));
  expect(host.querySelector("[data-attention-filter]")!.getAttribute("aria-pressed")).toBe("true");
});

test("the zero state is present, muted, inert and pulse-free", async () => {
  const host = await render(island({ count: 0 }));
  const zero = host.querySelector("[data-attention-island]")!;
  expect(zero.hasAttribute("data-attention-zero")).toBeTrue();
  expect(zero.textContent).toContain("Needs you");
  expect(zero.textContent).toContain("0");
  expect(zero.getAttribute("aria-label")).toBe("0 waiting");
  /* Quiet means quiet: no actions to press, no warning tone, no animation. */
  expect(host.querySelector("button")).toBeNull();
  expect(zero.className).not.toContain("warning");
  expect(zero.className).not.toContain("animate");
  expect(zero.className).toContain("text-muted");
});

test("mobile keeps the compact count and a 44px Next, and hides the desktop-only filter", async () => {
  const advances: Array<1 | -1> = [];
  const host = await render(island({ mobile: true, count: 4, onNext: (dir) => advances.push(dir) }));
  const count = host.querySelector("[data-attention-count]")!;
  const next = host.querySelector("[data-attention-next]")!;
  expect(count.textContent).toContain("4");
  expect(count.className).toContain("min-h-11");
  expect(next.className).toContain("min-h-11");
  expect(next.getAttribute("aria-label")).toContain("(N");
  expect(host.querySelector("[data-attention-filter]")).toBeNull();
  await click(next);
  expect(advances).toEqual([1]);
});

/* ------------------------------------------------------------------------- *
 * The shared-cycle contract: the visible Next and the N/Shift-N keys move
 * ONE pointer through `advanceAttentionCycle`, wired here exactly as the
 * Viewer wires them (keys over the project queue, Next over the global one).
 * ------------------------------------------------------------------------- */

const NOW = 1_800_000_000;

function entry(path: string, project: string, since: number): FileEntry {
  return {
    root: "claude-projects",
    name: path,
    path,
    project,
    title: path,
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: NOW - 60,
    size: 10,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: { since, screenTail: "❯ 1. Yes", target: "llv:0.0", menu: null },
  } as FileEntry;
}

function Harness({ pointer, queue, projectQueue, onServe }: {
  pointer: { current: string | null };
  queue: AttentionItem[];
  projectQueue: AttentionItem[];
  onServe: (path: string) => void;
}) {
  useEffect(() => {
    const onDown = (event: KeyboardEvent) => {
      if (event.key !== "n" && event.key !== "N") return;
      const next = advanceAttentionCycle(pointer, projectQueue, event.shiftKey ? -1 : 1);
      if (next) onServe(next.file.path);
    };
    window.addEventListener("keydown", onDown);
    return () => window.removeEventListener("keydown", onDown);
  }, [pointer, projectQueue, onServe]);
  return (
    <AttentionIsland
      count={queue.length}
      mobile={false}
      queueOpen={false}
      filterActive={false}
      onToggleQueue={() => {}}
      onToggleFilter={() => {}}
      onNext={(dir) => {
        const next = advanceAttentionCycle(pointer, queue, dir);
        if (next) onServe(next.file.path);
      }}
    />
  );
}

const pressN = (shiftKey = false) =>
  act(async () => {
    window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: shiftKey ? "N" : "n", shiftKey, bubbles: true }) as never);
  });

test("mouse Next and keyboard N continue one cycle and survive queue mutation mid-flight", async () => {
  const files = [
    entry("/alpha-old", "alpha", NOW - 400),
    entry("/beta-mid", "beta", NOW - 300),
    entry("/alpha-new", "alpha", NOW - 200),
  ];
  const queue = buildAttentionQueue(files, NOW);
  const projectQueue = buildAttentionQueue(files, NOW, "alpha");
  const served: string[] = [];
  const pointer: { current: string | null } = { current: null };
  const host = await render(<Harness pointer={pointer} queue={queue} projectQueue={projectQueue} onServe={(path) => served.push(path)} />);

  /* Keyboard first: N serves alpha's oldest. */
  await pressN();
  /* Mouse continues the SAME pointer over the global queue: beta is next. */
  await click(host.querySelector("[data-attention-next]")!);
  /* Shift-N walks the project queue backward from the shared pointer; beta's
     id is off-project, so the id-anchored fallback serves the project tail. */
  await pressN(true);
  expect(served).toEqual(["/alpha-old", "/beta-mid", "/alpha-new"]);

  /* The queue mutates under the open cycle: the pointed-at item (beta) is
     answered elsewhere. The rebuilt queue drops its id, and the next visible
     advance serves the next-oldest remaining item instead of erring or
     restarting arbitrarily. */
  await act(async () => { root?.unmount(); });
  document.body.replaceChildren();
  pointer.current = queue[1]!.id;
  const rebuilt = buildAttentionQueue([files[0]!, files[2]!], NOW);
  const rebuiltProject = buildAttentionQueue([files[0]!, files[2]!], NOW, "alpha");
  const second = await render(<Harness pointer={pointer} queue={rebuilt} projectQueue={rebuiltProject} onServe={(path) => served.push(path)} />);
  await click(second.querySelector("[data-attention-next]")!);
  expect(served.at(-1)).toBe("/alpha-old");
});

test("an emptied queue leaves both routes quiet", async () => {
  const pointer: { current: string | null } = { current: null };
  const served: string[] = [];
  await render(<Harness pointer={pointer} queue={[]} projectQueue={[]} onServe={(path) => served.push(path)} />);
  await pressN();
  /* The island renders its inert zero pill: there is no Next to click. */
  expect(document.querySelector("[data-attention-next]")).toBeNull();
  expect(document.querySelector("[data-attention-zero]")).not.toBeNull();
  expect(served).toEqual([]);
});

/* ------------------------------------------------------------------------- *
 * The popover rows NAME the decision (issue #1167). The count says how many
 * agents are waiting; a row that only repeats the conversation title still
 * leaves the operator to open each one to find out what it wants.
 * ------------------------------------------------------------------------- */

function pendingQuestion(header: string): FileEntry["pendingQuestion"] {
  return {
    kind: "question",
    toolUseId: `tool-${header}`,
    transcriptPath: "/alpha-question",
    pid: 4242,
    paneTarget: null,
    askedAt: "2026-08-25T10:00:00.000Z",
    questions: [{ header, question: `${header}?`, multiSelect: false, options: [] }],
  } as FileEntry["pendingQuestion"];
}

function questionItem(overrides: Partial<FileEntry> = {}): AttentionItem {
  const file = { ...entry("/alpha-question", "alpha", NOW - 120), waitingInput: null, pendingQuestion: pendingQuestion("Rollout window"), ...overrides } as FileEntry;
  return buildAttentionQueue([file], NOW)[0]!;
}

test("a queue row carries the decision line, the title, the project and the age", async () => {
  const item = questionItem({
    title: "Ship the rollout",
    durableLineage: { kind: "spawn", role: "builder", parentConversationId: null, reviewsConversationId: null, memberships: [] },
  } as Partial<FileEntry>);
  const opened: string[] = [];
  const host = await render(<AttentionQueueRow item={item} onOpen={() => opened.push(item.id)} />);

  const row = host.querySelector("[data-attention-row]")!;
  expect(row.getAttribute("data-attention-row")).toBe(item.id);
  expect(row.textContent).toContain("Ship the rollout");
  /* The one shared line: the decision, then who is asking. */
  expect(host.querySelector("[data-attention-decision]")!.textContent).toBe("Rollout window · Builder");
  expect(row.textContent).toContain("alpha");

  await click(row);
  expect(opened).toEqual([item.id]);
});

test("a terminal prompt and a stalled agent each keep their own wording", async () => {
  const terminal = buildAttentionQueue([entry("/alpha-terminal", "alpha", NOW - 60)], NOW)[0]!;
  let host = await render(<AttentionQueueRow item={terminal} onOpen={() => {}} />);
  expect(host.querySelector("[data-attention-decision]")!.textContent).toBe("❯ 1. Yes");
  await act(async () => { root?.unmount(); });
  document.body.replaceChildren();

  const stalledFile = { ...entry("/alpha-stalled", "alpha", NOW - 60), waitingInput: null, activity: "stalled", proc: "running", mtime: NOW - 60 } as FileEntry;
  const stalled = buildAttentionQueue([stalledFile], NOW)[0]!;
  host = await render(<AttentionQueueRow item={stalled} onOpen={() => {}} />);
  expect(host.querySelector("[data-attention-decision]")!.textContent).toBe("interrupted or awaiting permission");
});
