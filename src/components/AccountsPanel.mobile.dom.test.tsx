import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { AccountOption, EngineAccountsState } from "@/hooks/useEngineAccounts";
import { installActEnv } from "@/test-helpers/actEnv";

import { MobileAccountsBody, mobileAccountCorner, mobileAccountState } from "./AccountsPanel";
import { createReceiptStore, type ReceiptStore } from "./mobile/MobileReceipt";

/*
 * The Accounts & limits screen on the phone (issue #1439, lane 9;
 * docs/design/mobile-v2/README.md §4.8): the active account as a card with its
 * windows and the actions that act ON THE TAP, the other authenticated
 * accounts as quiet rows that switch future launches, a row that is not signed
 * in that opens the device sign-in and stays inactive, and the add row last.
 *
 * The two numbers the design fixes are asserted here because both used to mean
 * the opposite: every meter fills with what REMAINS, coloured by what remains,
 * and the card's corner names the window its number belongs to (§5, P2-4).
 */

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  KeyboardEvent: dom.KeyboardEvent,
});
installActEnv();

const NOW = 1_800_000_000;
const HOUR = 3_600;
const DAY = 24 * HOUR;

function account(over: Partial<AccountOption> & { id: string; label: string }): AccountOption {
  return {
    kind: "managed",
    authPresent: true,
    authHealth: "authenticated",
    loginPending: false,
    loginState: "authenticated",
    deviceAuth: null,
    login: null,
    ...over,
  } as AccountOption;
}

const window5h = (usedPercent: number, resetsAt: number) => ({ usedPercent, resetsAt, windowMinutes: 300 });
const windowWeek = (usedPercent: number, resetsAt: number) => ({ usedPercent, resetsAt, windowMinutes: 10_080 });

/** «Main» holds the seat: a 5h window with room, a week nearly spent, and the
    flagship week #1358 added — three rows, three meters, one corner. */
const claudeMain = account({
  id: "cl-main",
  label: "Main",
  plan: "max",
  limits: {
    freshness: "fresh",
    session: window5h(28, NOW + 2 * HOUR),
    weekly: windowWeek(92, NOW + 3 * DAY),
    flagship: { ...windowWeek(29, NOW + 3 * DAY), tier: "opus" },
    plan: "max",
    capturedAt: NOW - 600,
    checkedAt: new Date((NOW - 600) * 1000).toISOString(),
  },
} as Partial<AccountOption> & { id: string; label: string });

const claudeLab = account({
  id: "cl-lab",
  label: "Lab",
  plan: "pro",
  limits: { freshness: "fresh", session: window5h(12, NOW + 4 * HOUR), weekly: windowWeek(36, NOW + 6 * DAY), plan: "pro", capturedAt: NOW - 900, checkedAt: new Date((NOW - 900) * 1000).toISOString() },
} as Partial<AccountOption> & { id: string; label: string });

const claudeSecond = account({ id: "cl-second", label: "Second", authPresent: false, authHealth: "signed_out" });

const codexMain = account({
  id: "cx-main",
  label: "Main",
  plan: "pro",
  limits: { freshness: "fresh", session: window5h(40, NOW + HOUR), weekly: windowWeek(55, NOW + 2 * DAY), plan: "pro", capturedAt: NOW - 300, checkedAt: new Date((NOW - 300) * 1000).toISOString() },
  resetCredits: { availableCount: 1, expiresAt: NOW + 20 * DAY },
} as Partial<AccountOption> & { id: string; label: string });

const codexSpare = account({ id: "cx-spare", label: "Spare", authPresent: false, authHealth: "signed_out" });

function engineState(engine: "claude" | "codex", accounts: AccountOption[], active: string, over: Partial<EngineAccountsState> = {}): EngineAccountsState {
  return {
    engine,
    accounts,
    active,
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
    ...over,
  };
}

const mounted: Array<{ root: Root; host: HTMLDivElement }> = [];
afterEach(async () => {
  await Promise.all(mounted.splice(0).map(async ({ root, host }) => {
    await act(async () => root.unmount());
    host.remove();
  }));
  document.body.replaceChildren();
});

async function mount(engines: EngineAccountsState[], receipts: ReceiptStore = createReceiptStore()): Promise<{ host: HTMLDivElement; receipts: ReceiptStore; rerender(next: EngineAccountsState[]): Promise<void> }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  const render = async (next: EngineAccountsState[]) => {
    await act(async () => root.render(<MobileAccountsBody engines={next} now={NOW} receipts={receipts} />));
  };
  await render(engines);
  return { host, receipts, rerender: render };
}

const click = async (element: Element | null) => {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
};

const text = (element: Element | null | undefined) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();

test("every meter on the active card fills with what remains, and the corner names its tightest window", async () => {
  const { host } = await mount([engineState("claude", [claudeMain, claudeLab], "cl-main")]);

  const card = host.querySelector('[data-mobile2-account="cl-main"]')!;
  expect(card.getAttribute("data-mobile2-account-state")).toBe("active");

  const meters = [...card.querySelectorAll('[data-limit-row] [role="meter"]')];
  // 28 / 92 / 29 percent used ⇒ 72 / 8 / 71 percent left, in the design's order.
  expect(meters.map((meter) => meter.getAttribute("aria-valuenow"))).toEqual(["72", "8", "71"]);
  expect(meters.map((meter) => (meter.firstElementChild as HTMLElement).style.width)).toEqual(["72%", "8%", "71%"]);
  // Coloured by what remains: the nearly spent week is danger, the rest accent.
  expect(meters.map((meter) => meter.getAttribute("data-mobile2-meter-tone"))).toEqual(["accent", "danger", "accent"]);
  expect(text(card.querySelector('[data-limit-row="session"]'))).toContain("72% left");
  expect(text(card.querySelector('[data-limit-row="weekly"]'))).toContain("8% left");
  expect(text(card.querySelector('[data-limit-row="flagship"]'))).toContain("71% left");

  const corner = card.querySelector("[data-mobile2-account-corner]")!;
  expect(corner.getAttribute("data-mobile2-account-window")).toBe("Week");
  expect(text(corner)).toBe("8% leftWeek");
  expect(corner.getAttribute("aria-label")).toBe("8% left of the Week window");
  // The number the corner shows is the tightest window's headroom, never the
  // first window's and never what was used.
  expect(mobileAccountCorner({ session: null, weekly: null, flagship: null, plan: null }, (key: string) => key)).toBeNull();
});

test("the quiet row of an authenticated account switches future launches on the tap, and the receipt carries Switch back", async () => {
  const selected: string[] = [];
  const state = engineState("claude", [claudeMain, claudeLab], "cl-main", {
    select: async (id: string) => { selected.push(id); return true; },
  });
  const { host, receipts } = await mount([state]);

  const row = host.querySelector('[data-mobile2-account-switch="cl-lab"]');
  expect(row?.getAttribute("aria-label")).toBe("Use Lab for future launches");
  expect(text(host.querySelector('[data-mobile2-account="cl-lab"]'))).toContain("ready");

  await click(row);

  // One tap, no confirmation step, one selection.
  expect(selected).toEqual(["cl-lab"]);
  expect(host.querySelector("button[data-confirm]")).toBeNull();
  const receipt = receipts.getState()!;
  expect(receipt.text).toBe("Future launches use Lab");
  expect(receipt.inverse?.kind).toBe("switchBack");

  await act(async () => receipt.inverse!.run());
  expect(selected).toEqual(["cl-lab", "cl-main"]);
});

test("Refresh and Use one reset act on the tap and answer with a receipt; the reset is offered only where a credit exists", async () => {
  const refreshed: string[] = [];
  const redeemed: string[] = [];
  const claude = engineState("claude", [claudeMain], "cl-main", {
    refreshLimits: async (id: string) => { refreshed.push(id); return true; },
  });
  const codex = engineState("codex", [codexMain], "cx-main", {
    refreshLimits: async (id: string) => { refreshed.push(id); return true; },
    useResetCredit: async (id: string) => { redeemed.push(id); return true; },
  });
  const { host, receipts } = await mount([claude, codex]);

  // A Claude card carries no reset control at all; Codex carries one.
  expect(host.querySelector('[data-mobile2-accounts-engine="claude"] [data-account-use-reset]')).toBeNull();
  const reset = host.querySelector('[data-account-use-reset="cx-main"]') as HTMLButtonElement;
  expect(reset.disabled).toBe(false);
  expect(text(host.querySelector('[data-account-reset-credits="cx-main"]'))).toContain("1 reset available");

  await click(host.querySelector('[data-account-refresh-limits="cl-main"]'));
  expect(refreshed).toEqual(["cl-main"]);
  expect(receipts.getState()?.text).toBe("Limits re-read for Main");

  await click(reset);
  expect(redeemed).toEqual(["cx-main"]);
  expect(receipts.getState()?.text).toBe("Reset used on Main");
});

test("a Codex card with no reset credit still shows Refresh, with the reset control disabled", async () => {
  const spent = account({ ...codexMain, resetCredits: { availableCount: 0, expiresAt: null } } as Partial<AccountOption> & { id: string; label: string });
  const { host } = await mount([engineState("codex", [spent], "cx-main")]);

  expect((host.querySelector('[data-account-refresh-limits="cx-main"]') as HTMLButtonElement).disabled).toBe(false);
  expect((host.querySelector('[data-account-use-reset="cx-main"]') as HTMLButtonElement).disabled).toBe(true);
  expect(text(host.querySelector('[data-account-reset-credits="cx-main"]'))).toContain("No resets available");
});

test("a Codex row that is not signed in opens the device sign-in, shows its code, and stays inactive", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ account: { id: "cx-spare" }, deviceAuth: { url: "https://example.invalid/device", code: "ABCD-EFGH" } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const selected: string[] = [];
  try {
    const state = engineState("codex", [codexMain, codexSpare], "cx-main", {
      select: async (id: string) => { selected.push(id); return true; },
    });
    const { host, receipts } = await mount([state]);

    const row = host.querySelector('[data-mobile2-account-signin="cx-spare"]')!;
    expect(text(row)).toContain("needs sign-in");
    expect(text(row)).toContain("sign in");
    // The row is a sign-in, never a switch: nothing here can make it active.
    expect(host.querySelector('[data-mobile2-account-switch="cx-spare"]')).toBeNull();

    await click(row);

    expect(calls).toEqual([{ url: "/api/accounts/codex", body: { action: "retry", id: "cx-spare" } }]);
    expect(selected).toEqual([]);
    expect(host.querySelector('[data-mobile2-account="cx-spare"]')?.getAttribute("data-mobile2-account-state")).toBe("needsSignIn");
    expect(host.querySelector('[data-mobile2-account="cx-main"]')?.getAttribute("data-mobile2-account-state")).toBe("active");
    const challenge = host.querySelector("[data-mobile2-account-device-signin]")!;
    expect(challenge.querySelector("a")?.getAttribute("href")).toBe("https://example.invalid/device");
    expect(text(challenge)).toContain("ABCD-EFGH");
    expect(receipts.getState()?.text).toBe("Device sign-in opened for Spare — it becomes active once signed in");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a Claude row that is not signed in restarts its login in place and stays inactive", async () => {
  const retried: string[] = [];
  const selected: string[] = [];
  const state = engineState("claude", [claudeMain, claudeSecond], "cl-main", {
    retryLogin: async (id: string) => { retried.push(id); return true; },
    select: async (id: string) => { selected.push(id); return true; },
  });
  const { host, receipts } = await mount([state]);

  await click(host.querySelector('[data-mobile2-account-signin="cl-second"]'));

  expect(retried).toEqual(["cl-second"]);
  expect(selected).toEqual([]);
  expect(host.querySelector('[data-mobile2-account="cl-second"]')?.getAttribute("data-mobile2-account-state")).toBe("needsSignIn");
  expect(receipts.getState()?.text).toBe("Device sign-in opened for Second — it becomes active once signed in");
});

test("a signed-out account is never the active card, even while the registry still names it active", async () => {
  const { host } = await mount([engineState("claude", [claudeSecond, claudeLab], "cl-second")]);

  expect(mobileAccountState(claudeSecond, "cl-second")).toBe("needsSignIn");
  expect(host.querySelector('[data-mobile2-account="cl-second"]')?.getAttribute("data-mobile2-account-state")).toBe("needsSignIn");
  expect(host.querySelector("[data-account-limits]")).toBeNull();
  expect(host.querySelector('[data-mobile2-account-signin="cl-second"]')).toBeTruthy();
});

test("the screen is one section per engine — the active card first, the add row last", async () => {
  const { host } = await mount([
    engineState("claude", [claudeLab, claudeMain, claudeSecond], "cl-main"),
    engineState("codex", [codexMain], "cx-main"),
  ]);

  const sections = [...host.querySelectorAll("[data-mobile2-accounts-engine]")];
  expect(sections.map((section) => section.getAttribute("data-mobile2-accounts-engine"))).toEqual(["claude", "codex"]);

  const claude = sections[0];
  expect([...claude.querySelectorAll("[data-mobile2-account]")].map((card) => card.getAttribute("data-mobile2-account"))).toEqual(["cl-main", "cl-lab", "cl-second"]);
  const last = claude.lastElementChild!;
  expect(last.querySelector('[data-mobile2-account-add="claude"]')).toBeTruthy();
  expect(text(last)).toContain("Add a Claude account");
  expect(text(claude.querySelector('[data-mobile2-account="cl-main"]'))).toContain("Max plan");
  // A quiet row keeps its own reading line: plan and when it was last checked.
  expect(text(claude.querySelector('[data-mobile2-account="cl-lab"]'))).toContain("checked");
});

test("an account with no reading says so instead of drawing an empty meter", async () => {
  const bare = account({ id: "cl-bare", label: "Bare" });
  const { host } = await mount([engineState("claude", [bare], "cl-bare")]);

  expect(host.querySelector('[data-mobile2-account="cl-bare"] [role="meter"]')).toBeNull();
  expect(host.querySelector("[data-mobile2-account-corner]")).toBeNull();
  expect(text(host.querySelector("[data-account-limits]"))).toContain("no reading yet");
});

test("the account a badge steered here (#229) is ringed on the screen it lands on", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(
    <MobileAccountsBody engines={[engineState("claude", [claudeMain, claudeLab], "cl-main")]} now={NOW} focusAccountId="cl-lab" receipts={createReceiptStore()} />,
  ));

  expect(host.querySelector('[data-mobile2-account="cl-lab"]')?.className).toContain("ring-accent/50");
  expect(host.querySelector('[data-mobile2-account="cl-main"]')?.className).not.toContain("ring-accent/50");
});
