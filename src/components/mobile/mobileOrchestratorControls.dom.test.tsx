import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { ORCHESTRATOR_PROMPT_VERSION, ORCHESTRATOR_SYSTEM_PROMPT } from "@/lib/orchestrator/prompt";
import type { FileEntry } from "@/lib/types";

/*
 * The phone's orchestrator CONTROLS (issue #1347), against the REAL
 * `MobileFocusView` at 390×844.
 *
 * The desktop dock's incumbent header carries the seat's identity and the one
 * control that acts on it — Rotate, which opens the seat's own configuration
 * (engine, model, reasoning, account, mandate) prefilled from the incumbent.
 * The phone had none of it: a live seat's pinned row opened the conversation
 * and nothing else, so an operator on a phone could not find where rotation
 * lived. Every claim here is about the phone's surface: the entry point is
 * VISIBLE on the row (not a hidden overflow), the sheet names the incumbent,
 * Rotate opens the same prefilled draft, confirm goes to the ROTATE route
 * exactly once per submission, and a landed rotation lands the phone in the
 * successor's conversation.
 */

const dom = new HappyWindow({ innerWidth: 390, innerHeight: 844 });
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
  HTMLSelectElement: dom.HTMLSelectElement, HTMLTextAreaElement: dom.HTMLTextAreaElement,
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
  useRuntimeBusState: () => ({ enabled: false, connection: "live", resyncedAt: null, lastEventAt: null, store: emptyStore() }),
  useRuntime: () => ({ enabled: false, connection: "live", resyncedAt: null, store: emptyStore() }),
  useRuntimeEnabled: () => false,
  useRuntimeSession: () => null,
  useRuntimeSessionByArtifact: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
  refreshRuntime: () => Promise.resolve(false),
}));
mock.module("@/hooks/useLogTail", () => ({
  useLogTail: () => ({
    lines: [], linesStart: 0, size: 0, loading: false, error: null, tickTime: null,
    paused: false, setPaused: () => undefined, clear: () => undefined,
    hasMore: false, loadingOlder: false, loadOlder: async () => 0, prependGen: 0,
  }),
}));

const { MobileFocusView } = await import("./MobileFocusView");
const { resetOrchestratorSeatCacheForTests } = await import("../orchestrator/useOrchestratorSeat");
const { resetOrchestratorIncumbentCacheForTests } = await import("../orchestrator/useOrchestratorIncumbent");

interface SeatAnswer { seat: unknown; pending: unknown; exists: boolean }
interface Recorded { url: string; method: string; body: Record<string, unknown> }

let seatAnswer: SeatAnswer;
let incumbentAnswer: Record<string, unknown>;
let postRotate: (body: Record<string, unknown>) => Promise<Response>;
const requests: Recorded[] = [];
const realFetch = globalThis.fetch;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const accounts = {
  claude: { active: "primary", accounts: [{ id: "primary", label: "primary", authPresent: true }, { id: "spare", label: "spare", authPresent: true }] },
  codex: { active: "codex-primary", accounts: [{ id: "codex-primary", label: "codex-primary", authPresent: true }] },
};

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  requests.push({ url, method, body });
  if (url.startsWith("/api/orchestrator/rotate") && method === "POST") return postRotate(body);
  if (url.startsWith("/api/orchestrator/seat/status")) return json(incumbentAnswer);
  if (url.startsWith("/api/orchestrator/seat")) return json(seatAnswer);
  if (url.startsWith("/api/accounts")) return json(accounts);
  return json({});
}) as typeof fetch;

const roots = new Set<Root>();
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  resetOrchestratorSeatCacheForTests();
  resetOrchestratorIncumbentCacheForTests();
  requests.length = 0;
  seatAnswer = { seat: seat(), pending: null, exists: true };
  incumbentAnswer = incumbent();
  postRotate = async () => json({
    ok: true, accepted: true, state: "accepted", conversationId: "conv_successor", launchId: "launch-b",
    transport: "structured", initialMessage: "pending", seat: seat({ conversationId: "conv_successor", path: "/successor.jsonl", predecessorConversationId: "conv_orchestrator" }),
  }, 202);
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
const successor = conversation({
  path: "/successor.jsonl", name: "successor.jsonl", title: "Run the Atlas board (successor)",
  conversationId: "conv_successor", model: "opus", mtime: 200, pid: 9,
});

function seat(over: Record<string, unknown> = {}) {
  return {
    project: "atlas", seatEpoch: 4, conversationId: "conv_orchestrator", path: "/orchestrator.jsonl",
    mandate: "You run the Atlas board.", promptVersion: 3, predecessorConversationId: "conv_predecessor", state: "active",
    intent: { clientRequestId: "seatreq-0001", mode: "spawn", launchId: "launch-0001", error: null },
    designatedAt: "2100-01-02T11:00:00.000Z", activatedAt: "2100-01-02T11:00:02.000Z",
    ...over,
  };
}

/** `GET /api/orchestrator/seat/status`: the incumbent as the server reads it. */
function incumbent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: "atlas", designated: true, conversationId: "conv_orchestrator", predecessorConversationId: "conv_predecessor",
    engine: "claude", model: "opus", effort: "high", accountId: "spare", cwd: "/repo/atlas/worktrees/board",
    transcriptPath: "/orchestrator.jsonl",
    liveness: { lifecycle: "running", hostState: "alive", silentForMs: 0 },
    context: { tokens: 24_000, limit: 100_000, percent: 24, estimated: false, basis: "provider-reported usage" },
    transcriptFacts: { bytes: 4_096, messageCount: 12, toolCount: 3, compactionCount: 0 },
    rotation: { recommended: false, level: "none", reasons: [], thresholdUnknown: false },
    ...over,
  };
}

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

/* A controlled field, typed through its own React props — see the #979 suite. */
function type(field: HTMLTextAreaElement, value: string): void {
  const key = Object.keys(field).find((name) => name.startsWith("__reactProps$"))!;
  const props = (field as unknown as Record<string, { onChange(event: unknown): void }>)[key]!;
  field.value = value;
  flushSync(() => props.onChange({ target: field }));
}

const row = (host: HTMLElement) => host.querySelector("[data-orchestrator-row]") as HTMLElement;
const openButton = (host: HTMLElement) => host.querySelector("[data-orchestrator-row-open]") as HTMLButtonElement;
const controlsButton = (host: HTMLElement) => host.querySelector("[data-orchestrator-row-controls]") as HTMLButtonElement | null;
const sheet = (host: HTMLElement) => host.querySelector('[data-testid="mobile-orchestrator-sheet"]') as HTMLElement | null;
const rotateButton = (host: HTMLElement) => sheet(host)?.querySelector("[data-orchestrator-rotate]") as HTMLButtonElement | null;
const confirmButton = (host: HTMLElement) => sheet(host)!.querySelector("[data-orchestrator-confirm]") as HTMLButtonElement;
const rotatePosts = () => requests.filter((request) => request.method === "POST" && request.url.startsWith("/api/orchestrator/rotate"));
const seatPosts = () => requests.filter((request) => request.method === "POST" && request.url === "/api/orchestrator/seat");
const focusedPath = (host: HTMLElement) =>
  host.querySelector('[data-testid="mobile-focused-pane"] [data-link-path]')?.getAttribute("data-link-path") ?? null;

/** Open the sheet from the row's controls entry point, and wait for the
    incumbent read the sheet asks for. */
async function openControls(host: HTMLElement, root: Root, files: FileEntry[]): Promise<HTMLElement> {
  const entry = controlsButton(host);
  expect(entry).not.toBeNull();
  flushSync(() => entry!.click());
  await settle(root, view(files), 4);
  const panel = sheet(host);
  expect(panel).not.toBeNull();
  return panel!;
}

/** Press Rotate and wait out the incumbent re-read the press starts. */
async function openRotate(host: HTMLElement, root: Root, files: FileEntry[]): Promise<void> {
  const rotate = rotateButton(host);
  expect(rotate).not.toBeNull();
  flushSync(() => rotate!.click());
  await settle(root, view(files), 5);
}

test("a live seat's pinned row carries a VISIBLE controls entry point beside the chip, at a phone tap target", async () => {
  const files = [conversation({}), orchestrator];
  const { host } = await mount(files);
  expect(row(host).getAttribute("data-orchestrator-row-state")).toBe("live");
  /* The row's own tap still opens the conversation (#979's decision)… */
  expect(row(host).getAttribute("data-orchestrator-row-tap")).toBe("conversation");

  /* …and the controls are a SECOND, always-rendered target right beside it —
     not a long-press, not a menu, not an overflow that touch never reveals. */
  const entry = controlsButton(host);
  expect(entry).not.toBeNull();
  expect(entry!.className).toContain("h-11");
  expect(entry!.className).toContain("w-11");
  expect(entry!.getAttribute("aria-haspopup")).toBe("dialog");
  const aria = entry!.getAttribute("aria-label") ?? "";
  expect(aria.toLowerCase()).toContain("rotate");
  /* Inside the pinned slot, so it can never scroll away with the chip strip. */
  expect(entry!.closest("[data-orchestrator-row]")).toBe(row(host));
  expect(entry!.closest(".overflow-x-auto")).toBeNull();
});

test("the controls sheet names the incumbent the way the desktop header does, shows its mandate, and offers Rotate", async () => {
  const files = [conversation({}), orchestrator];
  const { host, root } = await mount(files);
  const panel = await openControls(host, root, files);

  /* Opened deliberately on a live seat: it stays, it does not hand off. */
  expect(sheet(host)).not.toBeNull();
  expect(panel.getAttribute("data-orchestrator-sheet-state")).toBe("live");

  /* WHO holds the seat: engine, model at tier, account and context fullness —
     the same reading the desktop's incumbent header renders. */
  const identity = panel.querySelector("[data-orchestrator-incumbent]") as HTMLElement | null;
  expect(identity).not.toBeNull();
  expect(identity!.textContent).toContain("Claude");
  expect(identity!.textContent).toContain("opus");
  expect(identity!.textContent).toContain("high");
  expect(identity!.textContent).toContain("spare");
  expect(identity!.querySelector("[data-orchestrator-context]")?.getAttribute("data-orchestrator-context")).toBe("24");
  expect(identity!.textContent).toContain("24%");
  /* The handoff lineage the desktop header links to. */
  expect(panel.querySelector('[data-orchestrator-predecessor="conv_predecessor"]')).not.toBeNull();

  /* The mandate the seat is running under is readable here, not only from a
     rotate draft that edits it. */
  const mandateView = panel.querySelector("[data-orchestrator-mandate-view]") as HTMLElement | null;
  expect(mandateView).not.toBeNull();
  expect(mandateView!.textContent).toContain("You run the Atlas board.");
  /* Based on v3, and behind: the card says both, as the desktop row does (#1452). */
  expect(mandateView!.textContent).toContain(`Mandate v3, default v${ORCHESTRATOR_PROMPT_VERSION}`);

  /* Rotate: a labelled 44px control, and only a control — nothing rotates
     until the draft it opens is confirmed. */
  const rotate = rotateButton(host);
  expect(rotate).not.toBeNull();
  expect(rotate!.className).toContain("min-h-11");
  expect(rotate!.textContent).toContain("Rotate");
  expect(rotatePosts()).toHaveLength(0);
  /* The conversation stays one tap away as the footer's primary action. */
  expect(confirmButton(host).textContent).toContain("Open the conversation");
});

test("Rotate opens the seat's configuration prefilled from the incumbent, and the draft is the SAME shape the desktop has", async () => {
  const files = [conversation({}), orchestrator];
  const { host, root } = await mount(files);
  await openControls(host, root, files);
  await openRotate(host, root, files);

  const panel = sheet(host)!;
  expect(panel.getAttribute("data-orchestrator-sheet-mode")).toBe("rotate");
  const draft = panel.querySelector('[data-orchestrator-draft="rotate"]');
  expect(draft).not.toBeNull();
  /* The seat is based on v3, so the box starts from the CURRENT default and
     says so; the incumbent's own text is one 44px tap away (#1452). The
     server composes the handoff either way. */
  const mandate = panel.querySelector("[data-orchestrator-mandate]") as HTMLTextAreaElement;
  expect(mandate.value).toBe(ORCHESTRATOR_SYSTEM_PROMPT);
  expect(panel.querySelector("[data-orchestrator-mandate-kind]")!.textContent).toBe(`Built-in default mandate v${ORCHESTRATOR_PROMPT_VERSION}`);
  expect(panel.querySelector("[data-orchestrator-mandate-stale]")!.textContent).toContain(`based on v3; the current default is v${ORCHESTRATOR_PROMPT_VERSION}`);
  const keep = panel.querySelector("[data-orchestrator-keep-incumbent]") as HTMLButtonElement;
  expect(keep.className).toContain("min-h-11");
  flushSync(() => keep.click());
  await settle(root, view(files), 2);
  expect(mandate.value).toBe("You run the Atlas board.");
  expect(panel.querySelector("[data-orchestrator-mandate-kind]")!.textContent)
    .toBe(`Incumbent's mandate (based on v3; current default is v${ORCHESTRATOR_PROMPT_VERSION})`);
  expect(panel.querySelector("[data-orchestrator-keep-incumbent]")).toBeNull();
  expect(panel.textContent).toContain("Replace this project's orchestrator");
  /* The shared launch module: engine radios, the account the incumbent runs
     under, and the 44px floor applied from outside it. */
  const engines = [...panel.querySelectorAll('[role="radio"]')].map((node) => node.textContent);
  expect(engines).toEqual(["Claude", "Codex"]);
  const account = panel.querySelector('select[aria-label*="Claude"]') as HTMLSelectElement;
  expect(account).not.toBeNull();
  expect(account.value).toBe("spare");
  const model = panel.querySelector('select[aria-label="Agent model"]') as HTMLSelectElement;
  expect(model.value).toBe("opus");
  expect(panel.querySelector('[role="radiogroup"]')!.closest("[class*='min-h-11']")).not.toBeNull();
  /* The successor continues in the predecessor's checkout, and says so. */
  expect(panel.textContent).toContain("/repo/atlas/worktrees/board");
  /* Two ways out, both at the thumb: keep the incumbent, or rotate. */
  expect(confirmButton(host).textContent).toContain("Rotate orchestrator");
  expect(confirmButton(host).className).toContain("min-h-11");
  const cancel = panel.querySelector("[data-orchestrator-rotate-cancel]") as HTMLButtonElement;
  expect(cancel).not.toBeNull();
  expect(cancel.className).toContain("min-h-11");

  /* Keep this one: back to the live view, nothing posted. */
  flushSync(() => cancel.click());
  await settle(root, view(files), 2);
  expect(sheet(host)!.getAttribute("data-orchestrator-sheet-mode")).toBe("live");
  expect(rotatePosts()).toHaveLength(0);
});

test("confirming a rotation posts to the ROTATE route once — never the seat route, never raw spawn — with the adjusted seat settings", async () => {
  const files = [conversation({}), orchestrator];
  const { host, root } = await mount(files);
  await openControls(host, root, files);
  await openRotate(host, root, files);

  type(sheet(host)!.querySelector("[data-orchestrator-mandate]") as HTMLTextAreaElement, "You run Atlas now. Talk to me here.");
  /* Adjust a seat setting end to end: the account this seat will run under.
     A native `change` on the select reaches React's own change plugin (a
     happy-dom select is a Proxy, so its React props are not enumerable). */
  const account = sheet(host)!.querySelector('select[aria-label*="Claude"]') as HTMLSelectElement;
  account.value = "primary";
  flushSync(() => account.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event));

  flushSync(() => confirmButton(host).click());
  await settle(root, view(files), 3);

  const posts = rotatePosts();
  expect(posts).toHaveLength(1);
  expect(seatPosts()).toHaveLength(0);
  expect(requests.some((request) => request.url.includes("/api/spawn"))).toBe(false);
  expect(posts[0]!.body).toMatchObject({ project: "atlas", mandate: "You run Atlas now. Talk to me here.", engine: "claude", model: "opus", effort: "high", accountId: "primary" });
  expect(String(posts[0]!.body.clientRequestId)).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  /* No cwd: the server continues the successor in the predecessor's checkout. */
  expect(posts[0]!.body.cwd).toBeUndefined();
});

test("a double tap rotates ONCE, and a retry after a lost reply replays the SAME key instead of rotating twice", async () => {
  postRotate = async () => {
    throw new Error("network down");
  };
  const files = [conversation({}), orchestrator];
  const { host, root } = await mount(files);
  await openControls(host, root, files);
  await openRotate(host, root, files);

  flushSync(() => {
    confirmButton(host).click();
    confirmButton(host).click();
  });
  await settle(root, view(files), 3);
  expect(rotatePosts()).toHaveLength(1);
  /* The reply was lost, so a successor may already exist: the draft says so
     and stays open over the incumbent, which is still on the seat. */
  expect(sheet(host)!.getAttribute("data-orchestrator-sheet-mode")).toBe("rotate");
  expect(sheet(host)!.querySelector("[data-orchestrator-intent-error]")!.textContent).toContain("replays the same request");
  expect(row(host).getAttribute("data-orchestrator-row-state")).toBe("live");

  postRotate = async () => json({ ok: true, replayed: true, conversationId: "conv_successor", seat: seat({ conversationId: "conv_successor", path: "/successor.jsonl" }) });
  flushSync(() => confirmButton(host).click());
  await settle(root, view(files), 3);
  const posts = rotatePosts();
  expect(posts).toHaveLength(2);
  expect(posts[1]!.body.clientRequestId).toBe(posts[0]!.body.clientRequestId);
});

test("a rotation the server refused surfaces in the draft with retry, and the retry carries a FRESH key", async () => {
  postRotate = async () => json({ error: "no orchestrator is designated for this project", code: "no_incumbent" }, 409);
  const files = [conversation({}), orchestrator];
  const { host, root } = await mount(files);
  await openControls(host, root, files);
  await openRotate(host, root, files);

  flushSync(() => confirmButton(host).click());
  await settle(root, view(files), 3);
  expect(sheet(host)!.querySelector("[data-orchestrator-intent-error]")!.textContent).toContain("no orchestrator is designated");
  /* The incumbent's conversation was never taken away by the failure. */
  expect(row(host).getAttribute("data-orchestrator-row-state")).toBe("live");
  expect(row(host).getAttribute("data-orchestrator-row-tap")).toBe("conversation");

  postRotate = async () => json({ ok: true, conversationId: "conv_successor", launchId: "launch-b", seat: seat({ conversationId: "conv_successor", path: "/successor.jsonl" }) }, 202);
  flushSync(() => confirmButton(host).click());
  await settle(root, view(files), 3);
  const posts = rotatePosts();
  expect(posts).toHaveLength(2);
  expect(posts[1]!.body.clientRequestId).not.toBe(posts[0]!.body.clientRequestId);
});

test("a landed rotation hands the phone off into the SUCCESSOR's conversation, with the composer", async () => {
  const files = [conversation({}), orchestrator, successor];
  const { host, root } = await mount(files);
  /* Default focus is the newest conversation; the incumbent is the seat. */
  expect(row(host).getAttribute("data-orchestrator-row-state")).toBe("live");
  await openControls(host, root, files);
  await openRotate(host, root, files);

  postRotate = async () => {
    /* The rotation landed: the next seat read reports the successor. */
    seatAnswer = { seat: seat({ conversationId: "conv_successor", path: "/successor.jsonl", predecessorConversationId: "conv_orchestrator", seatEpoch: 5 }), pending: null, exists: true };
    incumbentAnswer = incumbent({ conversationId: "conv_successor", transcriptPath: "/successor.jsonl", predecessorConversationId: "conv_orchestrator" });
    return json({ ok: true, accepted: true, state: "accepted", conversationId: "conv_successor", launchId: "launch-b", transport: "structured", initialMessage: "pending" }, 202);
  };
  flushSync(() => confirmButton(host).click());
  await settle(root, view(files), 6);

  /* The draft is gone with the incumbent it was replacing, and the phone is IN
     the successor's conversation — the standard focus view, composer included. */
  expect(sheet(host)).toBeNull();
  expect(focusedPath(host)).toBe("/successor.jsonl");
  expect(host.querySelector('[data-testid="bounded-mobile-composer"]')).not.toBeNull();
  expect(row(host).getAttribute("data-orchestrator-row-state")).toBe("live");
  expect(rotatePosts()).toHaveLength(1);
});

test("a seat whose transcript is not in view still reaches Rotate from the sheet — rotation is the way forward for a gone host", async () => {
  /* No file answers for the seat: the row's tap opens the sheet itself. */
  seatAnswer = { seat: seat({ conversationId: "conv_missing", path: "/missing.jsonl" }), pending: null, exists: true };
  incumbentAnswer = incumbent({ conversationId: "conv_missing", transcriptPath: "/missing.jsonl" });
  const files = [conversation({}), orchestrator];
  const { host, root } = await mount(files);
  expect(row(host).getAttribute("data-orchestrator-row-tap")).toBe("sheet");
  flushSync(() => openButton(host).click());
  await settle(root, view(files), 4);
  expect(sheet(host)).not.toBeNull();
  expect(rotateButton(host)).not.toBeNull();
  await openRotate(host, root, files);
  expect(sheet(host)!.querySelector('[data-orchestrator-draft="rotate"]')).not.toBeNull();
  /* A v3 seat, so the draft starts from the current default (#1452). */
  expect((sheet(host)!.querySelector("[data-orchestrator-mandate]") as HTMLTextAreaElement).value).toBe(ORCHESTRATOR_SYSTEM_PROMPT);
});

test("Rotate over a seat on the CURRENT default keeps the incumbent's text and offers nothing to keep (#1452)", async () => {
  seatAnswer = { seat: seat({ mandate: "You run the Atlas board, my way.", promptVersion: ORCHESTRATOR_PROMPT_VERSION }), pending: null, exists: true };
  const files = [conversation({}), orchestrator];
  const { host, root } = await mount(files);
  await openControls(host, root, files);
  const mandateView = sheet(host)!.querySelector("[data-orchestrator-mandate-view]") as HTMLElement;
  expect(mandateView.textContent).toContain(`Mandate v${ORCHESTRATOR_PROMPT_VERSION} —`);
  expect(mandateView.textContent).not.toContain("default v");
  await openRotate(host, root, files);

  const panel = sheet(host)!;
  expect((panel.querySelector("[data-orchestrator-mandate]") as HTMLTextAreaElement).value).toBe("You run the Atlas board, my way.");
  expect(panel.querySelector("[data-orchestrator-mandate-kind]")!.textContent)
    .toBe(`Incumbent's mandate (based on v${ORCHESTRATOR_PROMPT_VERSION}, the current default)`);
  expect(panel.querySelector("[data-orchestrator-mandate-stale]")).toBeNull();
  expect(panel.querySelector("[data-orchestrator-keep-incumbent]")).toBeNull();
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

test("the rotate draft stays operable with the keyboard open: the sheet pads the inset, the mandate is revealed once, the confirm survives", async () => {
  const vv = makeVisualViewport(844);
  (dom as unknown as Record<string, unknown>).visualViewport = vv;
  (globalThis as Record<string, unknown>).visualViewport = vv;
  try {
    const files = [conversation({}), orchestrator];
    const { host, root } = await mount(files);
    await openControls(host, root, files);
    await openRotate(host, root, files);

    const field = sheet(host)!.querySelector("[data-orchestrator-mandate]") as HTMLTextAreaElement;
    const block = field.parentElement as HTMLElement & { scrollIntoView: (options?: unknown) => void };
    const reveals: unknown[] = [];
    block.scrollIntoView = (options?: unknown) => { reveals.push(options); };

    flushSync(() => field.focus());
    await settle(root, view(files), 2);
    expect(reveals).toHaveLength(0);

    /* The keyboard opens under the focused field (#983's signal). */
    flushSync(() => vv.resizeTo(508));
    await settle(root, view(files), 2);
    expect(reveals).toEqual([{ block: "start" }]);
    /* The full-height surface yields the keyboard's share, so the confirm at
       the thumb is above it rather than behind it. */
    const surface = sheet(host)!.parentElement as HTMLElement;
    expect(surface.style.paddingBottom).toBe("336px");
    expect(confirmButton(host)).not.toBeNull();
    expect(confirmButton(host).textContent).toContain("Rotate orchestrator");

    flushSync(() => vv.resizeTo(468));
    await settle(root, view(files), 2);
    expect(reveals).toHaveLength(1);
  } finally {
    delete (dom as unknown as Record<string, unknown>).visualViewport;
    delete (globalThis as Record<string, unknown>).visualViewport;
  }
});

test("the sheet respects the phone's safe-area insets at both ends", async () => {
  const files = [conversation({}), orchestrator];
  const { host, root } = await mount(files);
  await openControls(host, root, files);
  const surface = sheet(host)!.parentElement as HTMLElement;
  expect(surface.className).toContain("fixed inset-0");
  expect(surface.className).toContain("pb-[env(safe-area-inset-bottom)]");
  expect(surface.className).toContain("pt-[env(safe-area-inset-top)]");
});
