import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { EngineAccountsState } from "@/hooks/useEngineAccounts";
import { installActEnv } from "@/test-helpers/actEnv";

import { EngineAccountSwitchControl } from "./EngineAccountSwitch";

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
