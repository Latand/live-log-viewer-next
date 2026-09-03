import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { EngineAccountsState } from "@/hooks/useEngineAccounts";
import { installActEnv } from "@/test-helpers/actEnv";

import { getMobileNav, topScreen } from "./mobile/mobileNav";
import { EngineAccountSwitch, EngineAccountSwitchControl } from "./EngineAccountSwitch";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  KeyboardEvent: dom.KeyboardEvent,
});
/** Phone or desktop, per test: `useIsMobile` reads this and nothing else. */
let phone = false;
(dom as unknown as { matchMedia(query: string): unknown }).matchMedia = (query: string) => ({
  matches: phone,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});
installActEnv();

const mounted: Array<{ root: Root; host: HTMLDivElement }> = [];
afterEach(async () => {
  await Promise.all(mounted.splice(0).map(async ({ root, host }) => {
    await act(async () => root.unmount());
    host.remove();
  }));
  document.body.replaceChildren();
});

function accountState(select: EngineAccountsState["select"]): EngineAccountsState {
  return {
    engine: "codex",
    accounts: [
      {
        id: "account-north",
        label: "North star",
        kind: "legacy",
        authPresent: true,
        authHealth: "authenticated",
        plan: "Team",
        loginPending: false,
        loginState: "authenticated",
        deviceAuth: null,
        limits: { freshness: "fresh", session: { usedPercent: 28, resetsAt: null, windowMinutes: 300 }, weekly: null },
      },
      {
        id: "account-harbor",
        label: "Harbor light",
        kind: "managed",
        authPresent: true,
        authHealth: "authenticated",
        plan: "Pro",
        loginPending: false,
        loginState: "authenticated",
        deviceAuth: null,
        limits: { freshness: "fresh", session: { usedPercent: 9, resetsAt: null, windowMinutes: 300 }, weekly: null },
      },
    ],
    active: "account-north",
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
    select,
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
  };
}

test("the active account is collapsed at rest and the full switch flow opens on demand", async () => {
  let selected: string | null = null;
  const state = accountState(async (id) => { selected = id; return true; });
  const projectContext = {
    project: "project-atlas",
    restricted: true,
    allowed: [{ accountId: "account-north", label: "North star" }],
    carrying: [{ accountId: "account-harbor", label: "Harbor light" }],
    outsidePool: [],
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });

  await act(async () => root.render(<EngineAccountSwitchControl state={state} projectContext={projectContext} />));

  const trigger = host.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement;
  expect(trigger).toBeTruthy();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(trigger.textContent).toContain("North star");
  expect(host.textContent).not.toContain("Harbor light");
  expect(host.querySelector('[role="dialog"]')).toBeNull();

  await act(async () => trigger.click());

  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector('[role="dialog"]')).toBeTruthy();
  expect(host.textContent).toContain("North star");
  expect(host.textContent).toContain("Harbor light");
  expect(host.textContent).toContain("Team");
  expect(host.textContent).toContain("Pro");
  expect(host.textContent).toContain("72%");
  expect(host.textContent).toContain("91%");
  expect(host.querySelector('[data-project-account-detail="project-atlas"]')).toBeTruthy();
  expect(host.querySelector('[data-project-account-carrying="account-harbor"]')).toBeTruthy();

  const harbor = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Harbor light"));
  expect(harbor).toBeTruthy();
  await act(async () => harbor!.click());
  expect(selected as unknown as string).toBe("account-harbor");
});

/*
 * The phone has ONE accounts surface (mobile v2 lane 9, README §3.1 and §4.8):
 * the Accounts & limits screen the board menu pushes. A trigger on a
 * phone-sized viewport goes there instead of floating the desktop dialog over
 * whatever the operator is looking at — the dialog is a 95vw flyout with its
 * own scroller, which is exactly the surface this redesign replaces.
 */

test("with an accounts screen to open, the trigger pushes it and never opens the dialog", async () => {
  let opened = 0;
  const state = accountState(async () => true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });

  await act(async () => root.render(<EngineAccountSwitchControl state={state} onOpenScreen={() => { opened += 1; }} />));

  const trigger = host.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement;
  // Nothing expands here: the control hands over to a screen.
  expect(trigger.getAttribute("aria-expanded")).toBeNull();

  await act(async () => trigger.click());

  expect(opened).toBe(1);
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(host.textContent).not.toContain("Harbor light");
});

test("on a phone the mounted switch lands the shell on the accounts screen", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    claude: { active: "cl-main", accounts: [{ id: "cl-main", label: "Main", kind: "managed", authPresent: true, loginPending: false }] },
    codex: { active: "cx-main", accounts: [{ id: "cx-main", label: "Main", kind: "managed", authPresent: true, loginPending: false }] },
  }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  phone = true;
  try {
    const nav = getMobileNav();
    nav.home();
    expect(topScreen(nav.getState()).kind).toBe("board");

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted.push({ root, host });
    await act(async () => root.render(<EngineAccountSwitch engine="codex" />));

    await act(async () => (host.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement).click());

    expect(topScreen(nav.getState()).kind).toBe("accounts");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    nav.home();
  } finally {
    phone = false;
    globalThis.fetch = realFetch;
  }
});
