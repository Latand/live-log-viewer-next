import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { FileEntry } from "@/lib/types";

/*
 * Issue #97 — the one-click successor reseat on a rate-limited card, exercised
 * in a mobile-shaped DOM (narrow viewport, matchMedia max-width matches, touch
 * taps). The affordance must render beside the badge, post exactly one
 * lineage-checked reseat per tap, and stand down while a migration annotation
 * owns the card.
 */

const { RateLimitBadge } = await import("@/components/RateLimitBadge");

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
const G = globalThis as Record<string, unknown>;
const fetchCalls: { url: string; body: Record<string, unknown> }[] = [];
let fetchResponse: { ok: boolean; status: number; payload: Record<string, unknown> } = { ok: true, status: 200, payload: { reseat: "requested" } };
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  matchMedia: (q: string) => ({ matches: /max-width/.test(String(q)), media: String(q), onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }),
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  fetch: (async (url: string, init?: { body?: string }) => {
    fetchCalls.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") as Record<string, unknown> });
    return { ok: fetchResponse.ok, status: fetchResponse.status, json: async () => fetchResponse.payload, text: async () => "" };
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

let roots: Root[] = [];
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; fetchCalls.length = 0; fetchResponse = { ok: true, status: 200, payload: { reseat: "requested" } }; });
afterEach(async () => { for (const r of roots) flushSync(() => r.unmount()); roots = []; await settle(); });

function mount(node: React.ReactElement): Root {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(node));
  roots.push(root);
  return root;
}

function limitedEntry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/sessions/limited.jsonl",
    root: "codex-sessions",
    name: "limited.jsonl",
    project: "demo",
    title: "Implementer",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1_000,
    size: 10,
    activity: "live",
    proc: "running",
    pid: 42,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    conversationId: "conversation_limited",
    rateLimit: { source: "pane", accountId: "limited", window: "session", resetAt: null },
    ...overrides,
  };
}

test("a tap on the mobile card fires exactly one lineage-checked reseat", async () => {
  mount(<RateLimitBadge file={limitedEntry()} />);

  const badge = dom.document.querySelector("[data-rate-limited]");
  expect(badge).not.toBeNull();
  const button = dom.document.querySelector("[data-rate-limit-reseat]") as unknown as HTMLButtonElement;
  expect(button).not.toBeNull();

  flushSync(() => { button.click(); });
  await settle();
  /* Disabled while requested: a second impatient tap must not double-post. */
  flushSync(() => { button.click(); });
  await settle();

  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0]!.url).toBe("/api/conversations/conversation_limited/migration");
  expect(fetchCalls[0]!.body).toEqual({ action: "reseat", path: "/sessions/limited.jsonl" });
  expect(button.hasAttribute("disabled")).toBeTrue();
});

test("a card already owned by a migration offers no reseat", () => {
  mount(
    <RateLimitBadge
      file={limitedEntry({
        migration: { intentId: "intent", trigger: "manual", phase: "successor-starting", targetAccountId: "healthy", failure: null },
      })}
    />,
  );

  expect(dom.document.querySelector("[data-rate-limited]")).not.toBeNull();
  expect(dom.document.querySelector("[data-rate-limit-reseat]")).toBeNull();
});

test("a stale card renders already-reseated as terminal truth, never a fresh reseat", async () => {
  /* The server's path fence says a successor already owns this thread: the
     card must state that outcome and go inert — not spin "reseating…" as if
     a new successor were on the way, and not raise an error alert. */
  fetchResponse = { ok: false, status: 409, payload: { reseat: "already-reseated", error: "a successor already replaced this conversation" } };
  mount(<RateLimitBadge file={limitedEntry()} />);

  const button = dom.document.querySelector("[data-rate-limit-reseat]") as unknown as HTMLButtonElement;
  flushSync(() => { button.click(); });
  await settle();

  expect(button.hasAttribute("data-rate-limit-reseated")).toBeTrue();
  expect(button.hasAttribute("disabled")).toBeTrue();
  expect(button.textContent).toContain("already reseated");
  expect(button.textContent).not.toContain("reseating");
  expect(dom.document.querySelector("[role=alert]")).toBeNull();

  /* Terminal means terminal: another tap never re-posts. */
  flushSync(() => { button.click(); });
  await settle();
  expect(fetchCalls).toHaveLength(1);
});

test("a refused reseat announces its public reason instead of failing silently", async () => {
  fetchResponse = { ok: false, status: 409, payload: { error: "no healthy account with fresh quota headroom is available" } };
  mount(<RateLimitBadge file={limitedEntry()} />);

  const button = dom.document.querySelector("[data-rate-limit-reseat]") as unknown as HTMLButtonElement;
  flushSync(() => { button.click(); });
  await settle();

  const alert = dom.document.querySelector("[role=alert]");
  expect(alert?.textContent).toContain("no healthy account");
  expect(button.hasAttribute("disabled")).toBeFalse();
});
