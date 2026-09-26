import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { AccountRemovalRefusal, AccountRemovalSummary, ClaudeLoginView, EngineAccountsState } from "@/hooks/useEngineAccounts";

import { AccountsPanel } from "./AccountsPanel";
import { formatQuotaAsOf, formatResetEta } from "./rateLimit";

/** An archive under an invented home, composed so the `~` fold is exercised
    without a home path written out in a published source. */
const archiveUnderHome = (id: string) => ["", "home", "someone", ".config", "agent-log-viewer", "shared", "claude", "retired", id].join("/");
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
    copyTerminalCommand: async () => true,
    refreshLimits: async () => true,
    useResetCredit: async () => true,
    limitsBusy: null,
    limitsVersion: 0,
    removing: null,
    removal: null,
    dismissRemoval: () => {},
    ...over,
  };
}

async function mount(initial: EngineAccountsState, placement: "footer" | "header" = "footer"): Promise<{ host: HTMLDivElement; rerender(next: EngineAccountsState): Promise<void>; unmount(): Promise<void> }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  const render = async (next: EngineAccountsState) => {
    flushSync(() => { root.render(<AccountsPanel state={next} onClose={() => {}} placement={placement} />); });
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
  setSystemTime();
});

function dispatch(target: EventTarget, event: unknown): boolean {
  return target.dispatchEvent(event as Event);
}

test("provider account controls render on the account row without exposing its token", async () => {
  const view = await mount(state(login(), {
    accounts: [{ id: "provider", label: "Provider", kind: "managed", authPresent: true, authHealth: "authenticated", loginPending: false, loginState: "authenticated", deviceAuth: null, provider: { baseUrl: "https://example.invalid/anthropic", model: "large", smallFastModel: "small" } }],
    active: "provider",
  }));
  mounted.push(view);
  const editor = view.host.querySelector('[data-claude-provider-editor="provider"]') as HTMLElement;
  expect(editor).not.toBeNull();
  expect(view.host.textContent).toContain("Provider limits unknown");
  expect(view.host.textContent).not.toContain("Authorization code");
  flushSync(() => dispatch(editor.querySelector("button")!, new dom.MouseEvent("click", { bubbles: true })));
  expect((editor.querySelector('input[aria-label="Provider token"]') as HTMLInputElement).type).toBe("password");
  expect((editor.querySelector('input[aria-label="Default model ID"]') as HTMLInputElement).value).toBe("large");
  expect(editor.innerHTML).not.toContain("local-provider-fixture-token");
});

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

const managedAcc = { id: "acc", label: "Acc", kind: "managed" as const, authPresent: true, loginPending: false, loginState: "authenticated" as const, deviceAuth: null, login: null };
const buttonNamed = (host: HTMLElement, text: string) => [...host.querySelectorAll("button")].find((button) => button.textContent === text);

test("removing a managed account arms on the first click and only removes on an explicit confirm", async () => {
  let removed: string | null = null;
  const initial = state(login({ phase: "authenticated" }), {
    accounts: [managedAcc],
    remove: async (id) => { removed = id; return true; },
  });
  const view = await mount(initial);
  mounted.push(view);
  flushSync(() => { buttonNamed(view.host, "Remove")!.click(); });
  expect(removed).toBeNull();
  const armed = view.host.querySelector('[data-account-remove-armed="acc"]')!;
  expect(armed.textContent).toContain("Remove Acc? Its files move to the shared archive and past conversations stay readable.");
  // The armed line replaces the action line: the confirm is focused.
  expect(document.activeElement).toBe(buttonNamed(armed as HTMLElement, "Remove")!);

  flushSync(() => { buttonNamed(armed as HTMLElement, "Remove")!.click(); });
  expect(removed as unknown as string).toBe("acc");
});

test("canceling an armed removal backs out without removing the account", async () => {
  let removed: string | null = null;
  const initial = state(login({ phase: "authenticated" }), {
    accounts: [managedAcc],
    remove: async (id) => { removed = id; return true; },
  });
  const view = await mount(initial);
  mounted.push(view);
  flushSync(() => { buttonNamed(view.host, "Remove")!.click(); });
  flushSync(() => { buttonNamed(view.host, "Cancel")!.click(); });

  expect(removed).toBeNull();
  expect(view.host.querySelector("[data-account-remove-armed]")).toBeNull();
  expect(buttonNamed(view.host, "Remove")).toBeDefined();
});

test("Escape disarms an armed removal without closing the panel, and the arm times out after ten seconds", async () => {
  let closed = 0;
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  const initial = state(login({ phase: "authenticated" }), { accounts: [managedAcc] });
  flushSync(() => { root.render(<AccountsPanel state={initial} onClose={() => { closed += 1; }} />); });
  mounted.push({ unmount: async () => { flushSync(() => { root.unmount(); }); host.remove(); } });

  flushSync(() => { buttonNamed(host, "Remove")!.click(); });
  const confirm = buttonNamed(host.querySelector("[data-account-remove-armed]") as HTMLElement, "Remove")!;
  flushSync(() => { dispatch(confirm, new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(host.querySelector("[data-account-remove-armed]")).toBeNull();
  expect(closed).toBe(0);

  const timers: Array<() => void> = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void, ms?: number) => {
    if (ms === 10_000) { timers.push(callback); return 0 as unknown as ReturnType<typeof setTimeout>; }
    return realSetTimeout(callback, ms);
  }) as typeof setTimeout;
  try {
    flushSync(() => { buttonNamed(host, "Remove")!.click(); });
    expect(host.querySelector("[data-account-remove-armed]")).not.toBeNull();
    expect(timers).toHaveLength(1);
    flushSync(() => { timers[0]!(); });
    expect(host.querySelector("[data-account-remove-armed]")).toBeNull();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test("a removal in flight dims its row and says Removing…", async () => {
  const view = await mount(state(login({ phase: "authenticated" }), { accounts: [managedAcc], mutation: "remove", removing: "acc" }));
  mounted.push(view);
  const row = view.host.querySelector('[data-account-row="acc"]')!;
  expect(row.getAttribute("aria-busy")).toBe("true");
  expect(row.className).toContain("opacity-60");
  expect(row.textContent).toContain("Removing…");
  expect(buttonNamed(view.host, "Remove")).toBeUndefined();
});

const REFUSALS: Array<[AccountRemovalRefusal, string]> = [
  [{ accountId: "acc", label: "Acc", reasons: ["live_sessions"] }, "An agent is still running on Acc."],
  [{ accountId: "acc", label: "Acc", reasons: ["login_pending"] }, "A sign-in for Acc is still open."],
  [{ accountId: "acc", label: "Acc", reasons: ["queued_pin"] }, "A queued launch is pinned to Acc"],
  [{ accountId: "acc", label: "Acc", reasons: ["current_conversations"] }, "A conversation on Acc is still in flight"],
  [{ accountId: "acc", label: "Acc", reasons: ["unsafe_home"] }, "The folder of Acc failed a safety check"],
  [{ accountId: "acc", label: "Acc", reasons: ["archive_unavailable"], archive: archiveUnderHome("acc") }, "Move it away, then remove the account."],
  [{ accountId: "acc", label: "Acc", reasons: ["accounts_locked"] }, "The accounts registry needs repair"],
  [{ accountId: "acc", label: "Acc", reasons: ["unknown_account"] }, "Acc is no longer in the list."],
  [{ accountId: "acc", label: "Acc", reasons: ["removal_failed"], errno: "EACCES" }, "Removing Acc failed at a file step (EACCES)."],
  [{ accountId: "acc", label: "Acc", reasons: ["no_answer"] }, "Delegatus did not answer."],
];

test("each refusal renders its own message inside the refused row, unclamped", async () => {
  for (const [refusal, text] of REFUSALS) {
    const other = { ...managedAcc, id: "other", label: "Other" };
    const view = await mount(state(login({ phase: "authenticated" }), { accounts: [managedAcc, other], removal: { kind: "refused", refusal } }));
    const block = view.host.querySelector('[data-account-row="acc"] [data-account-refusal="acc"]');
    expect(block?.textContent, refusal.reasons[0]).toContain(text);
    expect(view.host.querySelector('[data-account-row="other"] [data-account-refusal]')).toBeNull();
    expect(block!.innerHTML).not.toContain("line-clamp");
    await view.unmount();
  }
});

test("a refusal names the archive path with its account id kept, and its actions reach the store", async () => {
  let dismissed = 0;
  let retried: string | null = null;
  let refreshed = 0;
  const archive = archiveUnderHome("acc");
  const view = await mount(state(login({ phase: "authenticated" }), {
    accounts: [managedAcc],
    removal: { kind: "refused", refusal: { accountId: "acc", label: "Acc", reasons: ["archive_unavailable"], archive } },
    dismissRemoval: () => { dismissed += 1; },
  }));
  mounted.push(view);
  expect(view.host.querySelector("[data-archive-path-id]")?.textContent).toBe("acc");
  expect(view.host.querySelector(`[data-archive-path="${archive}"]`)?.textContent).toContain("~/.config/");
  flushSync(() => { (view.host.querySelector('button[aria-label="Close this message"]') as HTMLButtonElement).click(); });
  expect(dismissed).toBeGreaterThanOrEqual(1);

  await view.rerender(state(login({ phase: "authenticated" }), {
    accounts: [managedAcc],
    removal: { kind: "refused", refusal: { accountId: "acc", label: "Acc", reasons: ["removal_failed"] } },
    remove: async (id) => { retried = id; return true; },
  }));
  expect(view.host.textContent).toContain("Removing Acc failed. The account was put back as it was.");
  flushSync(() => { buttonNamed(view.host.querySelector("[data-account-refusal]") as HTMLElement, "Try again")!.click(); });
  expect(retried as unknown as string).toBe("acc");

  await view.rerender(state(login({ phase: "authenticated" }), {
    accounts: [managedAcc],
    removal: { kind: "refused", refusal: { accountId: "acc", label: "Acc", reasons: ["no_answer"] } },
    refresh: async () => { refreshed += 1; return true; },
  }));
  flushSync(() => { buttonNamed(view.host.querySelector("[data-account-refusal]") as HTMLElement, "Refresh")!.click(); });
  expect(refreshed).toBe(1);
});

test("each new refusal scrolls its whole block into view inside the list", async () => {
  const proto = dom.HTMLElement.prototype as unknown as { scrollIntoView?: (options?: ScrollIntoViewOptions) => void };
  const original = proto.scrollIntoView;
  const calls: Array<{ refusal: string | null; options?: ScrollIntoViewOptions }> = [];
  proto.scrollIntoView = function (this: HTMLElement, options?: ScrollIntoViewOptions) {
    calls.push({ refusal: this.getAttribute("data-account-refusal"), options });
  };
  try {
    const other = { ...managedAcc, id: "other", label: "Other" };
    const refused = (reasons: AccountRemovalRefusal["reasons"]) => state(login({ phase: "authenticated" }), {
      accounts: [managedAcc, other],
      removal: { kind: "refused", refusal: { accountId: "other", label: "Other", reasons } },
    });
    const view = await mount(refused(["live_sessions"]));
    mounted.push(view);
    expect(calls).toEqual([{ refusal: "other", options: { block: "nearest", inline: "nearest" } }]);
    await view.rerender(refused(["removal_failed"]));
    expect(calls.map((call) => call.refusal)).toEqual(["other", "other"]);
  } finally {
    proto.scrollIntoView = original;
  }
});

test("a refusal whose row left the list shows in the footer slot", async () => {
  const view = await mount(state(login({ phase: "authenticated" }), {
    accounts: [],
    removal: { kind: "refused", refusal: { accountId: "gone", label: "Gone", reasons: ["unknown_account"] } },
  }));
  mounted.push(view);
  expect(view.host.querySelector('[data-account-refusal="gone"]')?.textContent).toContain("Gone is no longer in the list.");
});

const SUMMARY: AccountRemovalSummary = {
  accountId: "acc", label: "Account B",
  archive: archiveUnderHome("claude-b"),
  files: 1284, bytes: 2_100_000_000, conversations: 37, pins: 2, deliveries: 1, migrations: 1,
  credential: "clean",
};

test("the summary renders after the row is gone, with every counted line, and no Force remove anywhere", async () => {
  const view = await mount(state(login({ phase: "authenticated" }), { accounts: [], removal: { kind: "removed", summary: SUMMARY } }));
  mounted.push(view);
  const card = view.host.querySelector('[data-account-removal-card="removed"]')!;
  const text = card.textContent!;
  expect(text).toContain("Account B removed");
  expect(text).toContain("Past conversations stay readable.");
  expect(text).toContain("1,284 files · 2.1 GB");
  expect(card.querySelector("[data-archive-path-id]")?.textContent).toBe("claude-b");
  expect(text).toContain("37 now read from the archive");
  expect(text).toContain("Pins cleared2");
  expect(text).toContain("1 undelivered message dropped");
  expect(text).toContain("1 settled");
  expect(view.host.textContent).not.toContain("Force remove");
  expect(view.host.textContent).toContain("Clean up leftovers");
});

test("a clean removal is three quiet lines; a sign-in file left behind adds the clean-up line", async () => {
  let cleaned = 0;
  const clean = { ...SUMMARY, conversations: 0, pins: 0, deliveries: 0, migrations: 0, files: 3, bytes: 812_000 };
  const view = await mount(state(login({ phase: "authenticated" }), { accounts: [], removal: { kind: "removed", summary: clean } }));
  mounted.push(view);
  const card = () => view.host.querySelector('[data-account-removal-card="removed"]')!;
  expect(card().querySelectorAll("dt")).toHaveLength(2);
  expect(card().textContent).toContain("3 files · 812 KB");
  expect(card().querySelector("[data-account-removal-credential]")).toBeNull();

  await view.rerender(state(login({ phase: "authenticated" }), {
    accounts: [],
    removal: { kind: "removed", summary: { ...clean, credential: "pending" } },
    cleanupOrphans: async () => { cleaned += 1; return true; },
  }));
  expect(card().querySelector('[data-account-removal-credential="pending"]')?.textContent).toContain("The sign-in file could not be deleted from the archive.");
  flushSync(() => { buttonNamed(view.host, "Finish clean-up")!.click(); });
  expect(cleaned).toBe(1);

  await view.rerender(state(login({ phase: "authenticated" }), { accounts: [], removal: { kind: "removed", summary: { ...clean, credential: "deleted" } } }));
  expect(card().querySelector('[data-account-removal-credential="deleted"]')?.textContent).toBe("Sign-in file deleted.");
});

test("the clean-up result lists what it deleted, archived and left, at most five names", async () => {
  const unresolved = ["a.lock", "b", "c", "d", "e", "f", "g"];
  const view = await mount(state(login({ phase: "authenticated" }), {
    removal: { kind: "cleanup", report: { removed: ["x", "y", "z"], archived: [{ id: "old", files: 412, bytes: 96_000_000 }, { id: "older", files: 0, bytes: 0 }], unresolved } },
  }));
  mounted.push(view);
  const text = view.host.querySelector('[data-account-removal-card="cleanup"]')!.textContent!;
  expect(text).toContain("Some leftovers need a look");
  expect(text).toContain("3 empty folders");
  expect(text).toContain("2 retired accounts · 412 files · 96.0 MB");
  expect(text).toContain("a.lock");
  expect(text).toContain("e");
  expect(text).not.toContain("f+");
  expect(text).toContain("+2 more");

  await view.rerender(state(login({ phase: "authenticated" }), { removal: { kind: "cleanup", report: { removed: [], archived: [], unresolved: [] } } }));
  expect(view.host.textContent).toContain("Nothing to clean up");
});

test("closing the panel closes the removal answer", async () => {
  let dismissed = 0;
  const view = await mount(state(login({ phase: "authenticated" }), { removal: { kind: "removed", summary: SUMMARY }, dismissRemoval: () => { dismissed += 1; } }));
  await view.unmount();
  expect(dismissed).toBe(1);
});

test("clicking Retry on an erroring legacy Main starts an in-place login recovery (issue #470)", async () => {
  let retried: string | null = null;
  const initial = state(login(), {
    accounts: [{ id: "default", label: "Main", kind: "legacy", authPresent: true, authHealth: "error", loginPending: false, loginState: "authenticated", deviceAuth: null, login: null }],
    active: "default",
    retryLogin: async (id) => { retried = id; return true; },
  });
  const view = await mount(initial);
  mounted.push(view);
  const retry = [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Retry")!;

  flushSync(() => { retry.click(); });
  await Promise.resolve();
  expect(retried as unknown as string).toBe("default");
});

test("clicking Sign in on a signed-out legacy Main starts an in-place login recovery (issue #470)", async () => {
  let retried: string | null = null;
  const initial = state(login(), {
    accounts: [{ id: "default", label: "Main", kind: "legacy", authPresent: false, authHealth: "signed_out", loginPending: false, loginState: "idle", deviceAuth: null, login: null }],
    active: "",
    retryLogin: async (id) => { retried = id; return true; },
  });
  const view = await mount(initial);
  mounted.push(view);
  const signIn = [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Sign in")!;

  flushSync(() => { signIn.click(); });
  await Promise.resolve();
  expect(retried as unknown as string).toBe("default");
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

test("each authenticated account row exposes a one-click tmux agent launch", async () => {
  let opened: string | null = null;
  const initial = state(login({ phase: "authenticated" }), {
    accounts: [{ id: "acc", label: "Acc", kind: "managed", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null, login: null }],
    copyTerminalCommand: async (id) => { opened = id; return true; },
  });
  const view = await mount(initial);
  mounted.push(view);
  const launch = view.host.querySelector<HTMLButtonElement>('button[aria-label="Copy the agent command for Acc"]')!;
  expect(launch).not.toBeNull();
  expect(launch.disabled).toBe(false);

  flushSync(() => { launch.click(); });
  await Promise.resolve();
  expect(opened as unknown as string).toBe("acc");
});

test("the tmux launch stands down for signed-out and pending accounts", async () => {
  const initial = state(login(), {
    accounts: [
      { id: "out", label: "Out", kind: "managed", authPresent: false, authHealth: "signed_out", loginPending: false, loginState: "idle", deviceAuth: null, login: null },
      { id: "pending", label: "Pending", kind: "managed", authPresent: true, loginPending: true, loginState: "pending", deviceAuth: null, login: null },
    ],
  });
  const view = await mount(initial);
  mounted.push(view);
  const out = view.host.querySelector<HTMLButtonElement>('button[aria-label="Copy the agent command for Out"]')!;
  const pending = view.host.querySelector<HTMLButtonElement>('button[aria-label="Copy the agent command for Pending"]')!;
  expect(out.disabled).toBe(true);
  expect(pending.disabled).toBe(true);
});

test("a switch-failure notice shows the server's real error text beside Retry", async () => {
  const initial = state(login({ phase: "authenticated" }), {
    accounts: [{ id: "acc", label: "Acc", kind: "managed", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null, login: null }],
    notice: { kind: "error", operation: "switch", messageKey: "accounts.switchFailed", detail: "RegistryParityError: snapshots differ", action: { type: "retry", kind: "switch", accountId: "acc" } },
  });
  const view = await mount(initial);
  mounted.push(view);
  expect(view.host.textContent).toContain("Could not switch account — RegistryParityError: snapshots differ");
  expect([...view.host.querySelectorAll("button")].some((button) => button.textContent === "Retry")).toBe(true);
});

test("quota windows render as labeled meters with remaining capacity", async () => {
  const initial = state(login({ phase: "authenticated" }), {
    accounts: [{
      id: "acc", label: "Acc", kind: "managed", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null, login: null,
      limits: { freshness: "fresh", session: { usedPercent: 33, resetsAt: null, windowMinutes: 300 }, weekly: { usedPercent: 80, resetsAt: null, windowMinutes: 10_080 } },
    }],
  });
  const view = await mount(initial);
  mounted.push(view);
  const detail = view.host.querySelector('[aria-label="Quota windows for Acc"]')!;
  expect(detail.textContent).toContain("5h");
  expect(detail.textContent).toContain("Week");
  expect(detail.textContent).toContain("67%");
  expect(detail.textContent).toContain("20%");
  const activeRow = view.host.querySelector('button[aria-current="true"]')!;
  expect(activeRow.textContent).toContain("20%");
  expect(activeRow.textContent).not.toContain("54%");
});

test("an aged account quota snapshot renders a visible as-of hint", async () => {
  const initial = state(login({ phase: "authenticated" }), {
    accounts: [{
      id: "acc", label: "Acc", kind: "managed", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null, login: null,
      limits: {
        freshness: "fresh",
        session: null,
        weekly: { usedPercent: 80, resetsAt: null, windowMinutes: 10_080 },
        checkedAt: "2020-01-01T09:00:00.000Z",
      },
    }],
  });
  const view = await mount(initial);
  mounted.push(view);

  expect(view.host.querySelector('[aria-label="Quota windows for Acc"]')?.textContent).toContain("as of");
});

test("a header-opened panel ages quota hints and reset ETAs while it remains mounted", async () => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let tick: (() => void) | null = null;
  let view: Awaited<ReturnType<typeof mount>> | null = null;
  // @ts-expect-error deterministic interval test double
  globalThis.setInterval = (fn: () => void) => {
    tick = fn;
    return 1;
  };
  globalThis.clearInterval = () => {};
  try {
    const now = Date.parse("2026-08-15T09:00:00.000Z") / 1000;
    const observedAt = now - 19 * 60;
    const resetsAt = now + 5_401;
    setSystemTime(new Date(now * 1000));
    view = await mount(state(login({ phase: "authenticated" }), {
      accounts: [{
        id: "acc", label: "Acc", kind: "managed", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null, login: null,
        limits: {
          freshness: "fresh",
          session: null,
          weekly: { usedPercent: 80, resetsAt, windowMinutes: 10_080, observedAt },
          checkedAt: new Date(observedAt * 1000).toISOString(),
        },
      }],
    }), "header");
    const detail = () => view!.host.querySelector('[aria-label="Quota windows for Acc"]')!;

    expect(detail().textContent).not.toContain("as of");
    expect(detail().textContent).toContain(formatResetEta(resetsAt, now));

    setSystemTime(new Date((now + 2 * 60) * 1000));
    flushSync(() => tick!());

    expect(detail().textContent).toContain(formatQuotaAsOf(observedAt)!);
    expect(detail().textContent).toContain(formatResetEta(resetsAt, now + 2 * 60));
  } finally {
    await view?.unmount();
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});

test("distinct stale quota windows retain their own as-of hints", async () => {
  const sessionObservedAt = Date.parse("2020-01-01T09:00:00.000Z") / 1000;
  const weeklyObservedAt = Date.parse("2020-01-01T09:10:00.000Z") / 1000;
  const initial = state(login({ phase: "authenticated" }), {
    accounts: [{
      id: "acc", label: "Acc", kind: "managed", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null, login: null,
      limits: {
        freshness: "fresh",
        session: { usedPercent: 33, resetsAt: null, windowMinutes: 300, observedAt: sessionObservedAt },
        weekly: { usedPercent: 80, resetsAt: null, windowMinutes: 10_080, observedAt: weeklyObservedAt },
        checkedAt: "2020-01-01T09:20:00.000Z",
      },
    }],
  });
  const view = await mount(initial);
  mounted.push(view);
  const detail = view.host.querySelector('[aria-label="Quota windows for Acc"]')!;

  expect(detail.textContent).toContain(formatQuotaAsOf(sessionObservedAt)!);
  expect(detail.textContent).toContain(formatQuotaAsOf(weeklyObservedAt)!);
  expect(detail.textContent?.match(/as of/g)).toHaveLength(2);
});

test("stale quota windows without timestamps retain a visible last-known label", async () => {
  const initial = state(login({ phase: "authenticated" }), {
    accounts: [{
      id: "acc", label: "Acc", kind: "managed", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null, login: null,
      limits: {
        freshness: "stale",
        session: { usedPercent: 33, resetsAt: null, windowMinutes: 300 },
        weekly: { usedPercent: 80, resetsAt: null, windowMinutes: 10_080 },
        checkedAt: null,
      },
    }],
  });
  const view = await mount(initial);
  mounted.push(view);

  expect(view.host.querySelector('[aria-label="Quota windows for Acc"]')?.textContent).toContain("Last known values");
});

// ── Issues #1418 / #1373 — the two card actions fire on click, no confirm ─────

const codexCard = (over: Record<string, unknown> = {}) => ({
  id: "account-a", label: "Account A", kind: "managed" as const, authPresent: true, authHealth: "authenticated" as const, plan: "pro",
  loginPending: false, loginState: "authenticated" as const, deviceAuth: null, login: null,
  limits: { freshness: "fresh" as const, session: null, weekly: { usedPercent: 100, resetsAt: Math.floor(Date.now() / 1000) + 5 * 86_400, windowMinutes: 10_080 }, checkedAt: new Date(Date.now() - 60_000).toISOString() },
  resetCredits: { availableCount: 1, expiresAt: null },
  ...over,
});

test("Refresh re-reads that account's limits on click, with no confirmation step (#1418)", async () => {
  const refreshed: string[] = [];
  const view = await mount(state(login({ phase: "authenticated" }), {
    engine: "codex",
    accounts: [codexCard()],
    refreshLimits: async (id) => { refreshed.push(id); return true; },
  }));
  mounted.push(view);
  const refresh = view.host.querySelector<HTMLButtonElement>('button[data-account-refresh-limits="account-a"]')!;
  expect(refresh.disabled).toBeFalse();
  flushSync(() => { refresh.click(); });
  await Promise.resolve();
  expect(refreshed).toEqual(["account-a"]);
  expect(view.host.textContent).not.toContain("Confirm");
});

test("Use one reset fires on the first click and the card shows the new window once the store answers (#1373)", async () => {
  const redeemed: string[] = [];
  const initial = state(login({ phase: "authenticated" }), {
    engine: "codex",
    accounts: [codexCard()],
    useResetCredit: async (id) => { redeemed.push(id); return true; },
  });
  const view = await mount(initial);
  mounted.push(view);
  const block = () => view.host.querySelector('[data-account-limits="account-a"]')!;
  expect(block().textContent).toContain("0%");
  expect(block().textContent).toContain("1 reset available");
  const use = view.host.querySelector<HTMLButtonElement>('button[data-account-use-reset="account-a"]')!;
  expect(use.disabled).toBeFalse();
  flushSync(() => { use.click(); });
  await Promise.resolve();
  expect(redeemed).toEqual(["account-a"]);
  expect(view.host.textContent).not.toContain("Confirm");

  // The store answers with the new window: zero used, a later reset, no credit left.
  const later = Math.floor(Date.now() / 1000) + 7 * 86_400;
  await view.rerender(state(login({ phase: "authenticated" }), {
    engine: "codex",
    accounts: [codexCard({
      limits: { freshness: "fresh", session: null, weekly: { usedPercent: 0, resetsAt: later, windowMinutes: 10_080 }, checkedAt: new Date().toISOString() },
      resetCredits: { availableCount: 0, expiresAt: null },
    })],
    useResetCredit: initial.useResetCredit,
  }));
  expect(block().textContent).toContain("100%");
  expect(block().textContent).toContain("No resets available");
  expect(block().textContent).not.toContain("rate-limited");
  expect(view.host.querySelector<HTMLButtonElement>('button[data-account-use-reset="account-a"]')!.disabled).toBeTrue();
});

test("an action in flight marks its button busy and holds the other action until it settles (#1418)", async () => {
  const view = await mount(state(login({ phase: "authenticated" }), {
    engine: "codex",
    accounts: [codexCard()],
    limitsBusy: { accountId: "account-a", operation: "resetCredit" },
  }));
  mounted.push(view);
  const use = view.host.querySelector<HTMLButtonElement>('button[data-account-use-reset="account-a"]')!;
  const refresh = view.host.querySelector<HTMLButtonElement>('button[data-account-refresh-limits="account-a"]')!;
  expect(use.getAttribute("aria-busy")).toBe("true");
  expect(use.disabled).toBeTrue();
  expect(refresh.disabled).toBeTrue();
  expect(refresh.getAttribute("aria-busy")).toBeNull();
});
