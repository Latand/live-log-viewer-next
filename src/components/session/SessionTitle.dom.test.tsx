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
    return {
      status: 200,
      json: { ok: true, override: title === null ? null : { key: `uuid:claude:${UUID}`, title, revision: 1, updatedAt: "t" } },
    };
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

function mount(file: FileEntry): { host: HTMLElement; rerender(next: FileEntry): void } {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  const rerender = (next: FileEntry) => flushSync(() => root.render(<SessionTitle file={next} />));
  rerender(file);
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
  expect(calls[0]!.body).toMatchObject({ path: entry().path, title: "Login flow rework", pid: 4242 });

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
    return { status: 200, json: { ok: true, override: { key: `uuid:claude:${UUID}`, title: call.body.title, revision: 6, updatedAt: "t" } } };
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
