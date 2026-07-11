import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { ClaudeLoginView, EngineAccountsState } from "@/hooks/useEngineAccounts";

import { AccountsPanel } from "./AccountsPanel";

const dom = new Window();
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
});

const login = (over: Partial<ClaudeLoginView> = {}): ClaudeLoginView => ({
  operationId: "op-dom", phase: "awaiting_code", loginUrl: "https://claude.ai/login", acceptsCode: true,
  deadlineAt: "2026-07-10T12:00:00.000Z", result: null, ...over,
});

function state(currentLogin: ClaudeLoginView, over: Partial<EngineAccountsState> = {}): EngineAccountsState {
  return {
    engine: "claude",
    accounts: [{ id: "acc", label: "Acc", kind: "managed", authPresent: false, loginPending: true, loginState: "pending", deviceAuth: null, login: currentLogin }],
    active: "acc",
    identityVersion: 0,
    status: "ready",
    notice: null,
    challenge: null,
    mutation: null,
    migration: null,
    autoBalance: null,
    refresh: async () => true,
    add: async () => true,
    retryNotice: async () => true,
    select: async () => true,
    submitLoginCode: async () => true,
    cancelLogin: async () => true,
    retryLogin: async () => true,
    remove: async () => true,
    cleanupOrphans: async () => true,
    ...over,
  };
}

async function mount(initial: EngineAccountsState): Promise<{ host: HTMLDivElement; rerender(next: EngineAccountsState): Promise<void>; unmount(): Promise<void> }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  const render = async (next: EngineAccountsState) => {
    flushSync(() => { root.render(<AccountsPanel state={next} onClose={() => {}} />); });
    await Promise.resolve();
  };
  await render(initial);
  return {
    host,
    rerender: render,
    unmount: async () => {
      flushSync(() => { root.unmount(); });
      host.remove();
    },
  };
}

const mounted: Array<{ unmount(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(mounted.splice(0).map((item) => item.unmount()));
  document.body.replaceChildren();
});

function dispatch(target: EventTarget, event: unknown): boolean {
  return target.dispatchEvent(event as Event);
}

test("keyboard Submit code restores focus to the Claude sign-in row after it enters verifying", async () => {
  let submitted: { operationId: string; code: string } | null = null;
  const initial = state(login(), {
    submitLoginCode: async (operationId, code) => {
      submitted = { operationId, code };
      return true;
    },
  });
  const view = await mount(initial);
  mounted.push(view);
  const input = view.host.querySelector('input[aria-label="Authorization code"]') as HTMLInputElement;
  const form = input.form!;

  flushSync(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, "browser-code");
    dispatch(input, new dom.Event("input", { bubbles: true }));
    dispatch(input, new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    dispatch(form, new dom.Event("submit", { bubbles: true, cancelable: true }));
  });
  await Promise.resolve();
  expect(submitted).not.toBeNull();
  expect(submitted as unknown as { operationId: string; code: string }).toEqual({ operationId: "op-dom", code: "browser-code" });

  await view.rerender(state(login({ phase: "verifying", loginUrl: null, acceptsCode: false }), { submitLoginCode: initial.submitLoginCode }));
  expect(document.activeElement).toBe(view.host.querySelector('[role="group"]'));
});

test("removing a managed account arms on the first click and only removes on an explicit confirm", async () => {
  let removed: string | null = null;
  const initial = state(login({ phase: "authenticated" }), {
    accounts: [{ id: "acc", label: "Acc", kind: "managed", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null, login: null }],
    remove: async (id) => { removed = id; return true; },
  });
  const view = await mount(initial);
  mounted.push(view);
  const remove = [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Remove")!;

  flushSync(() => { remove.click(); });
  expect(removed).toBeNull();
  expect(view.host.textContent).toContain("Remove this account?");

  const confirm = [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Confirm")!;
  flushSync(() => { confirm.click(); });
  expect(removed as unknown as string).toBe("acc");
});

test("canceling an armed removal backs out without removing the account", async () => {
  let removed: string | null = null;
  const initial = state(login({ phase: "authenticated" }), {
    accounts: [{ id: "acc", label: "Acc", kind: "managed", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null, login: null }],
    remove: async (id) => { removed = id; return true; },
  });
  const view = await mount(initial);
  mounted.push(view);
  const remove = [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Remove")!;
  flushSync(() => { remove.click(); });

  const cancel = [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!;
  flushSync(() => { cancel.click(); });

  expect(removed).toBeNull();
  expect(view.host.textContent).not.toContain("Remove this account?");
  expect([...view.host.querySelectorAll("button")].some((button) => button.textContent === "Remove")).toBe(true);
});

test("signed-out and pending account rows cannot be selected", async () => {
  const initial = state(login(), {
    accounts: [
      { id: "signed-out", label: "Signed out", kind: "managed", authPresent: false, loginPending: false, loginState: "idle", deviceAuth: null, login: null },
      { id: "pending", label: "Pending", kind: "managed", authPresent: false, loginPending: true, loginState: "pending", deviceAuth: null, login: login() },
    ],
    active: "",
  });
  const view = await mount(initial);
  mounted.push(view);
  const signedOut = [...view.host.querySelectorAll("button")].find((button) => button.textContent?.includes("Signed out"))!;
  const pending = [...view.host.querySelectorAll("button")].find((button) => button.textContent?.includes("Pending"))!;

  expect(signedOut.disabled).toBeTrue();
  expect(pending.disabled).toBeTrue();
});

test("an account row directly selects the account", async () => {
  let selected: string | null = null;
  const initial = state(login({ phase: "authenticated" }), {
    accounts: [
      { id: "main", label: "Main", kind: "legacy", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null, login: null },
      { id: "work", label: "Work", kind: "managed", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null, login: null },
    ],
    active: "main",
    select: async (id) => { selected = id; return true; },
  });
  const view = await mount(initial);
  mounted.push(view);
  const work = [...view.host.querySelectorAll("button")].find((button) => button.textContent?.includes("Work"))!;

  flushSync(() => { work.click(); });
  await Promise.resolve();
  expect(selected as unknown as string).toBe("work");
  expect(view.host.textContent).not.toContain("Migrate all");
});

test("a switch mutation renders a clear live operation status", async () => {
  const initial = state(login({ phase: "authenticated" }), {
    mutation: "switch",
  });
  const view = await mount(initial);
  mounted.push(view);
  expect(view.host.querySelector('[role="dialog"]')?.getAttribute("aria-busy")).toBe("true");
  expect(view.host.textContent).toContain("Switching the account for future launches…");
});

test("keyboard Cancel restores focus to the Claude sign-in row after it enters canceling", async () => {
  let canceled: string | null = null;
  const initial = state(login(), {
    cancelLogin: async (operationId) => {
      canceled = operationId;
      return true;
    },
  });
  const view = await mount(initial);
  mounted.push(view);
  const cancel = [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!;

  flushSync(() => {
    cancel.focus();
    dispatch(cancel, new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    cancel.click();
  });
  await Promise.resolve();
  expect(canceled).not.toBeNull();
  expect(canceled as unknown as string).toBe("op-dom");

  await view.rerender(state(login({ phase: "canceling", loginUrl: null, acceptsCode: false }), { cancelLogin: initial.cancelLogin }));
  expect(document.activeElement).toBe(view.host.querySelector('[role="group"]'));
});
