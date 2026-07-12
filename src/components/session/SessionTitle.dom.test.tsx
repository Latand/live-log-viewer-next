import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { FileEntry } from "@/lib/types";

import { SessionTitle } from "./SessionTitle";

const dom = new Window({ url: "http://127.0.0.1/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  FocusEvent: dom.FocusEvent,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.MouseEvent,
});

const UUID = "11111111-2222-4333-8444-555555555555";

function entry(over: Partial<FileEntry> = {}): FileEntry {
  return {
    path: `/home/u/.claude/projects/proj/${UUID}.jsonl`,
    root: "claude-projects",
    name: "x",
    project: "proj",
    title: "Fix the login bug",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 0,
    size: 0,
    activity: "idle",
    proc: "running",
    pid: 4242,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...over,
  } as FileEntry;
}

interface FetchCall {
  url: string;
  body: Record<string, unknown>;
}

let calls: FetchCall[] = [];
let respond: (call: FetchCall) => { status: number; json: unknown } = () => ({ status: 200, json: { ok: true, override: null } });

beforeEach(() => {
  calls = [];
  respond = (call) => {
    const title = call.body.title as string | null;
    const base = (call.body.baseRevision as number | undefined) ?? 0;
    // Mirror the server: a set returns the active record at rev 1; a clear
    // returns no record and the tombstone revision (baseRevision + 1).
    if (title === null) return { status: 200, json: { ok: true, override: null, revision: base + 1 } };
    return { status: 200, json: { ok: true, override: { key: `uuid:claude:${UUID}`, title, revision: 1, updatedAt: "t" }, revision: 1 } };
  };
  (globalThis as { fetch?: unknown }).fetch = async (url: string, init?: { body?: string }) => {
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const call = { url, body };
    calls.push(call);
    const { status, json } = respond(call);
    return { ok: status >= 200 && status < 300, status, json: async () => json } as unknown as Response;
  };
});

const mounted: Array<() => void> = [];
afterEach(() => {
  mounted.splice(0).forEach((fn) => fn());
  document.body.replaceChildren();
});

function mount(file: FileEntry, autoEditToken?: number): { host: HTMLElement; rerender(next: FileEntry, token?: number): void } {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  const rerender = (next: FileEntry, token?: number) => flushSync(() => root.render(<SessionTitle file={next} autoEditToken={token} />));
  rerender(file, autoEditToken);
  mounted.push(() => {
    flushSync(() => root.unmount());
    host.remove();
  });
  return { host, rerender };
}

function dispatch(target: EventTarget, event: unknown): boolean {
  return target.dispatchEvent(event as Event);
}

function typeInto(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, value);
  dispatch(input, new dom.Event("input", { bubbles: true }));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
}

test("pencil opens the editor and Enter saves the new name (rename + persistence)", async () => {
  const view = mount(entry());
  const pencil = view.host.querySelector('button[aria-label^="Rename"]') as HTMLButtonElement;
  expect(pencil).toBeTruthy();
  flushSync(() => pencil.click());

  const input = view.host.querySelector('input[aria-label="Session title"]') as HTMLInputElement;
  expect(input).toBeTruthy();
  // Editor preselects the current effective title.
  expect(input.value).toBe("Fix the login bug");

  flushSync(() => typeInto(input, "Login flow rework"));
  flushSync(() => dispatch(input, new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  await settle();

  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("/api/session/title");
  expect(calls[0]!.body).toMatchObject({ path: entry().path, title: "Login flow rework" });

  // Optimistic: the displayed title updates before any poll arrives.
  flushSync(() => {});
  expect(view.host.textContent).toContain("Login flow rework");
});

test("Escape cancels without saving", async () => {
  const view = mount(entry());
  flushSync(() => (view.host.querySelector('button[aria-label^="Rename"]') as HTMLButtonElement).click());
  const input = view.host.querySelector('input[aria-label="Session title"]') as HTMLInputElement;
  flushSync(() => typeInto(input, "discarded"));
  flushSync(() => dispatch(input, new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await settle();
  expect(calls).toHaveLength(0);
  expect(view.host.querySelector('input[aria-label="Session title"]')).toBeNull();
  expect(view.host.textContent).toContain("Fix the login bug");
});

test("Reset clears the override back to the auto title", async () => {
  // An override is already in effect: title is custom, autoTitle carries the derivation.
  const view = mount(entry({ title: "Custom name", autoTitle: "Fix the login bug", titleRevision: 3 }));
  flushSync(() => (view.host.querySelector('button[aria-label^="Rename"]') as HTMLButtonElement).click());

  const reset = view.host.querySelector('button[aria-label="Reset to auto title"]') as HTMLButtonElement;
  expect(reset).toBeTruthy();
  flushSync(() => reset.click());
  await settle();

  expect(calls).toHaveLength(1);
  // Reset sends a null title (clear) against the current revision.
  expect(calls[0]!.body.title).toBeNull();
  expect(calls[0]!.body.baseRevision).toBe(3);

  // The auto title comes back optimistically.
  flushSync(() => {});
  expect(view.host.textContent).toContain("Fix the login bug");
});

test("a newer server rename settles an optimistic set instead of masking it", async () => {
  const view = mount(entry());
  flushSync(() => (view.host.querySelector('button[aria-label^="Rename"]') as HTMLButtonElement).click());
  const input = view.host.querySelector('input[aria-label="Session title"]') as HTMLInputElement;
  flushSync(() => typeInto(input, "mine"));
  flushSync(() => dispatch(input, new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  await settle();
  expect(view.host.textContent).toContain("mine");

  // A poll brings a newer revision with a different title (another device).
  view.rerender(entry({ title: "theirs", autoTitle: "Fix the login bug", titleRevision: 5 }));
  flushSync(() => {});
  const title = view.host.querySelector('span[role="button"]')!;
  expect(title.textContent).toContain("theirs");
  expect(title.textContent).not.toContain("mine");
});

test("a later server change surfaces after an optimistic reset settles the tombstone", async () => {
  const view = mount(entry({ title: "Custom name", autoTitle: "Fix the login bug", titleRevision: 3 }));
  flushSync(() => (view.host.querySelector('button[aria-label^="Rename"]') as HTMLButtonElement).click());
  flushSync(() => (view.host.querySelector('button[aria-label="Reset to auto title"]') as HTMLButtonElement).click());
  await settle();
  expect(view.host.textContent).toContain("Fix the login bug");

  // The reset's tombstone lands (rev 4) and then a newer rename (rev 5) arrives;
  // the optimistic overlay must not keep masking server state.
  view.rerender(entry({ title: "renamed elsewhere", autoTitle: "Fix the login bug", titleRevision: 5 }));
  flushSync(() => {});
  expect(view.host.querySelector('span[role="button"]')!.textContent).toContain("renamed elsewhere");
});

test("a second edit still saves on blur after an earlier cancel (no stale suppression)", async () => {
  const view = mount(entry());
  // First edit, then cancel via the Cancel control (arms blur suppression;
  // unmounting a focused input may not emit the blur that would clear it).
  flushSync(() => (view.host.querySelector('button[aria-label^="Rename"]') as HTMLButtonElement).click());
  const cancel = view.host.querySelector('button[aria-label="Cancel"]') as HTMLButtonElement;
  flushSync(() => cancel.click());
  await settle();
  expect(calls).toHaveLength(0);

  // Second edit: a genuine blur must persist the new name.
  flushSync(() => (view.host.querySelector('button[aria-label^="Rename"]') as HTMLButtonElement).click());
  const input = view.host.querySelector('input[aria-label="Session title"]') as HTMLInputElement;
  flushSync(() => typeInto(input, "second attempt"));
  // React binds onBlur to the bubbling focusout event.
  flushSync(() => dispatch(input, new dom.Event("focusout", { bubbles: true })));
  await settle();

  expect(calls).toHaveLength(1);
  expect(calls[0]!.body.title).toBe("second attempt");
});

test("a revision conflict adopts the server record and retries once", async () => {
  respond = (call) => {
    if (calls.length === 1) {
      return { status: 409, json: { error: "revision conflict", conflict: { key: `uuid:claude:${UUID}`, title: "other device", revision: 5, updatedAt: "t" } } };
    }
    return { status: 200, json: { ok: true, override: { key: `uuid:claude:${UUID}`, title: call.body.title, revision: 6, updatedAt: "t" }, revision: 6 } };
  };
  const view = mount(entry());
  flushSync(() => (view.host.querySelector('button[aria-label^="Rename"]') as HTMLButtonElement).click());
  const input = view.host.querySelector('input[aria-label="Session title"]') as HTMLInputElement;
  flushSync(() => typeInto(input, "my rename"));
  flushSync(() => dispatch(input, new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  await settle();
  await settle();

  expect(calls).toHaveLength(2);
  // The retry carries the server's revision (5) as the new base.
  expect(calls[1]!.body.baseRevision).toBe(5);
  expect(calls[1]!.body.title).toBe("my rename");
});

test("a clear conflicting with a server tombstone retries and records the real tombstone revision", async () => {
  // Clear → 409 with a tombstone at rev 5; retry → no-op tombstone still at 5;
  // a later edit must base on 5, not a fabricated 6.
  respond = (call) => {
    if (calls.length === 1) return { status: 409, json: { error: "revision conflict", conflict: { key: `uuid:claude:${UUID}`, title: null, revision: 5, updatedAt: "t" } } };
    if (calls.length === 2) return { status: 200, json: { ok: true, override: null, revision: 5 } };
    return { status: 200, json: { ok: true, override: { key: `uuid:claude:${UUID}`, title: call.body.title, revision: 6, updatedAt: "t" }, revision: 6 } };
  };
  // An override is in effect so Reset renders; server is at revision 4 locally.
  const view = mount(entry({ title: "Custom", autoTitle: "Auto derived", titleRevision: 4 }));
  flushSync(() => (view.host.querySelector('button[aria-label^="Rename"]') as HTMLButtonElement).click());
  flushSync(() => (view.host.querySelector('button[aria-label="Reset to auto title"]') as HTMLButtonElement).click());
  await settle();
  await settle();
  expect(calls).toHaveLength(2);
  expect(calls[1]!.body.baseRevision).toBe(5);

  // A subsequent rename bases on the tombstone revision (5), proving the
  // optimistic state recorded the real revision rather than a phantom 6.
  flushSync(() => (view.host.querySelector('button[aria-label^="Rename"]') as HTMLButtonElement).click());
  const input = view.host.querySelector('input[aria-label="Session title"]') as HTMLInputElement;
  flushSync(() => typeInto(input, "next"));
  flushSync(() => dispatch(input, new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  await settle();
  expect(calls).toHaveLength(3);
  expect(calls[2]!.body.baseRevision).toBe(5);
});

test("returns focus to the launcher after Escape closes the editor", async () => {
  const view = mount(entry());
  const pencil = view.host.querySelector('button[aria-label^="Rename"]') as HTMLButtonElement;
  flushSync(() => pencil.click());
  const input = view.host.querySelector('input[aria-label="Session title"]') as HTMLInputElement;
  expect(input).toBeTruthy();

  flushSync(() => dispatch(input, new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await settle();
  // Keyboard users keep their place: focus lands back on the rename launcher.
  expect(view.host.querySelector('input[aria-label="Session title"]')).toBeNull();
  expect(document.activeElement).toBe(view.host.querySelector('button[aria-label^="Rename"]'));
});

test("returns focus to the launcher after a keyboard save (never onto a disabled control)", () => {
  const view = mount(entry());
  flushSync(() => (view.host.querySelector('button[aria-label^="Rename"]') as HTMLButtonElement).click());
  const input = view.host.querySelector('input[aria-label="Session title"]') as HTMLInputElement;
  flushSync(() => typeInto(input, "renamed by keyboard"));
  // Enter closes the editor and starts the save; focus restores on close, and
  // the launcher is never disabled, so focus lands on it — not on <body>.
  flushSync(() => dispatch(input, new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));

  const launcher = view.host.querySelector('button[aria-label^="Rename"]') as HTMLButtonElement;
  expect(calls).toHaveLength(1);
  expect(launcher.disabled).toBe(false);
  expect(document.activeElement).toBe(launcher);
});

test("Tab to Reset stays open (internal focus), then Reset clears via keyboard activation", async () => {
  // An override is in effect so the Reset control renders.
  const view = mount(entry({ title: "Custom name", autoTitle: "Fix the login bug", titleRevision: 2 }));
  flushSync(() => (view.host.querySelector('button[aria-label^="Rename"]') as HTMLButtonElement).click());
  const input = view.host.querySelector('input[aria-label="Session title"]') as HTMLInputElement;
  const reset = view.host.querySelector('button[aria-label="Reset to auto title"]') as HTMLButtonElement;
  expect(reset).toBeTruthy();

  // Tab from the input to Reset: focus stays inside the editor, so it must not
  // save/close — otherwise Reset would be unmounted before it can be reached.
  flushSync(() => dispatch(input, new dom.FocusEvent("focusout", { bubbles: true, relatedTarget: reset } as never)));
  expect(view.host.querySelector('input[aria-label="Session title"]')).toBeTruthy();
  expect(calls).toHaveLength(0);

  // Reset is now keyboard-reachable; activating it clears the override.
  flushSync(() => reset.click());
  await settle();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body.title).toBeNull();
});

test("a bumped autoEditToken opens the editor (scheme-board F2 targeting)", async () => {
  const view = mount(entry());
  expect(view.host.querySelector('input[aria-label="Session title"]')).toBeNull();
  view.rerender(entry(), 1);
  await settle();
  expect(view.host.querySelector('input[aria-label="Session title"]')).toBeTruthy();
});

test("mounting with an autoEditToken already set opens the editor (just-expanded overlay)", async () => {
  // The scheme board expands the node with the token already set; the overlay's
  // SessionTitle must open on mount (passive effect runs just after mount).
  const view = mount(entry(), 7);
  await settle();
  expect(view.host.querySelector('input[aria-label="Session title"]')).toBeTruthy();
});

test("an instance with no autoEditToken never auto-opens (the node's board pane stays closed)", () => {
  // The still-mounted board pane gets no token, so an F2 targeting the overlay
  // must not open it (its blur would otherwise persist an unintended rename).
  const view = mount(entry());
  view.rerender(entry());
  expect(view.host.querySelector('input[aria-label="Session title"]')).toBeNull();
});

const sessionA = () => entry({ path: "/home/u/.claude/projects/proj/aaaaaaaa-2222-4333-8444-555555555555.jsonl", conversationId: "conversation_A", title: "Session A" });
const sessionB = () => entry({ path: "/home/u/.claude/projects/proj/bbbbbbbb-2222-4333-8444-555555555555.jsonl", conversationId: "conversation_B", title: "Session B" });

test("switching sessions before a save settles resets the editor and shows the new session", () => {
  const view = mount(sessionA());
  // Open A's editor and type an unsaved draft.
  flushSync(() => (view.host.querySelector('button[aria-label^="Rename"]') as HTMLButtonElement).click());
  const input = view.host.querySelector('input[aria-label="Session title"]') as HTMLInputElement;
  flushSync(() => typeInto(input, "A draft not saved"));

  // The pane is reused for session B (scheme board expands a different node).
  view.rerender(sessionB());

  // No leftover editor, and B shows its own title — A's draft cannot be blurred
  // into a rename of B.
  expect(view.host.querySelector('input[aria-label="Session title"]')).toBeNull();
  expect(view.host.querySelector('span[role="button"]')!.textContent).toContain("Session B");
  expect(view.host.textContent).not.toContain("A draft not saved");
});

test("conversation-id enrichment on the same path keeps the editor open (no reset)", () => {
  // Initially no conversationId; identity is the path.
  const bare = entry({ path: "/home/u/.claude/projects/proj/enrich.jsonl", title: "Session" });
  const view = mount(bare);
  flushSync(() => (view.host.querySelector('button[aria-label^="Rename"]') as HTMLButtonElement).click());
  expect(view.host.querySelector('input[aria-label="Session title"]')).toBeTruthy();

  // A later poll fills in conversationId for the same path — enrichment, not a
  // switch: the open editor (an in-progress draft) must survive, and nothing is
  // saved.
  view.rerender(entry({ path: "/home/u/.claude/projects/proj/enrich.jsonl", conversationId: "conversation_E", title: "Session" }));
  expect(view.host.querySelector('input[aria-label="Session title"]')).toBeTruthy();
  expect(calls).toHaveLength(0);
});

test("succession (new path, same conversation id) keeps the editor open (no reset)", () => {
  const gen1 = entry({ path: "/home/u/.claude/projects/proj/gen1.jsonl", conversationId: "conversation_X", title: "S" });
  const gen2 = entry({ path: "/home/u/.claude/projects/proj/gen2.jsonl", conversationId: "conversation_X", title: "S" });
  const view = mount(gen1);
  flushSync(() => (view.host.querySelector('button[aria-label^="Rename"]') as HTMLButtonElement).click());
  expect(view.host.querySelector('input[aria-label="Session title"]')).toBeTruthy();

  view.rerender(gen2);
  expect(view.host.querySelector('input[aria-label="Session title"]')).toBeTruthy();
  expect(calls).toHaveLength(0);
});

test("an optimistic rename does not leak onto a different reused session", async () => {
  const view = mount(sessionA());
  flushSync(() => (view.host.querySelector('button[aria-label^="Rename"]') as HTMLButtonElement).click());
  const input = view.host.querySelector('input[aria-label="Session title"]') as HTMLInputElement;
  flushSync(() => typeInto(input, "A renamed"));
  flushSync(() => dispatch(input, new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  await settle();
  // A shows its optimistic title.
  expect(view.host.querySelector('span[role="button"]')!.textContent).toContain("A renamed");

  // Reuse for B before A's rename settles via polling.
  view.rerender(sessionB());
  const title = view.host.querySelector('span[role="button"]')!;
  expect(title.textContent).toContain("Session B");
  expect(title.textContent).not.toContain("A renamed");
});

test("a failed save after a session switch never arms the reused session's retry", async () => {
  (globalThis as { fetch?: unknown }).fetch = async () => { throw new Error("network down"); };
  const view = mount(sessionA());
  flushSync(() => (view.host.querySelector('button[aria-label^="Rename"]') as HTMLButtonElement).click());
  const input = view.host.querySelector('input[aria-label="Session title"]') as HTMLInputElement;
  flushSync(() => typeInto(input, "A rename"));
  flushSync(() => dispatch(input, new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));

  // Switch to B before A's (failing) save resolves.
  view.rerender(sessionB());
  await settle();

  // A's failure must not arm B with a retry button carrying A's value.
  expect(view.host.textContent).not.toContain("Retry");
  expect(view.host.querySelector('span[role="button"]')!.textContent).toContain("Session B");
});

test("the mobile variant renders an always-visible 44px launcher", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<SessionTitle file={entry()} alwaysVisible />));
  mounted.push(() => { flushSync(() => root.unmount()); host.remove(); });
  const pencil = host.querySelector('button[aria-label^="Rename"]') as HTMLButtonElement;
  expect(pencil.className).toContain("h-11");
  expect(pencil.className).toContain("w-11");
});
