import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { setLocale } from "@/lib/i18n";
import { ORCHESTRATOR_PROMPT_VERSION, ORCHESTRATOR_SYSTEM_PROMPT } from "@/lib/orchestrator/prompt";
import type { FileEntry } from "@/lib/types";

/*
 * The per-project orchestrator panel end to end (issue #977 acceptance):
 * the draft creates through the SEAT route on either engine, a double-click or
 * a retry cannot designate twice, and every state in the map renders — with the
 * stored terminal error always visible and always retryable.
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
mock.module("@/hooks/useLogTail", () => ({
  useLogTail: () => ({
    lines: [], linesStart: 0, size: 0, loading: false, error: null, tickTime: null,
    paused: false, setPaused: () => undefined, clear: () => undefined,
    hasMore: false, loadingOlder: false, loadOlder: async () => 0, prependGen: 0,
  }),
}));

const { OrchestratorPanel } = await import("./OrchestratorPanel");

const accounts = {
  claude: { active: "primary", accounts: [{ id: "primary", label: "primary", authPresent: true }, { id: "spare", label: "spare", authPresent: true }] },
  codex: { active: "codex-primary", accounts: [{ id: "codex-primary", label: "codex-primary", authPresent: true }] },
};

interface SeatFile {
  seat: Record<string, unknown> | null;
  pending: Record<string, unknown> | null;
  exists: boolean;
}

let seatStatus: SeatFile;
let seatPosts: Record<string, unknown>[];
let spawnPosts: number;
/** Queued answers for the confirm POST, oldest first; the last one repeats. */
let seatResponses: { status: number; body: Record<string, unknown> | null; throws?: boolean }[];
const realFetch = globalThis.fetch;

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/orchestrator/seat" && init?.method === "POST") {
      seatPosts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const answer = seatResponses.length > 1 ? seatResponses.shift()! : seatResponses[0]!;
      if (answer.throws) throw new Error("network dropped");
      return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body } as Response;
    }
    if (url.startsWith("/api/orchestrator/seat?")) {
      return { ok: true, status: 200, json: async () => seatStatus } as Response;
    }
    if (url === "/api/accounts") return { ok: true, status: 200, json: async () => accounts } as Response;
    if (url.startsWith("/api/spawn")) {
      spawnPosts += 1;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as Response;
  }) as typeof fetch;
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
  seatStatus = { seat: null, pending: null, exists: true };
  seatPosts = [];
  spawnPosts = 0;
  seatResponses = [{ status: 202, body: { ok: true, accepted: true, state: "accepted", conversationId: "conversation_orch", launchId: "launch-a", transport: "structured", initialMessage: "pending", seat: activeSeat() } }];
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
  expect(host.querySelector("textarea")).not.toBeNull();
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
