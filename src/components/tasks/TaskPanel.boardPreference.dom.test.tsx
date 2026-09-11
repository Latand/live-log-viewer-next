import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { boardConversationKeys, taskShowsOnBoard } from "@/lib/tasks/boardVisibility";
import type { BoardTask } from "@/lib/tasks/types";

/**
 * The task panel's empty-band control (#1614).
 *
 * It used to be suppressed for any task carrying an assignment row — which is
 * most of them, an assignment being written at spawn and never removed. On the
 * reported board that left 319 tasks with no working control anywhere: the band
 * offered one, and the panel hid the honest one.
 *
 * It is a PREFERENCE now, offered for every row and labelled as one, because
 * this panel lists every project and cannot see what any board resolved. What
 * decides whether a band is drawn is the board's own answer, which is asserted
 * where it lives (`taskBands.test.ts`).
 */
const dom = new HappyWindow();

function bindDomGlobals() {
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    Node: dom.Node,
    HTMLElement: dom.HTMLElement,
    HTMLButtonElement: dom.HTMLButtonElement,
    HTMLTextAreaElement: dom.HTMLTextAreaElement,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    MouseEvent: dom.MouseEvent,
    PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
    sessionStorage: dom.sessionStorage,
    localStorage: dom.localStorage,
    matchMedia: () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }),
  });
  (dom as unknown as { matchMedia: () => unknown }).matchMedia = () => ({
    matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  });
}

bindDomGlobals();
const { TaskPanel } = await import("./TaskPanel");
const { TaskToastHost } = await import("./taskToast");

const roots = new Set<Root>();
let patches: { url: string; body: unknown }[] = [];
let previousFetch: typeof fetch;
beforeEach(() => {
  bindDomGlobals();
  patches = [];
  previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() !== "GET") {
      patches.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
    }
    return new Response(JSON.stringify({ ok: true, task: {} }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = previousFetch;
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  dom.localStorage.clear();
});

const assignment = { path: "/agent.jsonl", conversationId: "conversation-agent", panePid: null, state: "delivered" as const, error: null, at: "2026-01-01T00:00:00.000Z" };

function task(id: string, over: Partial<BoardTask> = {}): BoardTask {
  return {
    id, project: "repo-board", status: "assigned", text: `Task ${id}`, placement: "unplaced",
    assignments: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as BoardTask;
}

function mount(tasks: BoardTask[], files: { path: string; conversationId?: string | null }[] = []) {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  roots.add(root);
  flushSync(() => root.render(
    <TaskPanel
      tasks={tasks}
      project="repo-board"
      boardMembers={boardConversationKeys(files)}
      favorites={[]}
      onOpenFavorite={() => {}}
      onToggleFavorite={() => {}}
      onOpenTask={() => {}}
      onClose={() => {}}
    />,
  ));
  return host as unknown as HTMLElement;
}

const toggle = (host: HTMLElement, id: string) => host.querySelector(`[data-task-board-toggle="${id}"]`) as HTMLButtonElement | null;

test("every row can edit its empty-band preference, including the ones carrying an assignment", () => {
  const host = mount([
    task("never-launched"),
    task("historical", { assignments: [{ ...assignment, path: "/archived.jsonl", conversationId: "conversation-archived" }] }),
    task("held", { assignments: [assignment] }),
  ], [{ path: "/agent.jsonl", conversationId: "conversation-agent" }]);

  /* THE REGRESSION: the two rows with an assignment row used to have no control
     at all, and they are the majority of a board that has been in use. */
  for (const id of ["never-launched", "historical", "held"]) {
    expect(toggle(host, id)).not.toBeNull();
    expect(toggle(host, id)!.disabled).toBe(false);
  }
});

test("the control writes the preference and says which way it is set", () => {
  const host = mount([task("shown-row"), task("hidden-row", { board: "hidden" })]);
  expect(toggle(host, "shown-row")!.getAttribute("data-task-board-state")).toBe("shown");
  expect(toggle(host, "hidden-row")!.getAttribute("data-task-board-state")).toBe("hidden");
  /* The off-board state is named, so a row with no band is not a mystery. */
  expect(host.textContent).toContain("off board");

  flushSync(() => toggle(host, "shown-row")!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
  expect(patches).toHaveLength(1);
  expect(patches[0]!.url).toContain("shown-row");
  expect(patches[0]!.body).toEqual({ board: "hidden" });

  flushSync(() => toggle(host, "hidden-row")!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
  expect(patches[1]!.body).toEqual({ board: "shown" });
});

test("a row that still names a scanned conversation says so instead of losing its control", () => {
  const host = mount(
    [task("held", { assignments: [assignment] }), task("historical", { assignments: [{ ...assignment, path: "/archived.jsonl", conversationId: "conversation-archived" }] })],
    [{ path: "/agent.jsonl", conversationId: "conversation-agent" }],
  );
  const rowOf = (id: string) => toggle(host, id)!.closest("div")!.parentElement!;
  expect(rowOf("held").textContent).toContain("names an agent");
  expect(rowOf("historical").textContent).not.toContain("names an agent");
  /* And both keep the control: the note is a statement about the scan, not a
     claim about the scene, so it never takes the preference away. */
  expect(toggle(host, "held")).not.toBeNull();
  expect(toggle(host, "historical")).not.toBeNull();
});

test("a hidden preference on a task that holds a member is readable and reversible (#1614)", () => {
  /* The state the migration leaves every staffed row in: `board: "hidden"`
     stored, and a member that overrides it, so the band is drawn. Reading the
     control off the effective visibility made it say «remove from board»,
     write the value already stored, and never offer the way back. */
  const host = mount(
    [task("staffed-hidden", { board: "hidden", assignments: [assignment] })],
    [{ path: "/agent.jsonl", conversationId: "conversation-agent" }],
  );
  const button = toggle(host, "staffed-hidden")!;

  /* The control states the stored preference and offers the other direction. */
  expect(button.getAttribute("data-task-board-state")).toBe("hidden");
  expect(button.textContent).toContain("show on board");
  expect(button.textContent).not.toContain("remove from board");

  flushSync(() => button.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
  expect(patches).toHaveLength(1);
  expect(patches[0]!.body).toEqual({ board: "shown" });

  /* And the two questions stay apart: the row keeps its member, so its band is
     drawn either way and the «off board» badge — the one thing here that IS
     about effective visibility — never appears. */
  expect(host.textContent).not.toContain("off board");
  expect(host.textContent).toContain("names an agent");
  expect(taskShowsOnBoard(task("staffed-hidden", { board: "hidden", assignments: [assignment] }), true)).toBe(true);
});

test("with no member, the same stored preference is what the badge and the control agree on", () => {
  const host = mount([task("empty-hidden", { board: "hidden" })]);
  const button = toggle(host, "empty-hidden")!;
  expect(button.getAttribute("data-task-board-state")).toBe("hidden");
  expect(button.textContent).toContain("show on board");
  /* Nothing overrides the preference here, so the row is genuinely off board. */
  expect(host.textContent).toContain("off board");
  flushSync(() => button.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
  expect(patches[0]!.body).toEqual({ board: "shown" });
});

test("a “show on board” the server refuses is told to the operator, not swallowed (#1627)", async () => {
  /* The board carries its full complement of bands, so the restore is refused.
     Before the cap counted bands this write could not fail, and the control
     dropped its result — which would have left the row claiming a band the
     canvas never drew. */
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ error: 'The board already shows 300 task bands for this project. Hide a band you no longer need, or keep this task off the board with board: "hidden".' }),
    { status: 409, headers: { "content-type": "application/json" } },
  )) as unknown as typeof fetch;

  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  roots.add(root);
  flushSync(() => root.render(
    <>
      <TaskPanel
        tasks={[task("empty-hidden", { board: "hidden" })]}
        project="repo-board"
        boardMembers={boardConversationKeys([])}
        favorites={[]}
        onOpenFavorite={() => {}}
        onToggleFavorite={() => {}}
        onOpenTask={() => {}}
        onClose={() => {}}
      />
      <TaskToastHost />
    </>,
  ));

  const button = (host as unknown as HTMLElement).querySelector('[data-task-board-toggle="empty-hidden"]') as HTMLButtonElement;
  flushSync(() => button.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));

  expect(dom.document.body.textContent).toContain("300 task bands");
});
