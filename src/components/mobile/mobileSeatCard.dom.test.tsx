import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { ORCHESTRATOR_PROMPT_VERSION, ORCHESTRATOR_SYSTEM_PROMPT } from "@/lib/orchestrator/prompt";
import type { FileEntry } from "@/lib/types";

/*
 * The phone's orchestrator SEAT CARD and its create draft (issue #979; mobile
 * v2 lane 6, docs/design/mobile-v2/README.md §4.1, §4.5), against the REAL
 * conversation screen at 390×844 — the same wrapper the operator's phone
 * mounts, so the card's position ahead of the leaf, the handoff into the
 * conversation, and the idempotency of a confirm are asserted where they
 * actually happen rather than on an isolated component.
 *
 * The seat route is answered in flight, which is the only way to drive the seat
 * state machine from a test: `seatAnswer` is what the next GET returns, and
 * `postSeat` is what the next confirm gets back.
 */

const dom = new HappyWindow({ innerWidth: 390, innerHeight: 844 });
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver, IntersectionObserver: undefined,
});
(dom as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (query: string) => ({
  matches: true, media: query, addEventListener() {}, removeEventListener() {},
});

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualLogTail = await import("@/hooks/useLogTail");
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  /* The runtime plane is OFF here, so the seat conversation classifies through
     the legacy path (a running proc is a live root) instead of failing safe to
     `unresolved` with no host evidence. `connection` still names a real state:
     the pill translates it before it checks `enabled`. */
  useRuntimeBusState: () => ({ enabled: false, connection: "live", resyncedAt: null, lastEventAt: null, store: emptyStore() }),
  useRuntime: () => ({ enabled: false, connection: "live", resyncedAt: null, store: emptyStore() }),
  useRuntimeEnabled: () => false,
  useRuntimeSession: () => null,
  useRuntimeSessionByArtifact: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
  refreshRuntime: async () => { runtimeRefreshes += 1; return true; },
}));
mock.module("@/hooks/useLogTail", () => ({
  useLogTail: () => ({
    lines: [], linesStart: 0, size: 0, loading: false, error: null, tickTime: null,
    paused: false, setPaused: () => undefined, clear: () => undefined,
    hasMore: false, loadingOlder: false, loadOlder: async () => 0, prependGen: 0,
  }),
}));

const { MobileFocusView } = await import("./MobileFocusView");
const { MobileSeatCard } = await import("./MobileSeatCard");
const { createMobileNav, MobileNavContext } = await import("./mobileNav");
const { resetOrchestratorSeatCacheForTests } = await import("../orchestrator/useOrchestratorSeat");

const { resetOrchestratorIncumbentCacheForTests } = await import("../orchestrator/useOrchestratorIncumbent");
const { FILES_CHANGED_EVENT } = await import("@/lib/filesEvents");

interface SeatAnswer { seat: unknown; pending: unknown; exists: boolean }
interface Recorded { url: string; method: string; body: Record<string, unknown> }

let seatAnswer: SeatAnswer = { seat: null, pending: null, exists: true };
let postSeat: (body: Record<string, unknown>) => Promise<Response> = async () =>
  new Response(JSON.stringify({ ok: true, state: "starting" }), { status: 200, headers: { "content-type": "application/json" } });
const requests: Recorded[] = [];
const realFetch = globalThis.fetch;
let incumbentAnswer: Record<string, unknown> | null = null;
let runtimeRefreshes = 0;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  requests.push({ url, method, body });
  if (url.startsWith("/api/orchestrator/seat/status")) return Response.json(incumbentAnswer);
  if (url.startsWith("/api/orchestrator/seat") && method === "POST") return postSeat(body);
  if (url.startsWith("/api/orchestrator/seat")) {
    return new Response(JSON.stringify(seatAnswer), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.startsWith("/api/accounts")) {
    return new Response(JSON.stringify({ claude: { active: "", accounts: [] }, codex: { active: "", accounts: [] } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const roots = new Set<Root>();
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  /* Each test is a tab that has never read this project's seat; the answer is
     cached per project for the session since #1149. */
  resetOrchestratorSeatCacheForTests();
  resetOrchestratorIncumbentCacheForTests();
  incumbentAnswer = null;
  runtimeRefreshes = 0;
  nav = createMobileNav(navHost());
  requests.length = 0;
  seatAnswer = { seat: null, pending: null, exists: true };
  postSeat = async () => new Response(JSON.stringify({ ok: true, state: "starting" }), { status: 200, headers: { "content-type": "application/json" } });
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  dom.sessionStorage.clear();
  dom.localStorage.clear();
});

function conversation(over: Partial<FileEntry>): FileEntry {
  return {
    path: "/other.jsonl", root: "claude-projects", name: "other.jsonl", project: "atlas", title: "Some other work",
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 100, size: 1, activity: "live",
    proc: "running", pid: 3, conversationId: "conv_other", model: "sonnet", cwd: "/repo/atlas", projectRoot: "/repo/atlas",
    pendingQuestion: null, waitingInput: null,
    ...over,
  } as FileEntry;
}

const orchestrator = conversation({
  path: "/orchestrator.jsonl", name: "orchestrator.jsonl", title: "Run the Atlas board",
  conversationId: "conv_orchestrator", model: "opus", mtime: 10,
});

const seat = (over: Record<string, unknown> = {}) => ({
  project: "atlas", seatEpoch: 4, conversationId: "conv_orchestrator", path: "/orchestrator.jsonl",
  mandate: "You run the Atlas board.", promptVersion: 4, predecessorConversationId: null, state: "active",
  intent: { clientRequestId: "seatreq-0001", mode: "spawn", launchId: "launch-0001", error: null },
  designatedAt: "2100-01-02T11:00:00.000Z", activatedAt: "2100-01-02T11:00:02.000Z",
  ...over,
});

/* A fake history per mount, so an open sheet is never inherited by the next
   test: the navigation store says WHICH sheet is open (§3.3), and the card
   reads it from the context the app provides. */
function navHost() {
  let state: unknown = null;
  const listeners = new Set<(next: unknown) => void>();
  return {
    history: {
      get state() { return state; },
      pushState(next: unknown) { state = next; },
      replaceState(next: unknown) { state = next; },
      back() { for (const listener of [...listeners]) listener(state); },
    },
    href: () => "http://localhost/",
    onPopstate(listener: (next: unknown) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/*
 * The phone leaf that hosts the seat card. Mobile v2 lane 3 folded the
 * conversation strip into the shell bar's title cell and lane 2 made the board
 * a list, so the card sits in its own slot ahead of the leaf — exactly as
 * `ProjectDashboard` mounts it above the board and above the catalog — and a
 * tap on a live seat pins the conversation the screen below shows.
 */
function Leaf({ files, nav }: { files: FileEntry[]; nav: ReturnType<typeof createMobileNav> }) {
  const [focus, setFocus] = useState<string | null>(null);
  return (
    <MobileNavContext.Provider value={nav}>
      <div data-testid="mobile-orchestrator-slot">
        <MobileSeatCard project="atlas" projectName="atlas" files={files} now={NOW} onOpenConversation={(file) => setFocus(file.path)} />
      </div>
      <MobileFocusView
        project="atlas"
        projectName="atlas"
        groups={[]}
        manual={files}
        files={files}
        flows={[]}
        pipelines={[]}
        tasks={[]}
        drafts={[]}
        loaded
        focus={focus}
        onSelect={(file) => setFocus(file.path)}
        onClose={() => undefined}
        onDraftClose={() => undefined}
        onDraftSpawned={() => undefined}
      />
    </MobileNavContext.Provider>
  );
}

/** The board's own clock, frozen: the card's badge ages against it. */
const NOW = Date.parse("2100-01-02T12:00:00.000Z") / 1000;

let nav = createMobileNav(navHost());
const view = (files: FileEntry[]) => <Leaf files={files} nav={nav} />;

/** Let the seat read (and anything it schedules) land, then re-render. */
async function settle(root: Root, element: React.ReactElement, rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => root.render(element));
  }
}

async function mount(files: FileEntry[]): Promise<{ host: HTMLElement; root: Root; rerender: (next: FileEntry[]) => Promise<void> }> {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  flushSync(() => root.render(view(files)));
  await settle(root, view(files));
  return {
    host: host as unknown as HTMLElement,
    root,
    rerender: async (next: FileEntry[]) => {
      flushSync(() => root.render(view(next)));
      await settle(root, view(next), 2);
    },
  };
}

/* Typing into a CONTROLLED field, through the element's own React props.
   React's change plugin never answers a synthetic `input` event in happy-dom
   (it falls back to the legacy keydown-watch path that no dispatch here can
   satisfy), so a dispatched event silently changes nothing — the composer's own
   suite reaches props the same way for paste. The handler is still the real
   one: a textarea wired to nothing would fail here rather than pass. */
function type(field: HTMLTextAreaElement, value: string): void {
  const key = Object.keys(field).find((name) => name.startsWith("__reactProps$"))!;
  const props = (field as unknown as Record<string, { onChange(event: unknown): void }>)[key]!;
  field.value = value;
  flushSync(() => props.onChange({ target: field }));
}

const card = (host: HTMLElement) => host.querySelector("[data-mobile2-seat-card]") as HTMLElement;
const openButton = (host: HTMLElement) => host.querySelector("[data-mobile2-seat-open]") as HTMLButtonElement;
const sheet = (host: HTMLElement) => host.querySelector('[data-testid="mobile-orchestrator-sheet"]') as HTMLElement | null;
/* The primary action is the sheet's FOOTER — outside the body in the bottom
   sheet, inside the form in the draft — so it is looked up on the host. */
const confirmButton = (host: HTMLElement) => host.querySelector("[data-orchestrator-confirm]") as HTMLButtonElement;
const badge = (host: HTMLElement) => host.querySelector("[data-mobile2-seat-card] [data-mobile2-seat-badge]") as HTMLElement | null;
const meter = (host: HTMLElement) => host.querySelector("[data-mobile2-seat-card] [data-mobile2-meter]") as HTMLElement | null;
/* Only the seat route: the mounted pane posts its own tmux target reads. */
const seatPosts = () => requests.filter((request) => request.method === "POST" && request.url === "/api/orchestrator/seat");

test("with no seat the card is the invitation, ahead of the leaf and outside anything that scrolls", async () => {
  const { host } = await mount([conversation({}), orchestrator]);
  const pinned = card(host);
  expect(pinned).not.toBeNull();
  expect(pinned.getAttribute("data-mobile2-seat-state")).toBe("draft");
  /* Over a vacancy the card is an invitation, not a status line (README
     §4.1): the absence in words, and one accent line into the create draft. */
  expect(pinned.getAttribute("data-mobile2-seat-shape")).toBe("invitation");
  expect(openButton(host).textContent).toContain("No orchestrator");
  const invitation = pinned.querySelector("[data-mobile2-seat-invitation]");
  expect(invitation!.textContent).toContain("Create an orchestrator");
  /* An invitation has no seat to describe, so it carries neither of the two
     things a seated card does. */
  expect(badge(host)).toBeNull();
  expect(meter(host)).toBeNull();
  /* And its tap goes to the draft, which is the surface that can create one. */
  expect(openButton(host).getAttribute("data-mobile2-open")).toBe("rotate");

  /* Before the leaf in document order — the whole point of the pin. Mobile v2
     lane 3 removed the conversation chips it used to lead; what it must still
     lead is whatever the leaf renders under it. */
  const leaf = host.querySelector('[data-testid="mobile-chat-shell"]')!;
  expect(pinned.compareDocumentPosition(leaf) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  /* Not INSIDE a horizontal scroller: a pinned card that scrolls away is not
     pinned. */
  expect(pinned.closest(".overflow-x-auto")).toBeNull();
  /* Phone tap target. */
  expect(openButton(host).className).toContain("h-11");
});

/* A board with no conversation of its own — the project is on screen for a
   draft, a task or a running pipeline — still gets the card. The OTHER empty
   phone leaf, the project shell's own «nothing here yet» branch, never mounts
   this view at all: `ProjectDashboard` chooses between the board, the catalog
   list and that empty state, and it is outside this lane's files. */
test("a project with nothing in it at all still shows the invitation", async () => {
  const { host } = await mount([]);
  expect(card(host)).not.toBeNull();
  expect(card(host).getAttribute("data-mobile2-seat-state")).toBe("draft");
  expect(card(host).getAttribute("data-mobile2-seat-shape")).toBe("invitation");
});

test("the invitation opens the create draft — the rotate sheet in create mode (README §4.5)", async () => {
  const { host, root } = await mount([conversation({})]);
  flushSync(() => openButton(host).click());
  await settle(root, view([conversation({})]), 2);

  /* One surface, two modes: the sheet the navigation store names `rotate` is
     the draft, and over a vacancy its primary CREATES. */
  expect(nav.getState().sheet).toBe("rotate");
  const panel = sheet(host)!;
  expect(panel.getAttribute("data-mobile2-sheet")).toBe("rotate");
  expect(panel.getAttribute("data-orchestrator-sheet-mode")).toBe("create");
  expect(panel.querySelector("[data-orchestrator-confirm]")!.textContent).toContain("Create orchestrator");
  /* Cancel sits in the draft, beside the primary, and takes the sheet down
     without creating anything. */
  const cancel = panel.querySelector("[data-orchestrator-draft-cancel]") as HTMLButtonElement;
  expect(cancel).not.toBeNull();
  expect(cancel.className).toContain("min-h-11");
  flushSync(() => cancel.click());
  await settle(root, view([conversation({})]), 2);
  expect(sheet(host)).toBeNull();
  expect(nav.getState().sheet).toBeNull();
  expect(seatPosts()).toHaveLength(0);
});

test("tapping the create row opens the fullscreen sheet with the prefilled mandate and the launch pickers", async () => {
  const { host, root } = await mount([conversation({})]);
  flushSync(() => openButton(host).click());
  await settle(root, view([conversation({})]), 2);

  const panel = sheet(host);
  expect(panel).not.toBeNull();
  expect(panel!.getAttribute("role")).toBe("dialog");
  expect(panel!.getAttribute("aria-modal")).toBe("true");
  /* Fullscreen, in this codebase's own sheet pattern. */
  expect(panel!.parentElement!.className).toContain("fixed inset-0");

  const mandate = panel!.querySelector("[data-orchestrator-mandate]") as HTMLTextAreaElement;
  expect(mandate.value).toBe(ORCHESTRATOR_SYSTEM_PROMPT);
  /* The SHARED launch module, not a mobile lookalike: engine radios, and the
     44px floor applied from outside it. */
  const engines = [...panel!.querySelectorAll('[role="radio"]')].map((node) => node.textContent);
  expect(engines).toEqual(["Claude", "Codex"]);
  const launchControls = panel!.querySelector('[role="radiogroup"]')!.closest("[class*='min-h-11']");
  expect(launchControls).not.toBeNull();
  expect((panel!.querySelector("[data-orchestrator-confirm]") as HTMLElement).className).toContain("min-h-11");
});

test("confirm posts the draft to the seat route — never to raw spawn — and carries one idempotency key", async () => {
  const { host, root } = await mount([conversation({})]);
  flushSync(() => openButton(host).click());
  await settle(root, view([conversation({})]), 2);

  const panel = sheet(host)!;
  const mandate = panel.querySelector("[data-orchestrator-mandate]") as HTMLTextAreaElement;
  type(mandate, "You own the Atlas board. Talk to me here.");
  flushSync(() => confirmButton(host).click());
  await settle(root, view([conversation({})]), 3);

  const posts = seatPosts();
  expect(posts).toHaveLength(1);
  expect(posts[0]!.url).toBe("/api/orchestrator/seat");
  expect(requests.some((request) => request.url.includes("/api/spawn"))).toBe(false);
  expect(posts[0]!.body.project).toBe("atlas");
  expect(posts[0]!.body.mandate).toBe("You own the Atlas board. Talk to me here.");
  expect(posts[0]!.body.engine).toBe("claude");
  /* The project's own newest checkout, resolved from the files — no cwd field
     on a phone. */
  expect(posts[0]!.body.cwd).toBe("/repo/atlas");
  /* An edited mandate is bespoke and records no version of the approved one. */
  expect(posts[0]!.body.promptVersion).toBeUndefined();
  expect(String(posts[0]!.body.clientRequestId)).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
});

test("a double tap posts once, and a retry after a lost reply replays the SAME key instead of designating twice", async () => {
  postSeat = async () => {
    throw new Error("network down");
  };
  const { host, root } = await mount([conversation({})]);
  flushSync(() => openButton(host).click());
  await settle(root, view([conversation({})]), 2);

  const confirm = () => confirmButton(host);
  /* Two taps inside one event batch: the synchronous in-flight guard is what
     keeps the second from designating a second orchestrator. */
  flushSync(() => {
    confirm().click();
    confirm().click();
  });
  await settle(root, view([conversation({})]), 3);
  const first = seatPosts();
  expect(first).toHaveLength(1);

  /* The reply was lost, so the outcome is unknown: the retry must replay the
     same durable intent, not mint a new one. */
  postSeat = async () => new Response(JSON.stringify({ ok: true, state: "starting" }), { status: 200, headers: { "content-type": "application/json" } });
  flushSync(() => confirm().click());
  await settle(root, view([conversation({})]), 3);
  const posts = seatPosts();
  expect(posts).toHaveLength(2);
  expect(posts[1]!.body.clientRequestId).toBe(posts[0]!.body.clientRequestId);
});

test("a truncated 2xx reply is not a confirmation: the key survives it and the retry replays the same intent", async () => {
  /* The phone's own failure: the request landed, the reply did not survive the
     ride back. A body that cannot be parsed says NOTHING about whether an
     orchestrator now exists, so accepting it — and releasing the key — is how
     the retry designates a second one. */
  postSeat = async () => new Response('{"ok": tr', { status: 200, headers: { "content-type": "application/json" } });
  const { host, root } = await mount([conversation({})]);
  flushSync(() => openButton(host).click());
  await settle(root, view([conversation({})]), 2);
  flushSync(() => (confirmButton(host)).click());
  await settle(root, view([conversation({})]), 3);

  const first = seatPosts();
  expect(first).toHaveLength(1);
  /* The durable intent is still on record, unchanged. */
  expect(dom.sessionStorage.getItem("llvOrchestratorDraft:atlas:requestId")).toBe(String(first[0]!.body.clientRequestId));
  /* And it is READ as unknown, not as a refusal: the sheet offers the retry
     that replays it rather than a fresh mandate. */
  expect(card(host).getAttribute("data-mobile2-seat-state")).toBe("intent-error");
  expect(sheet(host)!.querySelector("[data-orchestrator-intent-error]")!.textContent)
    .toContain("Trying again replays the same request");

  postSeat = async () => new Response(JSON.stringify({ ok: true, state: "starting" }), { status: 200, headers: { "content-type": "application/json" } });
  flushSync(() => (confirmButton(host)).click());
  await settle(root, view([conversation({})]), 3);
  const posts = seatPosts();
  expect(posts).toHaveLength(2);
  expect(posts[1]!.body.clientRequestId).toBe(posts[0]!.body.clientRequestId);
  /* A receipt this client can read is what finally releases it. */
  expect(dom.sessionStorage.getItem("llvOrchestratorDraft:atlas:requestId")).toBeNull();
});

test("a refused designation lands on the row and inside the sheet, with the error and a retry, without a reload", async () => {
  postSeat = async () => new Response(JSON.stringify({ error: "orchestrator cwd could not be resolved" }), { status: 400, headers: { "content-type": "application/json" } });
  const { host, root } = await mount([conversation({})]);
  flushSync(() => openButton(host).click());
  await settle(root, view([conversation({})]), 2);
  flushSync(() => (confirmButton(host)).click());
  await settle(root, view([conversation({})]), 3);

  expect(card(host).getAttribute("data-mobile2-seat-state")).toBe("intent-error");
  const failure = sheet(host)!.querySelector("[data-orchestrator-intent-error]");
  expect(failure).not.toBeNull();
  expect(failure!.textContent).toContain("orchestrator cwd could not be resolved");
  /* A terminal refusal releases the key: the corrected mandate must arrive
     under a fresh one, or the seat command completes the ORIGINAL intent. */
  flushSync(() => (confirmButton(host)).click());
  await settle(root, view([conversation({})]), 3);
  const posts = seatPosts();
  expect(posts).toHaveLength(2);
  expect(posts[1]!.body.clientRequestId).not.toBe(posts[0]!.body.clientRequestId);
});

test("a created seat hands the phone off from the sheet into the standard focus view, with its composer", async () => {
  const files = [conversation({}), orchestrator];
  const { host, root } = await mount(files);
  /* Default focus is the newer conversation, not the orchestrator. */
  expect(host.querySelector('[data-testid="mobile-focused-pane"] [data-link-path]')!.getAttribute("data-link-path")).toBe("/other.jsonl");

  flushSync(() => openButton(host).click());
  await settle(root, view(files), 2);
  postSeat = async () => {
    /* The designation landed: the next seat read reports the incumbent. */
    seatAnswer = { seat: seat(), pending: null, exists: true };
    return new Response(JSON.stringify({ ok: true, state: "starting" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  flushSync(() => (confirmButton(host)).click());
  await settle(root, view(files), 5);

  /* The sheet is gone and the phone is IN the conversation — the standard
     mobile surface, not a second chat inside the sheet. */
  expect(sheet(host)).toBeNull();
  expect(host.querySelector('[data-testid="mobile-focused-pane"] [data-link-path]')!.getAttribute("data-link-path")).toBe("/orchestrator.jsonl");
  expect(host.querySelector('[data-testid="bounded-mobile-composer"]')).not.toBeNull();
  expect(card(host).getAttribute("data-mobile2-seat-state")).toBe("live");
  expect(card(host).getAttribute("data-mobile2-seat-tap")).toBe("conversation");
  /* The unedited mandate records the approved prompt's version. */
  const post = seatPosts()[0]!;
  expect(post.body.mandate).toBe(ORCHESTRATOR_SYSTEM_PROMPT.trim());
  expect(post.body.promptVersion).toBeGreaterThan(0);
});

test("tapping a live seat opens its conversation in the standard conversation screen", async () => {
  seatAnswer = { seat: seat(), pending: null, exists: true };
  const files = [conversation({}), orchestrator];
  const { host, root } = await mount(files);
  expect(card(host).getAttribute("data-mobile2-seat-state")).toBe("live");
  expect(card(host).getAttribute("data-mobile2-seat-shape")).toBe("seat");
  expect(host.querySelector('[data-testid="mobile-focused-pane"] [data-link-path]')!.getAttribute("data-link-path")).toBe("/other.jsonl");

  flushSync(() => openButton(host).click());
  await settle(root, view(files), 2);
  expect(sheet(host)).toBeNull();
  expect(host.querySelector('[data-testid="mobile-focused-pane"] [data-link-path]')!.getAttribute("data-link-path")).toBe("/orchestrator.jsonl");
  expect(host.querySelector('[data-testid="bounded-mobile-composer"]')).not.toBeNull();
});

/*
 * What the seated card SAYS (README §4.1, §10 P2-3): «Orchestrator» with a
 * state badge, a now line in the agent's own words, and the context meter.
 * Account and plan are deliberately absent — they are one tap away in the
 * sheet, because a card that lists them says less about the thing the operator
 * opened the board to see.
 */
test("a seated card carries the state badge, the now line and a meter that fills with what REMAINS", async () => {
  seatAnswer = { seat: seat(), pending: null, exists: true };
  const working = {
    ...orchestrator,
    /* A turn that opened 2m 14s ago on the frozen board clock. */
    lastTurn: { startedAt: NOW * 1000 - 134_000, endedAt: null },
    plan: { current: "Reading the board first" },
    ctx: { pct: 24, usedTokens: 24_000, windowTokens: 100_000, source: "transcript", confidence: "exact" },
  } as unknown as FileEntry;
  const { host } = await mount([conversation({}), working]);

  expect(card(host).getAttribute("data-mobile2-seat-state")).toBe("live");
  expect(openButton(host).textContent).toContain("Orchestrator");
  /* The badge speaks the CONVERSATION's phrase, the same words the board's
     rows and the conversation's bar carry, so one seat never reads two ways —
     and it never truncates (2026-08 audit finding 17). */
  expect(badge(host)!.textContent).toBe("working 2:14");
  expect(badge(host)!.getAttribute("data-mobile2-seat-badge")).toBe("success");
  expect(badge(host)!.className).toContain("shrink-0");
  /* The now line: the plan step the agent published, never a guess. */
  const now = card(host).querySelector("[data-mobile2-seat-now]");
  expect(now!.textContent).toBe("Reading the board first");
  /* The meter fills with what is LEFT of the window — 24 % used is 76 % left. */
  expect(meter(host)!.getAttribute("aria-valuenow")).toBe("76");
  expect(meter(host)!.getAttribute("data-mobile2-meter-tone")).toBe("accent");
  expect(meter(host)!.querySelector("[data-mobile2-meter-fill]")!.getAttribute("style")).toContain("76%");
  /* Account and plan are the sheet's (README §10 P2-3). */
  expect(card(host).textContent).not.toContain("Max plan");
});

test("the seat's ⚙ opens the seat as a BOTTOM sheet — account · plan, the context left, the predecessor, the mandate", async () => {
  seatAnswer = { seat: seat({ predecessorConversationId: "conv_predecessor" }), pending: null, exists: true };
  const live = { ...orchestrator, ctx: { pct: 24, usedTokens: 24_000, windowTokens: 100_000, source: "transcript", confidence: "exact" } } as unknown as FileEntry;
  const files = [conversation({}), live];
  const { host, root } = await mount(files);

  const controls = host.querySelector("[data-mobile2-seat-controls]") as HTMLButtonElement;
  expect(controls).not.toBeNull();
  expect(controls.className).toContain("h-11");
  expect(controls.getAttribute("data-mobile2-open")).toBe("seat");
  flushSync(() => controls.click());
  await settle(root, view(files), 3);

  /* A bottom sheet, over the board: the shell's own primitive, so the scrim,
     the grab handle and the drag-to-close come from one place (§3.3, §5). */
  const bottom = host.querySelector('[data-mobile2-sheet="seat"]') as HTMLElement;
  expect(bottom).not.toBeNull();
  expect(bottom.getAttribute("role")).toBe("dialog");
  expect(bottom.getAttribute("aria-modal")).toBe("true");
  expect(bottom.className).toContain("max-h-[88%]");
  expect(bottom.previousElementSibling ?? bottom.parentElement!.querySelector("[data-mobile2-grab]")).not.toBeNull();

  const panel = sheet(host)!;
  expect(panel.getAttribute("data-orchestrator-sheet-mode")).toBe("live");
  const identity = panel.querySelector("[data-orchestrator-incumbent]") as HTMLElement;
  /* Account · plan belong HERE, and the model reads at its tier. */
  expect(identity.textContent).toContain("opus");
  /* Context, as what remains, with the window it is a share of. */
  const context = panel.querySelector("[data-mobile2-seat-context]") as HTMLElement;
  expect(context.getAttribute("data-mobile2-seat-context")).toBe("76");
  expect(context.textContent).toContain("76% left of 100K");
  expect(context.querySelector("[data-mobile2-meter]")!.getAttribute("aria-valuenow")).toBe("76");
  /* The lineage, as a row that opens it. */
  const predecessor = panel.querySelector('[data-orchestrator-predecessor="conv_predecessor"]') as HTMLElement;
  expect(predecessor.textContent).toContain("Predecessor");
  expect(predecessor.textContent).toContain("open");
  expect(predecessor.className).toContain("min-h-11");
  /* The rules it runs under, and the row that changes them — which says what
     changing them costs. */
  expect(panel.querySelector("[data-orchestrator-mandate-preview]")!.textContent).toContain("You run the Atlas board.");
  const edit = panel.querySelector("[data-orchestrator-edit-mandate]") as HTMLButtonElement;
  expect(edit.textContent).toContain("Edit the mandate");
  expect(edit.textContent).toContain("replaces the orchestrator");
  expect(panel.textContent).toContain("Changing the mandate, model or account means a successor takes the seat.");
  /* No working-dir row: the checkout is host detail (README §10 P2-12). */
  expect(panel.textContent).not.toContain("/repo/atlas");
  /* And the two controls that ACT sit at the thumb, outside the scroller. */
  const footer = bottom.querySelector("[data-orchestrator-rotate]")!.parentElement!;
  expect(footer.contains(panel)).toBe(false);
  expect((bottom.querySelector("[data-orchestrator-confirm]") as HTMLElement).textContent).toContain("Open conversation");
});

/*
 * The mandate block's heading NAMES the rules the seat is running under — the
 * approved picture reads «Mandate v3 — built-in operating rules» over a faded
 * three-line preview (`prototype/app.js`, `seatSheet()`), and the two cases the
 * picture has no seat for say what they are instead: rules the operator wrote,
 * and rules the product has since moved on from. The evidence frames render a
 * seat on the CURRENT version, so this is where the other two are asserted.
 */
test("the mandate heading names which rules the seat runs under, and the preview folds to three lines", async () => {
  const files = [conversation({}), orchestrator];
  const open = async () => {
    const { host, root } = await mount(files);
    flushSync(() => (host.querySelector("[data-mobile2-seat-controls]") as HTMLButtonElement).click());
    await settle(root, view(files), 3);
    return sheet(host)!.querySelector("[data-orchestrator-mandate-view]") as HTMLElement;
  };

  /* The built-in rules, at the version the product ships today. */
  seatAnswer = { seat: seat({ promptVersion: ORCHESTRATOR_PROMPT_VERSION }), pending: null, exists: true };
  const current = await open();
  expect(current.textContent).toContain(`Mandate v${ORCHESTRATOR_PROMPT_VERSION} — built-in operating rules`);
  /* Faded, three lines, and it expands in place rather than pushing the two
     controls at the thumb off the sheet. */
  const preview = current.querySelector("[data-orchestrator-mandate-preview]") as HTMLButtonElement;
  expect(current.getAttribute("data-orchestrator-mandate-view")).toBe("preview");
  expect(preview.getAttribute("aria-expanded")).toBe("false");
  expect(preview.firstElementChild!.className).toContain("line-clamp-3");
  expect(preview.textContent).toContain("You run the Atlas board.");

  /* Rules the operator wrote: no version to name, so the heading says whose. */
  seatAnswer = { seat: seat({ promptVersion: null }), pending: null, exists: true };
  expect((await open()).textContent).toContain("Mandate — your own rules");

  /* Rules the product has moved past: the heading carries BOTH numbers, which
     is what tells the operator a rotation would change more than the model. */
  seatAnswer = { seat: seat({ promptVersion: 4 }), pending: null, exists: true };
  expect((await open()).textContent).toContain(`Mandate v4 — the current default is v${ORCHESTRATOR_PROMPT_VERSION}`);
});

test("the mandate preview expands in place, and folds back", async () => {
  seatAnswer = { seat: seat({ promptVersion: ORCHESTRATOR_PROMPT_VERSION }), pending: null, exists: true };
  const files = [conversation({}), orchestrator];
  const { host, root } = await mount(files);
  flushSync(() => (host.querySelector("[data-mobile2-seat-controls]") as HTMLButtonElement).click());
  await settle(root, view(files), 3);

  const block = sheet(host)!.querySelector("[data-orchestrator-mandate-view]") as HTMLElement;
  const preview = block.querySelector("[data-orchestrator-mandate-preview]") as HTMLButtonElement;
  flushSync(() => preview.click());
  await settle(root, view(files), 2);
  expect(block.getAttribute("data-orchestrator-mandate-view")).toBe("expanded");
  expect(preview.getAttribute("aria-expanded")).toBe("true");
  /* Expanded it scrolls itself, so the sheet's own height — and the footer
     inside it — is unmoved by a long mandate. */
  expect(preview.firstElementChild!.className).toContain("overflow-y-auto");
  expect(preview.firstElementChild!.className).not.toContain("line-clamp-3");

  flushSync(() => preview.click());
  await settle(root, view(files), 2);
  expect(block.getAttribute("data-orchestrator-mandate-view")).toBe("preview");
});

/*
 * One seat, one phrase. The approved picture gives the board's seat card and
 * the sheet behind it the SAME state phrase (`prototype/app.js`: `seatCard()`
 * and `seatSheet()` both render `st.phrase` off the seat's conversation), so a
 * seat that reads «working 2:14» on the board cannot read «live» one tap
 * later. Both surfaces take it from `seatBadgeReading`.
 */
test("the sheet's badge speaks the phrase the card speaks, not a second word for the same seat", async () => {
  seatAnswer = { seat: seat(), pending: null, exists: true };
  const working = {
    ...orchestrator,
    lastTurn: { startedAt: NOW * 1000 - 134_000, endedAt: null },
  } as unknown as FileEntry;
  const files = [conversation({}), working];
  const { host, root } = await mount(files);

  expect(badge(host)!.textContent).toBe("working 2:14");
  expect(badge(host)!.getAttribute("data-mobile2-seat-badge")).toBe("success");

  flushSync(() => (host.querySelector("[data-mobile2-seat-controls]") as HTMLButtonElement).click());
  await settle(root, view(files), 3);

  const identity = sheet(host)!.querySelector("[data-orchestrator-incumbent]") as HTMLElement;
  const inSheet = identity.querySelector("[data-mobile2-seat-badge]") as HTMLElement;
  expect(inSheet.textContent).toBe("working 2:14");
  expect(inSheet.getAttribute("data-mobile2-seat-badge")).toBe("success");
});

test("the seat's own state moves the row with no reload: rotation advisory, then a retired conversation", async () => {
  seatAnswer = { seat: seat(), pending: null, exists: true };
  const files = [conversation({}), orchestrator];
  const { host, rerender } = await mount(files);
  expect(card(host).getAttribute("data-mobile2-seat-state")).toBe("live");
  expect(card(host).hasAttribute("data-mobile2-seat-rotation")).toBe(false);

  /* The context reading crosses the rotation line — same mount, same row. */
  await rerender([conversation({}), { ...orchestrator, ctx: { pct: 71 } } as unknown as FileEntry]);
  expect(card(host).getAttribute("data-mobile2-seat-rotation")).toBe("strongly_recommend");
  expect(card(host).getAttribute("data-mobile2-seat-state")).toBe("live");

  /* The seat's conversation is retired: the row says the host is gone. */
  await rerender([conversation({}), { ...orchestrator, supersededBy: "conv_successor" } as unknown as FileEntry]);
  expect(card(host).getAttribute("data-mobile2-seat-state")).toBe("dead");
});

test("a designation failing ALONGSIDE a live incumbent gets its own control, and never takes the chat away", async () => {
  seatAnswer = {
    seat: seat(),
    pending: seat({ conversationId: null, state: "pending", activatedAt: null, intent: { clientRequestId: "seatreq-0009", mode: "spawn", launchId: null, error: "the successor never started" } }),
    exists: true,
  };
  const files = [conversation({}), orchestrator];
  const { host, root } = await mount(files);
  expect(card(host).getAttribute("data-mobile2-seat-transition")).toBe("error");
  /* The row itself still opens the conversation. */
  expect(card(host).getAttribute("data-mobile2-seat-tap")).toBe("conversation");

  const marker = host.querySelector("[data-mobile2-seat-transition-open]") as HTMLButtonElement;
  expect(marker).not.toBeNull();
  expect(marker.className).toContain("h-11");
  flushSync(() => marker.click());
  await settle(root, view(files), 2);
  const panel = sheet(host)!;
  expect(panel.querySelector("[data-orchestrator-intent-error]")!.textContent).toContain("the successor never started");
  /* Opened deliberately on a live seat: it must NOT hand off and close itself. */
  expect(sheet(host)).not.toBeNull();
});

/* A minimal visualViewport stand-in — happy-dom has none, and the keyboard is
   the only thing that shrinks it (#983's signal, `useKeyboardInset`). */
function makeVisualViewport(height: number) {
  const listeners = new Set<() => void>();
  return {
    height, scale: 1, offsetTop: 0,
    addEventListener(type: string, cb: () => void) { if (type === "resize") listeners.add(cb); },
    removeEventListener(type: string, cb: () => void) { if (type === "resize") listeners.delete(cb); },
    resizeTo(next: number) {
      this.height = next;
      for (const cb of [...listeners]) cb();
    },
  };
}

test("the keyboard opening on the focused mandate brings the field into the scroller — once (#1004)", async () => {
  const vv = makeVisualViewport(844);
  (dom as unknown as Record<string, unknown>).visualViewport = vv;
  (globalThis as Record<string, unknown>).visualViewport = vv;
  try {
    const files = [conversation({})];
    const { host, root } = await mount(files);
    flushSync(() => openButton(host).click());
    await settle(root, view(files), 2);

    const field = sheet(host)!.querySelector("[data-orchestrator-mandate]") as HTMLTextAreaElement;
    /* The block that carries the label, not the bare textarea: happy-dom does
       no layout, so what is asserted is WHICH element is revealed and how
       often — the geometry itself is the capture script's gate. */
    const block = field.parentElement as HTMLElement & { scrollIntoView: (options?: unknown) => void };
    const reveals: unknown[] = [];
    block.scrollIntoView = (options?: unknown) => { reveals.push(options); };

    /* Focus alone, keyboard still closed: nothing moves. */
    flushSync(() => field.focus());
    await settle(root, view(files), 2);
    expect(reveals).toHaveLength(0);

    /* The keyboard opens under the already-focused field — the tap order a
       phone actually produces. */
    flushSync(() => vv.resizeTo(508));
    await settle(root, view(files), 2);
    expect(reveals).toEqual([{ block: "start" }]);

    /* And it stays revealed exactly once: a keyboard that resizes again (an
       autocorrect bar, a rotation) must not yank a scroller the operator has
       since moved themselves. */
    flushSync(() => vv.resizeTo(468));
    await settle(root, view(files), 2);
    expect(reveals).toHaveLength(1);
  } finally {
    delete (dom as unknown as Record<string, unknown>).visualViewport;
    delete (globalThis as Record<string, unknown>).visualViewport;
  }
});

test("an unreadable seat offers a re-read that recovers the row without a page reload", async () => {
  const failing = new Response("", { status: 500 });
  void failing;
  seatAnswer = { seat: null, pending: null, exists: true };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/orchestrator/seat") && (init?.method ?? "GET") === "GET" && seatAnswer.seat === null) {
      requests.push({ url, method: "GET", body: {} });
      return new Response("", { status: 500 });
    }
    return previousFetch(input, init);
  }) as typeof fetch;
  try {
    const files = [conversation({}), orchestrator];
    const { host, root } = await mount(files);
    expect(card(host).getAttribute("data-mobile2-seat-state")).toBe("unavailable");

    flushSync(() => openButton(host).click());
    await settle(root, view(files), 2);
    /* The seat becomes readable — the re-read is the operator's way through,
       and it lands them in the conversation it finds. */
    seatAnswer = { seat: seat(), pending: null, exists: true };
    flushSync(() => (confirmButton(host)).click());
    await settle(root, view(files), 4);
    expect(card(host).getAttribute("data-mobile2-seat-state")).toBe("live");
    expect(seatPosts()).toHaveLength(0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});


test("missing-catalog board card offers Re-bind after 10s and clears only when the catalog read delivers its file", async () => {
  seatAnswer = { seat: seat(), pending: null, exists: true };
  incumbentAnswer = { project: "atlas", designated: true, conversationId: "conv_orchestrator", engine: "claude", model: "opus", liveness: { hostState: "alive", lifecycle: "running" } };
  // The board-card host, without mounting a conversation screen behind it.
  const cardView = (files: FileEntry[]) => <MobileNavContext.Provider value={nav}>
    <MobileSeatCard project="atlas" projectName="Atlas" files={files} now={NOW} onOpenConversation={() => { throw new Error("unexpected navigation"); }} />
  </MobileNavContext.Provider>;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(cardView([])));
  await settle(root, cardView([]));
  const rerender = async (files: FileEntry[]) => {
    flushSync(() => root.render(cardView(files)));
    await settle(root, cardView(files));
  };
  flushSync(() => openButton(host).click());
  await settle(root, cardView([]));
  const rebind = () => host.querySelector<HTMLButtonElement>("[data-orchestrator-rebind]");
  expect(sheet(host)).not.toBeNull();
  expect(rebind()).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 10_050));
  await settle(root, cardView([]));
  expect(host.querySelector('[data-orchestrator-bind-failure="catalog"]')).not.toBeNull();
  expect(rebind()!.className).toContain("min-h-11");
  const storageBefore = dom.localStorage.length;
  const before = requests.length;
  let catalogReads = 0;
  let deliver = false;
  const refreshCatalog = () => {
    catalogReads += 1;
    if (deliver) void rerender([orchestrator]);
  };
  dom.addEventListener(FILES_CHANGED_EVENT, refreshCatalog);
  try {
    flushSync(() => rebind()!.click());
    await settle(root, cardView([]));
    expect(rebind()).not.toBeNull(); // Callback completion cannot clear the fault.
    deliver = true;
    flushSync(() => rebind()!.click());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(rebind()).toBeNull();
    expect(sheet(host)).not.toBeNull();
    expect(nav.getState().sheet).toBe("seat");
    expect(catalogReads).toBe(2);
    expect(runtimeRefreshes).toBe(2);
    const reads = requests.slice(before);
    expect(reads.filter((r) => r.url.startsWith("/api/orchestrator/seat/status")).length).toBeGreaterThanOrEqual(2);
    expect(reads.filter((r) => r.url.startsWith("/api/orchestrator/seat?")).length).toBeGreaterThanOrEqual(2);
    expect(reads.every((r) => r.method === "GET")).toBe(true);
    expect(dom.localStorage.length).toBe(storageBefore);
  } finally {
    dom.removeEventListener(FILES_CHANGED_EVENT, refreshCatalog);
  }
}, 15_000);
