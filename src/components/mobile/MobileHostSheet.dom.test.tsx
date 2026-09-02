import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { MobileHostSheet } from "./MobileHostSheet";
import { receipts } from "./MobileReceipt";

/*
 * Host details on the phone (mobile v2 lane 2, README §2 rule 5, §4.1, Q4).
 *
 * The sheet is the one place host detail lives, and Kill there acts on the tap
 * that names it: no arm step, no confirmation row, no second question. The
 * safety net is the receipt — and a background process has no inverse, so the
 * receipt carries none and a refused kill says so on the row instead.
 */

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
const G = globalThis as Record<string, unknown>;
let posts: Array<{ url: string; body: unknown }> = [];
let killAnswer: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: { ok: true, pid: 41_822 } };

const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  matchMedia: (query: string) => ({ matches: true, media: String(query), onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }),
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    posts.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
    return { ok: killAnswer.ok, status: killAnswer.status, json: async () => killAnswer.body, text: async () => JSON.stringify(killAnswer.body) };
  }) as unknown as typeof fetch,
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
});

const task = {
  path: "/repo/next-dev.log", root: "claude-projects", name: "next-dev.log", project: "atlas",
  title: "next dev · port 8899", cmdDesc: "next dev · port 8899",
  engine: "shell", kind: "task", fmt: "text", parent: null, mtime: 9_100, size: 512,
  activity: "live", proc: "running", pid: 41_822, model: null, pendingQuestion: null, waitingInput: null,
} as unknown as FileEntry;

let roots: Root[] = [];
let closed = 0;
let killed: string[] = [];
let catalogOpens = 0;
beforeEach(() => {
  roots = [];
  posts = [];
  closed = 0;
  killed = [];
  catalogOpens = 0;
  killAnswer = { ok: true, status: 200, body: { ok: true, pid: 41_822 } };
  dom.document.body.replaceChildren();
  receipts.dismiss();
});
afterEach(async () => { for (const root of roots) flushSync(() => root.unmount()); roots = []; receipts.dismiss(); await settle(); });

function mount(over: Partial<React.ComponentProps<typeof MobileHostSheet>> = {}): HTMLElement {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  flushSync(() => root.render(
    <MobileHostSheet
      projectName="atlas"
      runtime="live"
      tasks={[task]}
      hiddenCount={14}
      onOpenCatalog={() => { catalogOpens += 1; }}
      onClose={() => { closed += 1; }}
      onKilled={(path) => killed.push(path)}
      {...over}
    />,
  ));
  roots.push(root);
  return dom.document.body as unknown as HTMLElement;
}

const q = (root: HTMLElement, selector: string) => root.querySelector(selector) as unknown as HTMLElement | null;
const click = (el: HTMLElement | null) => { expect(el).not.toBeNull(); flushSync(() => el!.click()); };

test("the sheet names the runtime, its background processes and their PIDs", () => {
  const root = mount({ runtime: "degraded" });
  const sheet = q(root, '[data-mobile2-sheet="host"]')!;
  expect(sheet).not.toBeNull();
  expect(sheet.textContent).toContain(translate("en", "runtime.degraded"));
  expect(sheet.textContent).toContain(translate("en", "mobile2.host.runtimeDegraded"));
  const row = q(root, '[data-mobile2-host-task="/repo/next-dev.log"]')!;
  expect(row).not.toBeNull();
  expect(row.textContent).toContain("next dev · port 8899");
  expect(row.textContent).toContain(translate("en", "mobile2.host.pid", { pid: 41_822 }));
  /* The quiet conversations the board is not showing are one row away, in the
     catalog — the sheet is where «hidden» lives, never the board. */
  expect(sheet.textContent).toContain(translate("en", "mobile2.host.quiet", { count: 14 }));
  click(q(root, "[data-mobile2-host-catalog]"));
  expect(catalogOpens).toBe(1);
  click(q(root, "[data-mobile2-close]"));
  expect(closed).toBe(1);
});

test("Kill acts on the tap that names it — no arm step — and answers with a receipt", async () => {
  const root = mount();
  const kill = q(root, '[data-mobile2-kill="/repo/next-dev.log"]')!;
  expect(kill.textContent).toContain(translate("en", "task.kill"));
  expect(kill.className).toContain("min-h-11");

  click(kill);
  /* One tap, one request: nothing asked a second question first. */
  expect(posts).toHaveLength(1);
  expect(posts[0]!.url).toBe("/api/proc");
  expect(posts[0]!.body).toEqual({ path: "/repo/next-dev.log" });
  await settle();
  expect(killed).toEqual(["/repo/next-dev.log"]);

  const receipt = q(root, "[data-mobile2-receipt]")!;
  expect(receipt).not.toBeNull();
  expect(receipt.textContent).toContain(translate("en", "mobile2.host.killed", { pid: 41_822 }));
  /* SIGTERM has no inverse, so the receipt offers none. */
  expect(q(root, "[data-mobile2-receipt-undo]")).toBeNull();
});

test("a refused kill says so on the row and shows no receipt", async () => {
  killAnswer = { ok: false, status: 409, body: { ok: false, error: "process already gone" } };
  const root = mount();
  click(q(root, '[data-mobile2-kill="/repo/next-dev.log"]'));
  await settle();
  expect(killed).toEqual([]);
  expect(q(root, "[data-mobile2-receipt]")).toBeNull();
  expect(q(root, '[data-mobile2-host-task="/repo/next-dev.log"]')!.textContent).toContain("process already gone");
});

test("with no background process the sheet says so instead of an empty section", () => {
  const root = mount({ tasks: [] });
  expect(q(root, "[data-mobile2-host-task]")).toBeNull();
  expect(q(root, '[data-mobile2-sheet="host"]')!.textContent).toContain(translate("en", "mobile2.host.noBackground"));
});
