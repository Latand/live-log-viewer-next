import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { setLocale } from "@/lib/i18n";
import { ORCHESTRATOR_PROMPT_VERSION, ORCHESTRATOR_SYSTEM_PROMPT } from "@/lib/orchestrator/prompt";
import type { FileEntry } from "@/lib/types";

/*
 * The per-project orchestrator panel end to end (issues #977 and #978):
 * the draft creates through the SEAT route on either engine, a double-click or
 * a retry cannot designate twice, and every state in the map renders — with the
 * stored terminal error always visible and always retryable.
 *
 * Slice B adds the incumbent: the header that names who holds the seat and how
 * full their context window is, the rotation recommendation the server has been
 * making invisibly, and rotation itself — which happens ONLY when confirmed, and
 * exactly once per confirmation no matter how the reply goes.
 */

const dom = new HappyWindow();
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLSelectElement: dom.HTMLSelectElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver,
  IntersectionObserver: undefined,
});
/* Desktop: the dock is a desktop surface (the phone is slice C). */
(dom as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (query: string) => ({
  matches: false, media: query, addEventListener() {}, removeEventListener() {},
});

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualLogTail = await import("@/hooks/useLogTail");
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ enabled: false, connection: "off", resyncedAt: null, lastEventAt: null, store: emptyStore() }),
  useRuntime: () => ({ enabled: false, connection: "off", resyncedAt: null, store: emptyStore() }),
  useRuntimeEnabled: () => false,
  useRuntimeSession: () => null,
  useRuntimeSessionForConversation: () => null,
  useRuntimeSessionByArtifact: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
/** What the feed already holds for a path. The real hook keeps exactly this —
    a browser-wide per-path snapshot of the tail (`useLogTail`'s own cache),
    read synchronously on mount — which is why a re-seated conversation view
    repaints a transcript this tab has already read (#1149). */
const tailLines = new Map<string, string[]>();
mock.module("@/hooks/useLogTail", () => ({
  ...actualLogTail,
  useLogTail: (file: FileEntry | null) => ({
    lines: (file && tailLines.get(file.path)) ?? [], linesStart: 0, size: 0, loading: false, error: null, tickTime: null,
    paused: false, setPaused: () => undefined, clear: () => undefined,
    hasMore: false, loadingOlder: false, loadOlder: async () => 0, prependGen: 0,
  }),
}));

const { OrchestratorPanel } = await import("./OrchestratorPanel");
const { SEAT_POLL_MS, resetOrchestratorSeatCacheForTests } = await import("./useOrchestratorSeat");
const { resetOrchestratorIncumbentCacheForTests } = await import("./useOrchestratorIncumbent");

const accounts = {
  claude: { active: "primary", accounts: [{ id: "primary", label: "primary", authPresent: true }, { id: "spare", label: "spare", authPresent: true }] },
  codex: { active: "codex-primary", accounts: [{ id: "codex-primary", label: "codex-primary", authPresent: true }] },
};

interface SeatFile {
  seat: Record<string, unknown> | null;
  pending: Record<string, unknown> | null;
  exists: boolean;
  viewerMcpRegistered?: boolean;
}

let seatStatus: SeatFile;
let seatPosts: Record<string, unknown>[];
let rotatePosts: Record<string, unknown>[];
let spawnPosts: number;
/** Queued answers for the confirm POST, oldest first; the last one repeats. */
let seatResponses: { status: number; body: Record<string, unknown> | null; throws?: boolean }[];
let rotateResponses: { status: number; body: Record<string, unknown> | null; throws?: boolean }[];
/** `GET /api/orchestrator/seat/status`, the incumbent read (#978). */
let incumbentStatus: Record<string, unknown> | null;
const realFetch = globalThis.fetch;

function answer(queue: { status: number; body: Record<string, unknown> | null; throws?: boolean }[]): Response {
  const next = queue.length > 1 ? queue.shift()! : queue[0]!;
  if (next.throws) throw new Error("network dropped");
  return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body } as Response;
}

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/orchestrator/seat" && init?.method === "POST") {
      seatPosts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return answer(seatResponses);
    }
    if (url === "/api/orchestrator/rotate" && init?.method === "POST") {
      rotatePosts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return answer(rotateResponses);
    }
    /* Both reads are per-project, and only atlas has an orchestrator here, so
       a switch away genuinely lands on another project's own answer. */
    if (url.startsWith("/api/orchestrator/seat/status")) {
      const target = new URL(url, "http://localhost").searchParams.get("project");
      return { ok: true, status: 200, json: async () => (target === "atlas" ? incumbentStatus : { project: target, designated: false, rotation: null, context: null }) } as Response;
    }
    if (url.startsWith("/api/orchestrator/seat?")) {
      const target = new URL(url, "http://localhost").searchParams.get("project");
      return { ok: true, status: 200, json: async () => (target === "atlas" ? seatStatus : { seat: null, pending: null, exists: true }) } as Response;
    }
    if (url === "/api/accounts") return { ok: true, status: 200, json: async () => accounts } as Response;
    /* No voice backend in a DOM test, so a transcript's speak control renders
       nothing rather than reading a shape the catch-all below cannot supply. */
    if (url.startsWith("/api/tts/")) return { ok: false, status: 404, json: async () => ({}) } as Response;
    if (url.startsWith("/api/spawn")) {
      spawnPosts += 1;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as Response;
  }) as typeof fetch;
}

/** The status route's answer for a live incumbent, as the panel parses it. */
function incumbent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: "atlas",
    designated: true,
    conversationId: "conversation_orch",
    predecessorConversationId: null,
    engine: "claude",
    model: "opus",
    effort: "high",
    accountId: "spare",
    cwd: "/repos/atlas/worktrees/board",
    transcriptFacts: { bytes: 2_100_000, messageCount: 812, toolCount: 1_930, compactionCount: 0 },
    context: { tokens: 240_000, limit: 1_000_000, percent: 24, estimated: false, basis: "provider-reported usage from the transcript's newest turn", policy: "claude-opus-1m" },
    rotation: { recommended: false, level: "none", advisory: null, reasons: [], threshold: null, thresholdUnknown: false },
    ...overrides,
  };
}

function activeSeat(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: "atlas",
    seatEpoch: 2,
    conversationId: "conversation_orch",
    path: "/transcripts/orch.jsonl",
    mandate: "run it",
    promptVersion: 3,
    predecessorConversationId: null,
    state: "active",
    intent: { clientRequestId: "req-aaaaaaaa", mode: "spawn", launchId: "launch-a", error: null },
    designatedAt: "2026-08-13T10:00:00.000Z",
    activatedAt: "2026-08-13T10:00:01.000Z",
    ...overrides,
  };
}

function pendingSeat(error: string | null): Record<string, unknown> {
  return {
    ...activeSeat(),
    conversationId: null,
    path: null,
    state: "pending",
    activatedAt: null,
    intent: { clientRequestId: "req-bbbbbbbb", mode: "spawn", launchId: null, error },
  };
}

const orchestratorFile: FileEntry = {
  path: "/transcripts/orch.jsonl",
  root: "claude-projects",
  name: "orch.jsonl",
  project: "atlas",
  title: "Orchestrator",
  engine: "claude",
  kind: "session",
  fmt: "claude",
  parent: null,
  mtime: 1_760_000_000,
  size: 12,
  activity: "live",
  proc: null,
  pid: null,
  conversationId: "conversation_orch",
  model: "opus",
  pendingQuestion: null,
  waitingInput: null,
} as FileEntry;

const roots = new Set<Root>();
beforeEach(() => {
  /* Both answer caches are this TAB's memory (#1149), so each test starts as a
     tab that has never read a seat. */
  resetOrchestratorSeatCacheForTests();
  resetOrchestratorIncumbentCacheForTests();
  tailLines.clear();
  seatStatus = { seat: null, pending: null, exists: true, viewerMcpRegistered: false };
  incumbentStatus = { project: "atlas", designated: false, rotation: null, context: null };
  seatPosts = [];
  rotatePosts = [];
  spawnPosts = 0;
  seatResponses = [{ status: 202, body: { ok: true, accepted: true, state: "accepted", conversationId: "conversation_orch", launchId: "launch-a", transport: "structured", initialMessage: "pending", seat: activeSeat() } }];
  rotateResponses = [{ status: 202, body: { ok: true, accepted: true, state: "accepted", conversationId: "conversation_successor", launchId: "launch-b", transport: "structured", initialMessage: "pending", seat: activeSeat({ conversationId: "conversation_successor" }) } }];
  installFetch();
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  dom.sessionStorage.clear();
  dom.localStorage.clear();
  setLocale("en");
  globalThis.fetch = realFetch;
});
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
});

const settle = async () => {
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function mount(files: FileEntry[] = []): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  flushSync(() => root.render(
    <OrchestratorPanel project="atlas" projectName="Atlas" projectCwd="/repos/atlas" files={files} onClose={() => undefined} />,
  ));
  return host as unknown as HTMLElement;
}

/** The panel reopened on a later seat read — a reload, or coming back to the
    project. Draft state (including an unsettled submission's key) lives in
    sessionStorage, so it survives exactly as it does for the operator. */
function remount(files: FileEntry[] = []): HTMLElement {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  return mount(files);
}

/** One dock's panel across a project switch: the SAME root, the panel re-seated
    under `key={project}` exactly as `OrchestratorDock` mounts it. */
function mountDock(files: FileEntry[]) {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  return {
    host: host as unknown as HTMLElement,
    open: (project: string) => flushSync(() => root.render(
      <OrchestratorPanel
        key={project}
        project={project}
        projectName={project}
        projectCwd={`/repos/${project}`}
        files={files}
        onClose={() => undefined}
      />,
    )),
  };
}

function panelState(host: HTMLElement): string | null {
  return host.querySelector("[data-orchestrator-panel]")?.getAttribute("data-orchestrator-state") ?? null;
}

function confirmButton(host: HTMLElement): HTMLButtonElement {
  return host.querySelector("[data-orchestrator-confirm]") as HTMLButtonElement;
}

/** Typing, the way this repo's DOM tests type: happy-dom does not carry React's
    value tracker, so the field's own onChange is invoked with the new value. */
function type(field: HTMLTextAreaElement, value: string): void {
  const propsKey = Object.keys(field).find((key) => key.startsWith("__reactProps$"))!;
  const props = (field as unknown as Record<string, { onChange: (event: unknown) => void }>)[propsKey]!;
  flushSync(() => props.onChange({ target: { value } }));
}

test("with no orchestrator the panel is a draft prefilled with the default mandate, and confirm designates through the SEAT route", async () => {
  const host = mount();
  await settle();
  flushSync(() => undefined);

  expect(panelState(host)).toBe("draft");
  expect(host.querySelector("[data-viewer-mcp-status]")?.textContent).toContain("scripts/install-mcp.sh");
  expect(host.querySelector("[data-viewer-mcp-status]")?.textContent).toContain("claude mcp add viewer");
  const mandate = host.querySelector("[data-orchestrator-mandate]") as HTMLTextAreaElement;
  expect(mandate.value).toBe(ORCHESTRATOR_SYSTEM_PROMPT);
  /* Cwd is the project's own root, stated and never typed. */
  expect(host.textContent).toContain("/repos/atlas");

  type(mandate, "You run Atlas. Talk to me here.");
  await settle();

  flushSync(() => confirmButton(host).click());
  await settle();

  expect(spawnPosts).toBe(0);
  expect(seatPosts).toHaveLength(1);
  expect(seatPosts[0]).toMatchObject({
    project: "atlas",
    mandate: "You run Atlas. Talk to me here.",
    engine: "claude",
    model: "opus",
    cwd: "/repos/atlas",
    accountId: "primary",
  });
  expect(String(seatPosts[0]!.clientRequestId)).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  /* An edited mandate is bespoke — it records no approved-prompt version. */
  expect(seatPosts[0]!.promptVersion).toBeUndefined();
});

test("the orchestrator draft confirms a resolved Viewer MCP registration", async () => {
  seatStatus = { seat: null, pending: null, exists: true, viewerMcpRegistered: true };
  const host = mount();
  await settle();

  expect(host.querySelector("[data-viewer-mcp-status]")?.textContent).toContain("viewer MCP: registered ✓");
});

test("an unedited mandate records the approved prompt version", async () => {
  const host = mount();
  await settle();
  flushSync(() => confirmButton(host).click());
  await settle();
  /* Whatever the approved prompt currently is — the panel reports the
     constant, never a number of its own. */
  expect(seatPosts[0]!.promptVersion).toBe(ORCHESTRATOR_PROMPT_VERSION);
});

test("a double-click designates ONCE and a retry after a lost reply replays the same key", async () => {
  seatResponses = [{ status: 0, body: null, throws: true }];
  const host = mount();
  await settle();

  const button = confirmButton(host);
  flushSync(() => {
    button.click();
    button.click();
  });
  await settle();
  expect(seatPosts).toHaveLength(1);

  /* The reply was lost: worker existence is unknown, so the panel says so and
     the retry converges onto the SAME durable intent instead of a second one. */
  expect(panelState(host)).toBe("intent-error");
  expect(host.querySelector("[data-orchestrator-intent-error]")?.textContent).toContain("connection");

  seatResponses = [{ status: 200, body: { ok: true, replayed: true, conversationId: "conversation_orch", seat: activeSeat() } }];
  flushSync(() => confirmButton(host).click());
  await settle();
  expect(seatPosts).toHaveLength(2);
  expect(seatPosts[1]!.clientRequestId).toBe(seatPosts[0]!.clientRequestId);
});

test("a refused designation is terminal: the error is shown and the corrected retry carries a FRESH key", async () => {
  seatResponses = [{ status: 400, body: { error: "orchestrator cwd could not be resolved", code: "cwd_unresolved" } }];
  const host = mount();
  await settle();

  flushSync(() => confirmButton(host).click());
  await settle();
  expect(panelState(host)).toBe("intent-error");
  expect(host.querySelector("[data-orchestrator-intent-error]")?.textContent).toContain("orchestrator cwd could not be resolved");

  seatResponses = [{ status: 202, body: { ok: true, conversationId: "conversation_orch", launchId: "launch-a", seat: activeSeat() } }];
  flushSync(() => confirmButton(host).click());
  await settle();
  expect(seatPosts).toHaveLength(2);
  expect(seatPosts[1]!.clientRequestId).not.toBe(seatPosts[0]!.clientRequestId);
});

test("a durable terminal error on the pending intent is never hidden — it renders on reload, with retry", async () => {
  seatStatus = { seat: null, pending: pendingSeat("spawn was rejected with HTTP status 500"), exists: true };
  const host = mount();
  await settle();
  flushSync(() => undefined);

  expect(panelState(host)).toBe("intent-error");
  expect(host.querySelector("[data-orchestrator-intent-error]")?.textContent).toContain("spawn was rejected with HTTP status 500");
  expect(confirmButton(host)).not.toBeNull();
  /* The mandate stays editable right under the error: read it, fix it, retry. */
  expect(host.querySelector("[data-orchestrator-mandate]")).not.toBeNull();
});

test("a pending intent with no error is the creating state, naming its durable receipt", async () => {
  seatStatus = { seat: null, pending: { ...pendingSeat(null), intent: { clientRequestId: "req-bbbbbbbb", mode: "spawn", launchId: "launch-pending", error: null } }, exists: true };
  const host = mount();
  await settle();
  flushSync(() => undefined);

  expect(panelState(host)).toBe("creating");
  expect(host.textContent).toContain("launch-pending");
});

test("a designation left pending by a dead request can be finished, by re-posting its own key", async () => {
  seatStatus = { seat: null, pending: { ...pendingSeat(null), intent: { clientRequestId: "req-bbbbbbbb", mode: "spawn", launchId: "launch-pending", error: null } }, exists: true };
  const host = mount();
  await settle();
  flushSync(() => undefined);
  expect(panelState(host)).toBe("creating");

  const resume = [...host.querySelectorAll("button")].find((node) => node.textContent?.includes("Finish this designation")) as HTMLButtonElement;
  expect(resume).toBeDefined();

  seatResponses = [{ status: 200, body: { ok: true, replayed: true, conversationId: "conversation_orch", seat: activeSeat() } }];
  flushSync(() => resume.click());
  await settle();

  expect(seatPosts).toHaveLength(1);
  /* Its OWN key: the seat command completes the original intent instead of
     beginning a second one. */
  expect(seatPosts[0]!.clientRequestId).toBe("req-bbbbbbbb");
});

test("switching to Codex offers the codex account catalog and launches on it", async () => {
  const host = mount();
  await settle();
  flushSync(() => undefined);

  const codex = [...host.querySelectorAll('[role="radio"]')].find((node) => node.textContent === "Codex") as HTMLButtonElement;
  expect(codex).toBeDefined();
  flushSync(() => codex.click());
  await settle();

  const accountSelect = host.querySelector('select[aria-label*="Codex"]') as HTMLSelectElement;
  expect(accountSelect).not.toBeNull();
  expect([...accountSelect.options].map((option) => option.value)).toEqual(["codex-primary"]);

  flushSync(() => confirmButton(host).click());
  await settle();
  expect(seatPosts[0]).toMatchObject({ engine: "codex", accountId: "codex-primary" });
});

test("an active seat mounts the REAL conversation column — feed and composer, not a bespoke chat", async () => {
  seatStatus = { seat: activeSeat(), pending: null, exists: true };
  const host = mount([orchestratorFile]);
  await settle();
  flushSync(() => undefined);

  expect(panelState(host)).toBe("live");
  expect(host.querySelector('[data-orchestrator-conversation="conversation_orch"]')).not.toBeNull();
  expect(host.querySelector("[data-agent-control-strip]")).not.toBeNull();
  expect((host.querySelector("textarea") as HTMLTextAreaElement).placeholder).toBe("what should get done in Atlas?");
  /* No draft on a seated project: a second create is not offered at all. */
  expect(confirmButton(host)).toBeNull();
});

test("a seat whose transcript is gone returns the panel to the draft", async () => {
  seatStatus = { seat: activeSeat(), pending: null, exists: false };
  const host = mount();
  await settle();
  flushSync(() => undefined);
  expect(panelState(host)).toBe("draft");
  expect(host.querySelector("[data-orchestrator-mandate]")).not.toBeNull();
});

test("a finished seat says so and offers resume in place — never a green live badge", async () => {
  seatStatus = { seat: activeSeat(), pending: null, exists: true };
  /* No process behind it: the capability matrix classifies this root as
     `resume`, so the conversation continues HERE rather than being replaced. */
  const host = mount([{ ...orchestratorFile, proc: null, activity: "idle" } as FileEntry]);
  await settle();
  flushSync(() => undefined);

  expect(panelState(host)).toBe("live");
  expect(host.textContent).toContain("finished");
  expect(host.textContent).toContain("resume this same conversation");
  /* The real composer is still the way through — no second create is offered. */
  expect(host.querySelector('[data-orchestrator-conversation="conversation_orch"]')).not.toBeNull();
  expect(confirmButton(host)).toBeNull();

  /* A running one keeps the live badge it earned. */
  const live = remount([{ ...orchestratorFile, proc: "running", pid: 4_242 } as FileEntry]);
  await settle();
  flushSync(() => undefined);
  expect(live.textContent).not.toContain("resume this same conversation");
});

test("after a lost reply lands, the next NEW draft carries a fresh key instead of replaying the old one", async () => {
  /* The sequence the seat route punishes: the reply is lost, the designation
     actually succeeded, the operator later closes that conversation, and then
     creates a new orchestrator. Replaying the old key there is answered with
     the completed intent — the button would appear to work and create nothing. */
  seatResponses = [{ status: 0, body: null, throws: true }];
  const host = mount();
  await settle();

  flushSync(() => confirmButton(host).click());
  await settle();
  expect(seatPosts).toHaveLength(1);
  const lost = String(seatPosts[0]!.clientRequestId);
  expect(panelState(host)).toBe("intent-error");

  /* The read catches up: that key DID reach an active seat. Live, and the
     lost-reply banner has retired with it rather than riding along forever. */
  seatStatus = { seat: activeSeat({ intent: { clientRequestId: lost, mode: "spawn", launchId: "launch-a", error: null } }), pending: null, exists: true };
  const live = remount([orchestratorFile]);
  await settle();
  flushSync(() => undefined);
  expect(panelState(live)).toBe("live");
  expect(live.querySelector("[data-orchestrator-intent-error]")).toBeNull();

  /* The operator closes that conversation; the seat is vacant again. */
  seatStatus = { ...seatStatus, exists: false };
  const again = remount();
  await settle();
  flushSync(() => undefined);
  expect(panelState(again)).toBe("draft");

  seatResponses = [{ status: 202, body: { ok: true, conversationId: "conversation_orch2", launchId: "launch-b", seat: activeSeat() } }];
  flushSync(() => confirmButton(again).click());
  await settle();
  expect(seatPosts).toHaveLength(2);
  expect(seatPosts[1]!.clientRequestId).not.toBe(lost);
});

test("a key whose outcome is still unknown is KEPT — the retry converges instead of designating twice", async () => {
  seatResponses = [{ status: 0, body: null, throws: true }];
  const host = mount();
  await settle();

  flushSync(() => confirmButton(host).click());
  await settle();
  const lost = String(seatPosts[0]!.clientRequestId);

  /* The seat read shows nothing about this key: it may still be in flight, so
     the promise to converge stands and the retry replays it. */
  seatStatus = { seat: null, pending: null, exists: true };
  await settle();
  flushSync(() => undefined);
  expect(panelState(host)).toBe("intent-error");

  flushSync(() => confirmButton(host).click());
  await settle();
  expect(seatPosts[1]!.clientRequestId).toBe(lost);
});

test("a durable terminal error releases the key, so the corrected mandate is the one delivered", async () => {
  /* Transport loss, then the server's own record shows that intent FAILED.
     Replaying its key would re-deliver the original mandate (the seat command
     completes the ORIGINAL intent), so the corrected retry needs a new one. */
  seatResponses = [{ status: 0, body: null, throws: true }];
  const host = mount();
  await settle();
  flushSync(() => confirmButton(host).click());
  await settle();
  const lost = String(seatPosts[0]!.clientRequestId);

  seatStatus = {
    seat: null,
    pending: { ...pendingSeat("orchestrator cwd could not be resolved"), intent: { clientRequestId: lost, mode: "spawn", launchId: null, error: "orchestrator cwd could not be resolved" } },
    exists: true,
  };
  const reopened = remount();
  await settle();
  flushSync(() => undefined);
  expect(panelState(reopened)).toBe("intent-error");
  expect(reopened.querySelector("[data-orchestrator-intent-error]")?.textContent).toContain("orchestrator cwd could not be resolved");

  seatResponses = [{ status: 202, body: { ok: true, conversationId: "conversation_orch", launchId: "launch-a", seat: activeSeat() } }];
  flushSync(() => confirmButton(reopened).click());
  await settle();
  expect(seatPosts[1]!.clientRequestId).not.toBe(lost);
});

/* ------------------------------------------------------------------------- *
 * Slice B (#978): the incumbent header, the rotation advisory, and rotate.
 * ------------------------------------------------------------------------- */

const rotateButton = (host: HTMLElement) => host.querySelector("[data-orchestrator-rotate]") as HTMLButtonElement;
const incumbentRow = (host: HTMLElement) => host.querySelector("[data-orchestrator-incumbent]") as HTMLElement | null;

/** Mount on a live incumbent whose status read has already answered. */
async function mountLive(status: Record<string, unknown> = incumbent()): Promise<HTMLElement> {
  seatStatus = { seat: activeSeat(), pending: null, exists: true };
  incumbentStatus = status;
  const host = mount([{ ...orchestratorFile, proc: "running", pid: 4_242 } as FileEntry]);
  await settle();
  flushSync(() => undefined);
  return host;
}

test("the header names the incumbent — engine, model, account and context percent", async () => {
  const host = await mountLive();

  const row = incumbentRow(host)!;
  expect(row).not.toBeNull();
  expect(row.textContent).toContain("Claude");
  expect(row.textContent).toContain("opus");
  expect(row.textContent).toContain("high");
  /* The account catalog's own label, resolved from the id the server reports. */
  expect(row.textContent).toContain("spare");
  expect(row.querySelector("[data-orchestrator-context]")?.getAttribute("data-orchestrator-context")).toBe("24");
  expect(row.textContent).toContain("24%");
});

test("a server recommendation is SHOWN, in the server's own words, and rotates nothing by itself", async () => {
  const host = await mountLive(incumbent({
    context: { tokens: 620_000, limit: 1_000_000, percent: 62, estimated: false, basis: "provider-reported usage", policy: "claude-opus-1m" },
    rotation: {
      recommended: true,
      level: "strongly_recommend",
      advisory: "STRONGLY_RECOMMEND_ROTATION",
      reasons: ["context usage 620,000 tokens has reached the rotation threshold of 500,000 tokens (claude-opus-1m: 50% of a 1,000,000-token window)"],
      thresholdUnknown: false,
    },
  }));

  const banner = host.querySelector("[data-orchestrator-rotation]")!;
  expect(banner.getAttribute("data-orchestrator-rotation")).toBe("strongly_recommend");
  expect(banner.textContent).toContain("Rotation strongly recommended");
  expect(banner.textContent).toContain("rotation threshold of 500,000 tokens");
  /* WORDS ONLY: no rotation was posted, and the conversation is untouched. */
  expect(rotatePosts).toHaveLength(0);
  expect(host.querySelector('[data-orchestrator-conversation="conversation_orch"]')).not.toBeNull();
});

test("an estimated context number is marked as one — a guess never reads as a provider count", async () => {
  const host = await mountLive(incumbent({
    context: { tokens: 525_000, limit: 1_000_000, percent: 53, estimated: true, basis: "ESTIMATE: transcript bytes / 4 — no provider-reported usage found", policy: "claude-opus-1m" },
  }));
  expect(incumbentRow(host)!.textContent).toContain("~53%");
});

test("Rotate opens the SAME draft, prefilled from the incumbent, over the conversation it replaces", async () => {
  const host = await mountLive();

  flushSync(() => rotateButton(host).click());
  await settle();

  expect(host.querySelector("[data-orchestrator-panel]")?.getAttribute("data-orchestrator-mode")).toBe("rotate");
  expect(host.querySelector('[data-orchestrator-draft="rotate"]')).not.toBeNull();
  /* The incumbent's own mandate, editable — the handoff is the server's job. */
  const mandate = host.querySelector("[data-orchestrator-mandate]") as HTMLTextAreaElement;
  expect(mandate.value).toBe("run it");
  expect(host.textContent).not.toContain("Handoff from your predecessor");
  /* The account picker opens on the account the incumbent is running under. */
  const account = host.querySelector('select[aria-label*="Claude"]') as HTMLSelectElement;
  expect(account.value).toBe("spare");
  /* The successor continues in the predecessor's checkout. */
  expect(host.textContent).toContain("/repos/atlas/worktrees/board");
  /* The incumbent is still on the seat, and the panel still says so. */
  expect(panelState(host)).toBe("live");
  expect(incumbentRow(host)).not.toBeNull();

  flushSync(() => (host.querySelector("[data-orchestrator-rotate-cancel]") as HTMLButtonElement).click());
  await settle();
  expect(host.querySelector('[data-orchestrator-conversation="conversation_orch"]')).not.toBeNull();
});

test("confirming a rotation posts to the ROTATE route, and never composes the handoff itself", async () => {
  const host = await mountLive();
  flushSync(() => rotateButton(host).click());
  await settle();

  type(host.querySelector("[data-orchestrator-mandate]") as HTMLTextAreaElement, "You run Atlas now.");
  await settle();
  flushSync(() => confirmButton(host).click());
  await settle();

  expect(seatPosts).toHaveLength(0);
  expect(spawnPosts).toBe(0);
  expect(rotatePosts).toHaveLength(1);
  expect(rotatePosts[0]).toMatchObject({ project: "atlas", mandate: "You run Atlas now.", engine: "claude", model: "opus", effort: "high", accountId: "spare" });
  expect(String(rotatePosts[0]!.clientRequestId)).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  /* No cwd: the server continues the successor in the predecessor's checkout. */
  expect(rotatePosts[0]!.cwd).toBeUndefined();
});

test("a double-click rotates ONCE, and a retry after a lost reply replays the same key", async () => {
  rotateResponses = [{ status: 0, body: null, throws: true }];
  const host = await mountLive();
  flushSync(() => rotateButton(host).click());
  await settle();

  const button = confirmButton(host);
  flushSync(() => {
    button.click();
    button.click();
  });
  await settle();
  expect(rotatePosts).toHaveLength(1);

  /* The reply was lost, so a successor may already exist: the draft says so and
     stays open over the incumbent, which is still on the seat. */
  expect(host.querySelector("[data-orchestrator-intent-error]")?.textContent).toContain("connection");
  expect(panelState(host)).toBe("live");

  rotateResponses = [{ status: 200, body: { ok: true, replayed: true, conversationId: "conversation_successor", seat: activeSeat({ conversationId: "conversation_successor" }) } }];
  flushSync(() => confirmButton(host).click());
  await settle();
  expect(rotatePosts).toHaveLength(2);
  expect(rotatePosts[1]!.clientRequestId).toBe(rotatePosts[0]!.clientRequestId);
});

test("a rotation the server refused surfaces in the panel with retry, and the retry carries a FRESH key", async () => {
  rotateResponses = [{ status: 409, body: { error: "no orchestrator is designated for this project", code: "no_incumbent" } }];
  const host = await mountLive();
  flushSync(() => rotateButton(host).click());
  await settle();

  flushSync(() => confirmButton(host).click());
  await settle();
  expect(host.querySelector("[data-orchestrator-intent-error]")?.textContent).toContain("no orchestrator is designated");
  /* The incumbent's conversation was never taken away by the failure. */
  expect(panelState(host)).toBe("live");
  expect(incumbentRow(host)).not.toBeNull();

  rotateResponses = [{ status: 202, body: { ok: true, conversationId: "conversation_successor", launchId: "launch-b", seat: activeSeat({ conversationId: "conversation_successor" }) } }];
  flushSync(() => confirmButton(host).click());
  await settle();
  expect(rotatePosts).toHaveLength(2);
  expect(rotatePosts[1]!.clientRequestId).not.toBe(rotatePosts[0]!.clientRequestId);
});

test("a durable terminal error on a pending rotation is never hidden — it renders over the incumbent, with retry", async () => {
  seatStatus = {
    seat: activeSeat(),
    pending: pendingSeat("the successor's spawn was rejected with HTTP status 500"),
    exists: true,
  };
  incumbentStatus = incumbent();
  const host = mount([{ ...orchestratorFile, proc: "running", pid: 4_242 } as FileEntry]);
  await settle();
  flushSync(() => undefined);

  /* Riding ALONGSIDE the live conversation, as slice A designed it… */
  expect(panelState(host)).toBe("live");
  expect(host.querySelector("[data-orchestrator-intent-error]")?.textContent).toContain("spawn was rejected with HTTP status 500");

  /* …and the same error, with retry in place, once the rotate draft is open —
     stated ONCE, on the form that can act on it. */
  flushSync(() => rotateButton(host).click());
  await settle();
  const errors = host.querySelectorAll("[data-orchestrator-intent-error]");
  expect(errors).toHaveLength(1);
  expect(host.querySelector('[data-orchestrator-draft="rotate"] [data-orchestrator-intent-error]')?.textContent)
    .toContain("spawn was rejected with HTTP status 500");
  /* And it says what is true of a failed ROTATION: the incumbent still holds
     the seat, so «nothing is running» is never printed here. */
  expect(errors[0]!.textContent).toContain("still holds the seat");
  expect(confirmButton(host)).not.toBeNull();
});

test("once the successor holds the seat the panel shows IT, with the predecessor linked on the board", async () => {
  const host = await mountLive();
  flushSync(() => rotateButton(host).click());
  await settle();
  flushSync(() => confirmButton(host).click());
  await settle();
  expect(rotatePosts).toHaveLength(1);

  /* The seat has advanced, and the rotate draft closes with it — no reload. */
  seatStatus = {
    seat: activeSeat({ conversationId: "conversation_successor", path: "/transcripts/successor.jsonl", predecessorConversationId: "conversation_orch" }),
    pending: null,
    exists: true,
  };
  incumbentStatus = incumbent({ conversationId: "conversation_successor", predecessorConversationId: "conversation_orch" });
  const successorFile = { ...orchestratorFile, path: "/transcripts/successor.jsonl", conversationId: "conversation_successor", proc: "running", pid: 4_243 } as FileEntry;
  const successor = remount([successorFile]);
  await settle();
  flushSync(() => undefined);

  expect(panelState(successor)).toBe("live");
  expect(successor.querySelector("[data-orchestrator-panel]")?.getAttribute("data-orchestrator-mode")).toBe("default");
  expect(successor.querySelector('[data-orchestrator-conversation="conversation_successor"]')).not.toBeNull();
  const link = successor.querySelector("[data-orchestrator-predecessor]") as HTMLAnchorElement;
  expect(link.getAttribute("data-orchestrator-predecessor")).toBe("conversation_orch");
  expect(link.getAttribute("href")).toBe("#c=conversation_orch");
});

test("closing the seat conversation returns the panel to the draft WITHOUT a reload", async () => {
  const host = await mountLive();
  expect(panelState(host)).toBe("live");

  /* The operator closes the card: the transcript is gone, so the seat reads
     `exists: false` on the very next poll — the panel is already mounted. */
  seatStatus = { ...seatStatus, exists: false };
  await settle();
  await new Promise((resolve) => setTimeout(resolve, SEAT_POLL_MS + 5));
  await settle();
  flushSync(() => undefined);

  expect(panelState(host)).toBe("draft");
  expect(host.querySelector("[data-orchestrator-mandate]")).not.toBeNull();
  expect(incumbentRow(host)).toBeNull();
  /* One real seat poll has to elapse for «without a reload» to mean anything. */
}, SEAT_POLL_MS + 4_000);

test("a rotate draft left open when the seat is closed gives way to the create draft", async () => {
  const host = await mountLive();
  flushSync(() => rotateButton(host).click());
  await settle();
  expect(host.querySelector('[data-orchestrator-draft="rotate"]')).not.toBeNull();

  seatStatus = { ...seatStatus, exists: false };
  await settle();
  await new Promise((resolve) => setTimeout(resolve, SEAT_POLL_MS + 5));
  await settle();
  flushSync(() => undefined);

  expect(panelState(host)).toBe("draft");
  expect(host.querySelector('[data-orchestrator-draft="create"]')).not.toBeNull();
}, SEAT_POLL_MS + 4_000);

test("Rotate reads the incumbent BEFORE it opens, so the first press is prefilled too", async () => {
  /* The status read has not answered for this seat yet — the panel is up on
     what the board alone knows. Opening the draft against THAT would prefill
     the generic orchestrator defaults, and the launch module reads its defaults
     once, so the incumbent's real parameters would never arrive. */
  const host = await mountLive({ project: "atlas", designated: false, rotation: null, context: null });
  incumbentStatus = incumbent();

  flushSync(() => rotateButton(host).click());
  await settle();

  expect(host.querySelector('[data-orchestrator-draft="rotate"]')).not.toBeNull();
  const account = host.querySelector('select[aria-label*="Claude"]') as HTMLSelectElement;
  expect(account.value).toBe("spare");
  expect(host.textContent).toContain("/repos/atlas/worktrees/board");
});

test("a rotation whose reply never came keeps its key: the second Confirm replays it instead of rotating twice", async () => {
  /* «Accepted» is not «the seat moved». The POST lands, the seat re-read is
     stale (or lost), and the rotate draft is still open over the incumbent —
     so the next Confirm must carry the SAME key and converge on the one
     successor, never mint a fresh one and rotate again. */
  const host = await mountLive();
  flushSync(() => rotateButton(host).click());
  await settle();

  flushSync(() => confirmButton(host).click());
  await settle();
  expect(rotatePosts).toHaveLength(1);
  /* The seat read has not caught up: the panel is still on the predecessor. */
  expect(panelState(host)).toBe("live");
  expect(host.querySelector('[data-orchestrator-draft="rotate"]')).not.toBeNull();

  flushSync(() => confirmButton(host).click());
  await settle();
  expect(rotatePosts).toHaveLength(2);
  expect(rotatePosts[1]!.clientRequestId).toBe(rotatePosts[0]!.clientRequestId);

  /* And once the read says where it landed, the key is spent: a genuinely new
     rotation carries a fresh one rather than replaying a completed intent. */
  const spent = String(rotatePosts[0]!.clientRequestId);
  seatStatus = {
    seat: activeSeat({ conversationId: "conversation_successor", intent: { clientRequestId: spent, mode: "spawn", launchId: "launch-b", error: null } }),
    pending: null,
    exists: true,
  };
  incumbentStatus = incumbent({ conversationId: "conversation_successor" });
  const successorFile = { ...orchestratorFile, conversationId: "conversation_successor", proc: "running", pid: 4_243 } as FileEntry;
  const successor = remount([successorFile]);
  await settle();
  flushSync(() => rotateButton(successor).click());
  await settle();
  flushSync(() => confirmButton(successor).click());
  await settle();
  expect(rotatePosts).toHaveLength(3);
  expect(rotatePosts[2]!.clientRequestId).not.toBe(spent);
});

test("a rotation still in the air keeps its draft when the seat's card is closed — retry replays it at the ROTATE route", async () => {
  /* Closing the card mid-rotation must not strand the flow: the retained key
     is reachable only from the rotate draft, and the create draft's retry would
     post a different key at the seat route — which refuses over a seat that is
     still designated. */
  rotateResponses = [{ status: 0, body: null, throws: true }];
  const host = await mountLive();
  flushSync(() => rotateButton(host).click());
  await settle();
  flushSync(() => confirmButton(host).click());
  await settle();
  expect(rotatePosts).toHaveLength(1);

  seatStatus = { ...seatStatus, exists: false };
  await settle();
  await new Promise((resolve) => setTimeout(resolve, SEAT_POLL_MS + 5));
  await settle();
  flushSync(() => undefined);

  expect(host.querySelector('[data-orchestrator-draft="rotate"]')).not.toBeNull();
  expect(host.querySelector('[data-orchestrator-draft="create"]')).toBeNull();
  expect(host.textContent).toContain("while this rotation was still in flight");
  expect(host.querySelector("[data-orchestrator-intent-error]")?.textContent).toContain("connection");

  rotateResponses = [{ status: 200, body: { ok: true, replayed: true, conversationId: "conversation_successor", seat: activeSeat({ conversationId: "conversation_successor" }) } }];
  flushSync(() => confirmButton(host).click());
  await settle();
  expect(seatPosts).toHaveLength(0);
  expect(rotatePosts).toHaveLength(2);
  expect(rotatePosts[1]!.clientRequestId).toBe(rotatePosts[0]!.clientRequestId);
}, SEAT_POLL_MS + 4_000);

test("the draft a closed conversation returns to can actually create — it says it is replacing the seat that outlived its card", async () => {
  /* The seat record outlives its transcript: a plain spawn over it is refused
     as an accidental rotation, which would make «the panel returns to draft»
     (PRD #976 decision 4) a button that always fails. */
  const host = await mountLive();
  seatStatus = { ...seatStatus, exists: false };
  await settle();
  await new Promise((resolve) => setTimeout(resolve, SEAT_POLL_MS + 5));
  await settle();
  flushSync(() => undefined);
  expect(panelState(host)).toBe("draft");

  flushSync(() => confirmButton(host).click());
  await settle();
  expect(seatPosts).toHaveLength(1);
  expect(seatPosts[0]!.replaceIncumbent).toBe(true);

  /* A first-ever orchestrator claims nothing of the kind. */
  seatPosts = [];
  seatStatus = { seat: null, pending: null, exists: true };
  const fresh = remount();
  await settle();
  flushSync(() => confirmButton(fresh).click());
  await settle();
  expect(seatPosts[0]!.replaceIncumbent).toBeUndefined();
}, SEAT_POLL_MS + 4_000);

test("coming back to a project paints its conversation in the first commit, transcript and all", async () => {
  seatStatus = { seat: activeSeat(), pending: null, exists: true };
  incumbentStatus = incumbent();
  tailLines.set(orchestratorFile.path, [
    JSON.stringify({ type: "assistant", uuid: "uuid-atlas-1", timestamp: "2026-08-13T10:05:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "Atlas mandate accepted." }] } }),
  ]);

  const dock = mountDock([orchestratorFile]);
  dock.open("atlas");
  await settle();
  flushSync(() => undefined);
  expect(panelState(dock.host)).toBe("live");
  expect(dock.host.querySelector('[data-orchestrator-conversation="conversation_orch"]')).not.toBeNull();
  expect(dock.host.textContent).toContain("Atlas mandate accepted.");

  /* A project with no orchestrator of its own: its own draft, its own read. */
  dock.open("borealis");
  await settle();
  expect(panelState(dock.host)).toBe("draft");

  /* Back to atlas. Nothing is awaited: this is the frame the switch itself
     produced, so no round trip can have contributed to it. The conversation is
     mounted on the same file with the transcript it was left showing — never
     a loading state, never a blank column that fills in a moment later. */
  dock.open("atlas");
  expect(panelState(dock.host)).toBe("live");
  expect(dock.host.querySelector('[data-orchestrator-conversation="conversation_orch"]')).not.toBeNull();
  expect(dock.host.textContent).toContain("Atlas mandate accepted.");
  /* The incumbent header is whole too — the model is read, not degraded to the
     dash a fresh 60s-cadence status read would leave for a minute. */
  expect(dock.host.textContent).toContain("opus");

  /* The poll behind that paint still runs, and lands in place. */
  seatStatus = { seat: activeSeat({ conversationId: "conversation_successor", path: "/transcripts/successor.jsonl" }), pending: null, exists: true };
  await settle();
  expect(panelState(dock.host)).toBe("live");
});
