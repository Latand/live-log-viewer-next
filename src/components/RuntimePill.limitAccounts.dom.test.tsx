import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import { setLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { RuntimePill } from "./RuntimePill";

/*
 * Mobile v2 lane 5 (#1439) — the «Next message» sheet at an account's limit
 * (README §4.2's limit row, §4.4, and the critique's P2-8 rule).
 *
 * With the account walled, offering only Model and Reasoning is offering
 * nothing: whatever the operator picks, the next message still cannot go. So
 * the sheet leads with an Account group, and the rule P2-8 is about is which
 * rows may become the launch target:
 *
 *   the blocked account  — inert, and it names its wall;
 *   an authenticated one — `ready`, one tap moves future launches there;
 *   one not signed in    — the device sign-in, and NOT a launch target, because
 *                          an account whose credentials have not come back
 *                          cannot take a message.
 */

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
  PointerEvent: dom.MouseEvent,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
});
(dom as unknown as { matchMedia(query: string): unknown }).matchMedia = (query: string) => ({
  matches: true,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

/** Three invented Claude accounts: a ready one, the walled one, a signed-out
    one — deliberately NOT in the order the sheet must show them, so the row
    that names the wall having to come first is what the ordering asserts. */
const ACCOUNTS = [
  { id: "acct-two", label: "Account two", kind: "managed", authPresent: true, authHealth: "authenticated", loginPending: false, loginState: "authenticated", deviceAuth: null },
  { id: "acct-one", label: "Account one", kind: "managed", authPresent: true, authHealth: "authenticated", loginPending: false, loginState: "authenticated", deviceAuth: null },
  { id: "acct-three", label: "Account three", kind: "managed", authPresent: false, authHealth: "signed_out", loginPending: false, loginState: "idle", deviceAuth: null },
];

const calls: { url: string; body: unknown }[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  setLocale("en");
  calls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : (input as URL).toString());
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "/api/accounts") {
      return new Response(JSON.stringify({ claude: { active: "acct-one", accounts: ACCOUNTS, migration: null, autoBalance: null } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});

/** Resets at 16:40 local, expressed as the epoch the projection reads. */
function resetAt(): number {
  const at = new Date();
  at.setHours(16, 40, 0, 0);
  return Math.floor(at.getTime() / 1000);
}

const limitedFile: FileEntry = {
  path: "/claude-limit.jsonl", root: "claude-projects", name: "claude-limit.jsonl", project: "viewer",
  title: "Migrate accounts to the new binding", engine: "claude", kind: "session", fmt: "claude",
  parent: null, mtime: 1, size: 1, activity: "live", proc: "running", pid: 11,
  conversationId: "conversation_limit_1439", model: "opus", effort: "high", fast: false,
  pendingQuestion: null, waitingInput: null,
  rateLimit: { source: "account", accountId: "acct-one", window: "session", resetAt: resetAt() },
} as FileEntry;

async function openSheet(file: FileEntry = limitedFile): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<RuntimePill file={file} surface="live-root" />);
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    (host.querySelector("[data-runtime-pill]") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 5));
  });
  return { host, root };
}

const rows = (host: HTMLElement) => [...host.querySelectorAll("[data-runtime-sheet-account]")] as HTMLButtonElement[];

test("the chip names the wall instead of a reasoning tier the next message cannot use", async () => {
  const { host, root } = await openSheet();
  const chip = host.querySelector("[data-runtime-pill]")!;
  expect(chip.textContent).toContain("acct-one at limit");
  expect(chip.querySelector("span")!.className).toContain("warning");
  await act(async () => root.unmount());
});

test("the sheet leads with the accounts, the blocked one first and naming its reset", async () => {
  const { host, root } = await openSheet();
  const listed = rows(host);
  expect(listed.map((row) => row.getAttribute("data-runtime-sheet-account"))).toEqual(["acct-one", "acct-two", "acct-three"]);
  expect(listed.map((row) => row.getAttribute("data-runtime-account-state")))
    .toEqual(["limit", "ready", "needs-sign-in"]);
  expect(listed[0]!.textContent).toContain("limit · resets 16:40");
  /* The wall is a fact, not an action. */
  expect(listed[0]!.disabled).toBe(true);
  /* And it comes BEFORE Model — reading order is the order of usefulness. */
  const groups = [...host.querySelectorAll("[data-runtime-sheet-accounts], [role=\"radiogroup\"]")];
  expect(groups[0]!.hasAttribute("data-runtime-sheet-accounts")).toBe(true);
  await act(async () => root.unmount());
});

test("an authenticated account is `ready`, and one tap moves the next launch there", async () => {
  const { host, root } = await openSheet();
  const ready = rows(host)[1]!;
  expect(ready.textContent).toContain("ready");
  expect(ready.disabled).toBe(false);
  await act(async () => {
    ready.click();
    await new Promise((r) => setTimeout(r, 5));
  });
  const select = calls.find((call) => call.url.endsWith("/api/accounts/claude/active"));
  expect(select).toBeTruthy();
  expect(select!.body).toMatchObject({ id: "acct-two", mode: "select" });
  await act(async () => root.unmount());
});

test("a signed-out account opens the device sign-in and never becomes the launch target", async () => {
  const { host, root } = await openSheet();
  const signedOut = rows(host)[2]!;
  expect(signedOut.textContent).toContain("sign in");
  expect(signedOut.getAttribute("aria-label")).toContain("takes no message until it returns");
  await act(async () => {
    signedOut.click();
    await new Promise((r) => setTimeout(r, 5));
  });
  /* The sign-in was started… */
  const login = calls.find((call) => (call.body as { action?: string } | null)?.action === "retry");
  expect(login).toBeTruthy();
  expect(login!.body).toMatchObject({ action: "retry", id: "acct-three" });
  /* …and no launch moved to it: P2-8, the whole point of the rule. */
  expect(calls.some((call) => call.url.endsWith("/api/accounts/claude/active"))).toBe(false);
  await act(async () => root.unmount());
});

test("with no limit the sheet subscribes to no accounts at all", async () => {
  const { host, root } = await openSheet({ ...limitedFile, rateLimit: null } as FileEntry);
  expect(host.querySelector("[data-runtime-sheet-accounts]")).toBeNull();
  expect(calls.some((call) => call.url === "/api/accounts")).toBe(false);
  /* And the chip goes back to the ordinary model · reasoning face. */
  expect(host.querySelector("[data-runtime-pill]")!.textContent).toContain("· high");
  await act(async () => root.unmount());
});
