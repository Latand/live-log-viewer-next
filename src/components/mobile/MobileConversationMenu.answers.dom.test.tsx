import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { emptyStore } from "@/components/runtime/runtimeModel";
import { setLocale, translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

/*
 * What the phone's action rows are allowed to claim (mobile v2 lane 3,
 * README §2 rule 9, §4.2).
 *
 * The rows that talk to a host — Stop, Compact, Kill — used to close the sheet
 * and fire the request into the void: the receipt said «Killed …» whatever came
 * back, the strip status line they answer on was inside the sheet that had just
 * closed, and `useProcessKill`'s state unmounted with it, so the SIGKILL that a
 * refused SIGTERM unlocks was thrown away every time. Each row now awaits the
 * real answer with the sheet open: only an ACCEPTED request closes it and shows
 * the receipt, and a refusal or a dead transport is reported where the operator
 * is still looking — with the escalation one tap away. Nothing here asks for
 * confirmation, which is the rule the old close-then-fire path was honouring.
 */

const dom = new Window({ url: "http://localhost/" });
installActEnv();
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
(dom as unknown as { matchMedia(q: string): unknown }).matchMedia = (query: string) => ({
  matches: true, media: String(query), onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
});
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver, IntersectionObserver: undefined,
});

/* The runtime plane is off, so this conversation is a legacy live root: Kill
   posts to `/api/proc` with the SIGTERM→SIGKILL escalation, and Stop/Compact
   post to `/api/tmux` — the paths whose refusals the rows have to report. */
const actualRuntimeHooks = await import("@/hooks/useRuntime");
const inert = { enabled: false, connection: "offline" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inert, lastEventAt: null }),
  useRuntime: () => inert,
  useRuntimeEnabled: () => false,
  useRuntimeSession: () => null,
  useRuntimeSessionByArtifact: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));

const { MobileConversationMenu } = await import("./MobileConversationMenu");
const { receipts } = await import("./MobileReceipt");

const TITLE = "Make the phone's action rows report the answer they got";
const file = {
  path: "/repo/atlas/agent.jsonl", root: "claude-projects", name: "agent.jsonl", project: "atlas", title: TITLE,
  engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 10, size: 1, activity: "live",
  proc: "running", pid: 4242, conversationId: "conversation_answers", model: "opus", renamable: true,
  pendingQuestion: null, waitingInput: null,
} as unknown as FileEntry;

interface Call { url: string; body: Record<string, unknown> }
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
let calls: Call[] = [];
/** What the next request of each kind answers; a thrown answer is a dead transport. */
let answer: (url: string) => unknown = () => ({ ok: true });

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const answered = answer(url);
    if (answered instanceof Error) throw answered;
    return json(answered);
  }) as typeof fetch;
}

let roots: Root[] = [];
let closes = 0;

function open(): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as Element);
  roots.push(root);
  act(() => {
    root.render(
      <MobileConversationMenu
        file={file}
        stage={null}
        crowned={false}
        hostTaskCount={0}
        projectName="atlas"
        onRename={() => undefined}
        onOpenHost={() => undefined}
        onClose={() => { closes += 1; }}
      />,
    );
  });
  return host as unknown as HTMLElement;
}

const row = (host: HTMLElement, name: string) =>
  host.querySelector(`[data-mobile2-menu-row="${name}"]`) as unknown as HTMLButtonElement;

const tap = async (host: HTMLElement, name: string) => {
  await act(async () => {
    row(host, name).click();
    await Promise.resolve();
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

beforeEach(() => {
  setLocale("en");
  calls = [];
  closes = 0;
  answer = () => ({ ok: true });
  installFetch();
});
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots = [];
  receipts.dismiss();
  dom.document.body.replaceChildren();
});
afterAll(() => {
  globalThis.fetch = realFetch;
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

test("a refused Kill reports the refusal instead of a receipt, and the SIGKILL it unlocked survives", async () => {
  const host = open();
  answer = () => ({ ok: false, error: "kill refused: no such process" });
  await tap(host, "kill");

  /* Nothing was killed, so nothing says it was. */
  expect(receipts.getState()).toBeNull();
  expect(closes).toBe(0);
  expect(host.querySelector('[data-mobile2-sheet="menu"]')).not.toBeNull();
  expect((host.querySelector("[data-mobile2-kill-status]") as unknown as HTMLElement | null)?.textContent)
    .toContain("kill refused: no such process");
  /* The escalation the refusal unlocked is on the row itself. */
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("/api/proc");
  expect(calls[0]!.body.force).toBe(false);
  expect(row(host, "kill").textContent).toContain("SIGKILL");

  /* And the next tap is that escalation — the state the closing sheet used to
     drop — which the host accepts, so now the receipt is earned. */
  answer = () => ({ ok: true, pid: 4242 });
  await tap(host, "kill");
  expect(calls).toHaveLength(2);
  expect(calls[1]!.body.force).toBe(true);
  expect(closes).toBe(1);
  expect(receipts.getState()?.text).toBe(translate("en", "mobile2.chat.killed", { title: TITLE }));
});

test("a Kill whose transport is dead says so rather than reporting a kill", async () => {
  const host = open();
  answer = () => new Error("network down");
  await tap(host, "kill");

  expect(receipts.getState()).toBeNull();
  expect(closes).toBe(0);
  expect((host.querySelector("[data-mobile2-kill-status]") as unknown as HTMLElement | null)?.textContent)
    .toBe(translate("en", "common.serverUnavailable"));
  expect(row(host, "kill").textContent).toContain("SIGKILL");
});

test("a refused Stop answers on the sheet's own status line, which is still on screen to be read", async () => {
  const host = open();
  answer = () => ({ ok: false, error: "interrupt refused: no live pane" });
  await tap(host, "stop");

  expect(closes).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("/api/tmux");
  expect(calls[0]!.body.action).toBe("interrupt");
  const status = host.querySelector("[data-mobile2-menu-status]") as unknown as HTMLElement | null;
  expect(status?.getAttribute("data-mobile2-menu-status")).toBe("err");
  expect(status?.textContent).toContain("interrupt refused: no live pane");
  expect(receipts.getState()).toBeNull();
});

test("an accepted Compact answers on the same line: one tap, no arming step, and a result", async () => {
  const host = open();
  answer = () => ({ ok: true });
  await tap(host, "compact");

  expect(closes).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body.action).toBe("compact");
  const status = host.querySelector("[data-mobile2-menu-status]") as unknown as HTMLElement | null;
  expect(status?.getAttribute("data-mobile2-menu-status")).toBe("ok");
  expect(status?.textContent).toBe(translate("en", "composer.compactSent"));
});
