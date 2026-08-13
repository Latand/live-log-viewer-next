import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { ORCHESTRATOR_SYSTEM_PROMPT } from "@/lib/orchestrator/prompt";
import type { FileEntry } from "@/lib/types";

/*
 * The phone's pinned orchestrator row and its fullscreen create sheet (issue
 * #979), against the REAL `MobileFocusView` at 390×844 — the same wrapper the
 * operator's phone mounts, so the row's position in the conversation strip, the
 * handoff into the focused pane, and the idempotency of a confirm are asserted
 * where they actually happen rather than on an isolated component.
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
}));
mock.module("@/hooks/useLogTail", () => ({
  useLogTail: () => ({
    lines: [], linesStart: 0, size: 0, loading: false, error: null, tickTime: null,
    paused: false, setPaused: () => undefined, clear: () => undefined,
    hasMore: false, loadingOlder: false, loadOlder: async () => 0, prependGen: 0,
  }),
}));

const { MobileFocusView } = await import("./MobileFocusView");

interface SeatAnswer { seat: unknown; pending: unknown; exists: boolean }
interface Recorded { url: string; method: string; body: Record<string, unknown> }

let seatAnswer: SeatAnswer = { seat: null, pending: null, exists: true };
let postSeat: (body: Record<string, unknown>) => Promise<Response> = async () =>
  new Response(JSON.stringify({ ok: true, state: "starting" }), { status: 200, headers: { "content-type": "application/json" } });
const requests: Recorded[] = [];
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  requests.push({ url, method, body });
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

const view = (files: FileEntry[]) => (
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
    focus={null}
    onSelect={() => undefined}
    onClose={() => undefined}
    onDraftClose={() => undefined}
    onDraftSpawned={() => undefined}
  />
);

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

const row = (host: HTMLElement) => host.querySelector("[data-orchestrator-row]") as HTMLElement;
const openButton = (host: HTMLElement) => host.querySelector("[data-orchestrator-row-open]") as HTMLButtonElement;
const sheet = (host: HTMLElement) => host.querySelector('[data-testid="mobile-orchestrator-sheet"]') as HTMLElement | null;
/* Only the seat route: the mounted pane posts its own tmux target reads. */
const seatPosts = () => requests.filter((request) => request.method === "POST" && request.url === "/api/orchestrator/seat");

test("the row is pinned first in the conversation strip, outside the scroller that could carry it off screen", async () => {
  const { host } = await mount([conversation({}), orchestrator]);
  const pinned = row(host);
  expect(pinned).not.toBeNull();
  expect(pinned.getAttribute("data-orchestrator-row-state")).toBe("draft");
  expect(openButton(host).textContent).toContain("Create orchestrator");

  /* First in the strip row, and before every conversation chip in document
     order — the whole point of the pin. */
  const strip = pinned.parentElement!;
  expect(strip.firstElementChild).toBe(pinned);
  const chips = [...strip.querySelectorAll(".overflow-x-auto button")];
  expect(chips.length).toBeGreaterThan(0);
  for (const chip of chips) {
    expect(pinned.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  /* Not INSIDE the horizontal scroller: a pinned row that scrolls away with the
     chips is not pinned. */
  expect(pinned.closest(".overflow-x-auto")).toBeNull();
  /* Phone tap target. */
  expect(openButton(host).className).toContain("h-11");
});

/* A board with no conversation of its own — the project is on screen for a
   draft, a task or a running pipeline — still gets the pin. The OTHER empty
   phone leaf, the project shell's own «nothing here yet» branch, never mounts
   this view at all: `ProjectDashboard` chooses between the focus view, the
   catalog list and that empty state, and it is outside this lane's files. */
test("a strip with no conversation chips at all still shows the row", async () => {
  const { host } = await mount([]);
  expect(row(host)).not.toBeNull();
  expect(row(host).getAttribute("data-orchestrator-row-state")).toBe("draft");
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
  flushSync(() => (panel.querySelector("[data-orchestrator-confirm]") as HTMLButtonElement).click());
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

  const confirm = () => sheet(host)!.querySelector("[data-orchestrator-confirm]") as HTMLButtonElement;
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
  flushSync(() => (sheet(host)!.querySelector("[data-orchestrator-confirm]") as HTMLButtonElement).click());
  await settle(root, view([conversation({})]), 3);

  const first = seatPosts();
  expect(first).toHaveLength(1);
  /* The durable intent is still on record, unchanged. */
  expect(dom.sessionStorage.getItem("llvOrchestratorDraft:atlas:requestId")).toBe(String(first[0]!.body.clientRequestId));
  /* And it is READ as unknown, not as a refusal: the sheet offers the retry
     that replays it rather than a fresh mandate. */
  expect(row(host).getAttribute("data-orchestrator-row-state")).toBe("intent-error");
  expect(sheet(host)!.querySelector("[data-orchestrator-intent-error]")!.textContent)
    .toContain("Trying again replays the same request");

  postSeat = async () => new Response(JSON.stringify({ ok: true, state: "starting" }), { status: 200, headers: { "content-type": "application/json" } });
  flushSync(() => (sheet(host)!.querySelector("[data-orchestrator-confirm]") as HTMLButtonElement).click());
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
  flushSync(() => (sheet(host)!.querySelector("[data-orchestrator-confirm]") as HTMLButtonElement).click());
  await settle(root, view([conversation({})]), 3);

  expect(row(host).getAttribute("data-orchestrator-row-state")).toBe("intent-error");
  const failure = sheet(host)!.querySelector("[data-orchestrator-intent-error]");
  expect(failure).not.toBeNull();
  expect(failure!.textContent).toContain("orchestrator cwd could not be resolved");
  /* A terminal refusal releases the key: the corrected mandate must arrive
     under a fresh one, or the seat command completes the ORIGINAL intent. */
  flushSync(() => (sheet(host)!.querySelector("[data-orchestrator-confirm]") as HTMLButtonElement).click());
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
  flushSync(() => (sheet(host)!.querySelector("[data-orchestrator-confirm]") as HTMLButtonElement).click());
  await settle(root, view(files), 5);

  /* The sheet is gone and the phone is IN the conversation — the standard
     mobile surface, not a second chat inside the sheet. */
  expect(sheet(host)).toBeNull();
  expect(host.querySelector('[data-testid="mobile-focused-pane"] [data-link-path]')!.getAttribute("data-link-path")).toBe("/orchestrator.jsonl");
  expect(host.querySelector('[data-testid="bounded-mobile-composer"]')).not.toBeNull();
  expect(row(host).getAttribute("data-orchestrator-row-state")).toBe("live");
  expect(row(host).getAttribute("data-orchestrator-row-tap")).toBe("conversation");
  /* The unedited mandate records the approved prompt's version. */
  const post = seatPosts()[0]!;
  expect(post.body.mandate).toBe(ORCHESTRATOR_SYSTEM_PROMPT.trim());
  expect(post.body.promptVersion).toBeGreaterThan(0);
});

test("tapping a live row opens the seat's conversation in the focus view", async () => {
  seatAnswer = { seat: seat(), pending: null, exists: true };
  const files = [conversation({}), orchestrator];
  const { host, root } = await mount(files);
  expect(row(host).getAttribute("data-orchestrator-row-state")).toBe("live");
  /* The incumbent badge: the model it runs on. */
  expect(openButton(host).textContent).toContain("opus");
  expect(host.querySelector('[data-testid="mobile-focused-pane"] [data-link-path]')!.getAttribute("data-link-path")).toBe("/other.jsonl");

  flushSync(() => openButton(host).click());
  await settle(root, view(files), 2);
  expect(sheet(host)).toBeNull();
  expect(host.querySelector('[data-testid="mobile-focused-pane"] [data-link-path]')!.getAttribute("data-link-path")).toBe("/orchestrator.jsonl");
  expect(host.querySelector('[data-testid="bounded-mobile-composer"]')).not.toBeNull();
});

test("the seat's own state moves the row with no reload: rotation advisory, then a retired conversation", async () => {
  seatAnswer = { seat: seat(), pending: null, exists: true };
  const files = [conversation({}), orchestrator];
  const { host, rerender } = await mount(files);
  expect(row(host).getAttribute("data-orchestrator-row-state")).toBe("live");
  expect(row(host).hasAttribute("data-orchestrator-row-rotation")).toBe(false);

  /* The context reading crosses the rotation line — same mount, same row. */
  await rerender([conversation({}), { ...orchestrator, ctx: { pct: 71 } } as unknown as FileEntry]);
  expect(row(host).getAttribute("data-orchestrator-row-rotation")).toBe("strongly_recommend");
  expect(row(host).getAttribute("data-orchestrator-row-state")).toBe("live");

  /* The seat's conversation is retired: the row says the host is gone. */
  await rerender([conversation({}), { ...orchestrator, supersededBy: "conv_successor" } as unknown as FileEntry]);
  expect(row(host).getAttribute("data-orchestrator-row-state")).toBe("dead");
});

test("a designation failing ALONGSIDE a live incumbent gets its own control, and never takes the chat away", async () => {
  seatAnswer = {
    seat: seat(),
    pending: seat({ conversationId: null, state: "pending", activatedAt: null, intent: { clientRequestId: "seatreq-0009", mode: "spawn", launchId: null, error: "the successor never started" } }),
    exists: true,
  };
  const files = [conversation({}), orchestrator];
  const { host, root } = await mount(files);
  expect(row(host).getAttribute("data-orchestrator-row-transition")).toBe("error");
  /* The row itself still opens the conversation. */
  expect(row(host).getAttribute("data-orchestrator-row-tap")).toBe("conversation");

  const marker = host.querySelector("[data-orchestrator-row-transition-open]") as HTMLButtonElement;
  expect(marker).not.toBeNull();
  expect(marker.className).toContain("h-11");
  flushSync(() => marker.click());
  await settle(root, view(files), 2);
  const panel = sheet(host)!;
  expect(panel.querySelector("[data-orchestrator-intent-error]")!.textContent).toContain("the successor never started");
  /* Opened deliberately on a live seat: it must NOT hand off and close itself. */
  expect(sheet(host)).not.toBeNull();
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
    expect(row(host).getAttribute("data-orchestrator-row-state")).toBe("unavailable");

    flushSync(() => openButton(host).click());
    await settle(root, view(files), 2);
    /* The seat becomes readable — the re-read is the operator's way through,
       and it lands them in the conversation it finds. */
    seatAnswer = { seat: seat(), pending: null, exists: true };
    flushSync(() => (sheet(host)!.querySelector("[data-orchestrator-confirm]") as HTMLButtonElement).click());
    await settle(root, view(files), 4);
    expect(row(host).getAttribute("data-orchestrator-row-state")).toBe("live");
    expect(seatPosts()).toHaveLength(0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
