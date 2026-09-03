import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { translate } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

/*
 * The board on the phone (mobile v2 lane 2, README §8 row 2), mounted as the
 * project leaf it really is. happy-dom does no layout, so what this guards is
 * the contract behind the frames the capture harness measures in Chromium:
 *
 *   - with no conversation on top of the stack the leaf is the BOARD: the seat
 *     first, then Needs you, the pipelines summary above Working while a
 *     pipeline runs, and three Recent rows over the catalog;
 *   - the board carries NO Host section — host detail is one tap away, in the
 *     host sheet behind ⋯ › Host details, and nowhere else;
 *   - the bar's badge counts the Needs-you rows, conversations and pipelines;
 *   - opening a row stamps the card seen (#1244) and pushes the conversation
 *     over the board, so ‹ returns to the list.
 */

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualConversationCatalogHooks = await import("@/hooks/useConversationCatalog");
const inertRuntime = { enabled: false, connection: "live" as const, resyncedAt: null, store: emptyStore(), structuredHostsEnabled: false, lastEventAt: null };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => inertRuntime,
  useRuntime: () => inertRuntime,
  useRuntimeSelector: (selector: (state: typeof inertRuntime) => unknown) => selector(inertRuntime),
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
mock.module("@/hooks/useConversationCatalog", () => ({
  useConversationCatalog: () => ({
    items: [], nextCursor: null, total: 0, loading: false, error: false, loadMore: () => {}, retry: () => {},
  }),
}));

const { ProjectDashboard } = await import("@/components/ProjectDashboard");
const { MobileSheet } = await import("@/components/mobile/MobileSheet");
const { getMobileNav, topScreen } = await import("@/components/mobile/mobileNav");
const { receipts } = await import("@/components/mobile/MobileReceipt");
const { resetOrchestratorSeatCacheForTests } = await import("@/components/orchestrator/useOrchestratorSeat");
const { buildMobileBoard, needsDecisionPipelineRows } = await import("@/components/mobile/mobileBoardModel");
const { formatResetClock } = await import("@/components/rateLimit");
type MobileShellHost = NonNullable<React.ComponentProps<typeof ProjectDashboard>["mobileShell"]>;

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
const G = globalThis as Record<string, unknown>;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: /max-width|pointer: coarse/.test(String(query)),
  media: String(query), onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
});

let boardRevision = 1;
let boardPrefs: Record<string, unknown> = {};
let mutations: Array<Record<string, unknown>> = [];
const emptyPrefs = () => ({
  manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [],
  expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: false, seenAt: {},
});
const boardState = () => ({
  schemaVersion: 1, revision: boardRevision, updatedAt: new Date(0).toISOString(),
  pathAliases: {}, explicitManual: [], prefs: { ...emptyPrefs(), ...boardPrefs },
});
const jsonResponse = (body: unknown) => ({
  ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
});

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
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/board")) {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as {
          patch?: Record<string, unknown>;
          mutations?: Array<Record<string, unknown>>;
        };
        for (const mutation of body.mutations ?? []) mutations.push(mutation);
        if (body.patch) boardPrefs = { ...boardPrefs, ...body.patch };
        boardRevision += 1;
      }
      return jsonResponse({ board: boardState() });
    }
    if (url.startsWith("/api/conversations")) return jsonResponse({ items: [], nextCursor: null });
    /* No orchestrator seat in this project by default: the board's seat slot
       invites one and no row is filtered out of the sections. A test that needs
       the footer seats one first. */
    if (url.startsWith("/api/orchestrator/seat")) {
      seatReads += 1;
      return jsonResponse({ seat: seatAnswer, pending: null, exists: true });
    }
    if (url.startsWith("/api/limits")) return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
    return jsonResponse({});
  }) as unknown as typeof fetch,
};
/** The project's seat, as `/api/orchestrator/seat` answers it; null by default. */
let seatAnswer: Record<string, unknown> | null = null;
/** How many times this phone has asked for it. */
let seatReads = 0;

const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};

const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
const waitFor = async (pred: () => boolean, timeoutMs = 4000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return pred();
};

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
  (dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useConversationCatalog", () => actualConversationCatalogHooks);
});

const PROJECT = "atlas";
const NOW = Math.floor(Date.now() / 1000);

const file = (over: Partial<FileEntry> & { path: string }): FileEntry => ({
  root: "claude-projects", name: over.path.split("/").pop(), project: PROJECT,
  title: "A conversation", engine: "claude", kind: "session", fmt: "claude", parent: null,
  mtime: NOW - 120, size: 2_048, activity: "idle", proc: null, pid: null, model: "opus",
  pendingQuestion: null, waitingInput: null, conversationId: `conversation_${over.path}`,
  ...over,
} as unknown as FileEntry);

const asking = file({
  path: "/repo/ask.jsonl",
  title: "Implement the export endpoint",
  activity: "live", proc: "running", pid: 4_402,
  lastTurn: { startedAt: (NOW - 600) * 1_000, endedAt: null },
  pendingQuestion: {
    kind: "question", toolUseId: "toolu-export", transcriptPath: "/repo/ask.jsonl", pid: 4_402, paneTarget: null,
    askedAt: new Date((NOW - 540) * 1_000).toISOString(),
    questions: [{ question: "Which format?", header: "Format", multiSelect: false, options: [] }],
  },
} as unknown as Partial<FileEntry> & { path: string });

const running = file({
  path: "/repo/run.jsonl",
  title: "Rebuild the board status projection",
  activity: "live", proc: "running", pid: 4_401, mtime: NOW - 30,
  lastTurn: { startedAt: (NOW - 760) * 1_000, endedAt: null },
  plan: { steps: [], done: 2, total: 5, current: "Add the held precedence", updatedAt: null },
} as unknown as Partial<FileEntry> & { path: string });

const finished = file({ path: "/repo/done.jsonl", title: "Tail: pipeline archive TTL", activity: "recent", mtime: NOW - 900 });

/* A conversation stopped at its account's wall, with both halves of what
   the row must say: which account, and when the window reopens. */
const RESET_AT = NOW + 1_800;
const limited = file({
  path: "/repo/limit.jsonl", title: "Draft the release notes", activity: "idle", mtime: NOW - 240,
  rateLimit: { source: "account", accountId: "Main", window: "session", resetAt: RESET_AT },
} as unknown as Partial<FileEntry> & { path: string });

/* A parentless background process: host data, never a board row. */
const backgroundTask = file({
  path: "/repo/next-dev.log", name: "next-dev.log", title: "next dev · port 8899", cmdDesc: "next dev · port 8899",
  engine: "shell", kind: "task", fmt: "text", activity: "live", proc: "running", pid: 41_822, model: null,
} as unknown as Partial<FileEntry> & { path: string });

const decisionPipeline = {
  id: "pipeline_atlas_p2", task: "Fast conversation switching", taskIds: [], project: PROJECT,
  repoDir: "/repo", worktreeDir: "/repo-p2", branch: "lane/p2", baseBranch: "main", baseRef: "main",
  lastPassedCommit: "", stages: [{ id: "implement", kind: "run" }, { id: "review", kind: "review-loop" }],
  runs: [{ stageId: "review", attempts: [{ n: 3, state: "failed", verdict: { status: "fail", findings: ["one", "two"] }, completedAt: new Date((NOW - 3_600) * 1_000).toISOString() }] }],
  cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null },
  state: "needs_decision", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
  createdAt: new Date((NOW - 7_200) * 1_000).toISOString(), closedAt: null,
} as unknown as Pipeline;

const runningPipeline = { ...decisionPipeline, id: "pipeline_atlas_p1", task: "Mobile redesign", state: "running", runs: [] } as unknown as Pipeline;

let sheetOpens: string[] = [];
let opened: string[] = [];
const host = (attentionCount: number): MobileShellHost => ({
  attentionCount,
  arrival: null,
  renderSheet: (name, close) => {
    sheetOpens.push(name);
    return (
      <MobileSheet name={name} title={name} onClose={close}>
        <div data-testid={`${name}-sheet-stub`} />
      </MobileSheet>
    );
  },
});

const dashboardProps = (over: Partial<React.ComponentProps<typeof ProjectDashboard>> = {}) => ({
  files: [asking, running, finished], flows: [], pipelines: [], workflows: [], tasks: [],
  project: PROJECT, loaded: true, openNonce: 0, archived: false,
  catalogKnown: true, catalogConversationCount: 12,
  projectCwd: "/repo",
  onArchive: () => {}, onUnarchive: () => {},
  onOpenSearch: () => {},
  onOpenCatalogFile: (entry: FileEntry) => { opened.push(entry.path); },
  mobileShell: host(1),
  ...over,
});

let roots: Root[] = [];
beforeEach(() => {
  roots = [];
  sheetOpens = [];
  opened = [];
  mutations = [];
  boardRevision = 1;
  boardPrefs = {};
  dom.document.body.replaceChildren();
  dom.document.body.style.overflow = "";
  dom.sessionStorage.clear();
  dom.localStorage.clear();
  dom.location.hash = "#p=" + encodeURIComponent(PROJECT);
  getMobileNav().home();
  receipts.dismiss();
  seatAnswer = null;
  seatReads = 0;
  /* The seat read is cached per project for the whole module (#1149), so a
     test that seats one has to start from an unanswered cache. */
  resetOrchestratorSeatCacheForTests();
});
afterEach(async () => { for (const root of roots) flushSync(() => root.unmount()); roots = []; receipts.dismiss(); await settle(); });

function mount(over: Partial<React.ComponentProps<typeof ProjectDashboard>> = {}): HTMLElement {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  flushSync(() => root.render(<ProjectDashboard {...dashboardProps(over)} />));
  roots.push(root);
  return container as unknown as HTMLElement;
}

const q = (root: HTMLElement, selector: string) => root.querySelector(selector) as unknown as HTMLElement | null;
const all = (root: HTMLElement, selector: string) => Array.from(root.querySelectorAll(selector)) as unknown as HTMLElement[];
const click = (el: HTMLElement | null) => { expect(el).not.toBeNull(); flushSync(() => el!.click()); };
const board = (root: HTMLElement) => q(root, "[data-mobile2-board]");
const sections = (root: HTMLElement) => all(root, "[data-mobile2-section]").map((el) => el.getAttribute("data-mobile2-section"));

test("with no conversation focused the phone leaf is the board: the seat first, the queue, then Working and Recent", async () => {
  const root = mount({ pipelines: [decisionPipeline, runningPipeline] });
  expect(await waitFor(() => board(root) !== null)).toBe(true);
  expect(q(root, '[data-mobile2-screen="board"]')).not.toBeNull();
  /* The focus view is not mounted: one primary surface at a time. */
  expect(q(root, '[data-testid="mobile-chat-shell"]')).toBeNull();
  expect(sections(root)).toEqual(["orchestrator", "needs", "pipelines", "working", "recent"]);
  /* The seat card leads, above every section row. */
  expect(q(root, '[data-testid="mobile-orchestrator-slot"]')).not.toBeNull();

  const rows = all(root, "[data-mobile2-row]");
  const kinds = rows.map((row) => row.getAttribute("data-mobile2-row"));
  expect(kinds).toEqual(["conversation", "pipeline", "pipelines", "conversation", "conversation", "catalog"]);
  /* The queue holds both item kinds; the badge on the waiting row names the
     decision, and the working row says what the agent is doing now. */
  expect(rows[0]!.textContent).toContain("Implement the export endpoint");
  expect(rows[0]!.textContent).toContain(translate("en", "mobile2.board.badgeQuestion"));
  expect(rows[1]!.textContent).toContain("Fast conversation switching");
  expect(rows[1]!.textContent).toContain(translate("en", "mobile2.board.badgeDecision"));
  /* «stage 2/2 · review loop failed · 2 findings»: the stage in the product's
     own word for it, never the raw stage id. */
  expect(rows[1]!.textContent).toContain(translate("en", "mobile2.board.pipelineStageFailed", {
    stage: 2, total: 2, name: translate("en", "pipelineStrip.reviewStage"),
  }));
  expect(rows[1]!.textContent).toContain(translate("en", "mobile2.board.pipelineFindings", { count: 2 }));
  expect(rows[1]!.textContent).not.toContain("review failed");
  /* Every row keeps its 8 px dot column — hidden on an edged row rather than
     dropped — so an edged title and an unedged one start on the same line
     (the prototype's `.row.wait .dot { visibility: hidden }`). */
  for (const row of [rows[0]!, rows[1]!, rows[3]!]) {
    const dot = row.querySelector("span[aria-hidden]") as unknown as HTMLElement;
    expect(dot.className).toContain("h-2");
    expect(dot.className).toContain("w-2");
  }
  expect((rows[0]!.querySelector("span[aria-hidden]") as unknown as HTMLElement).className).toContain("invisible");
  expect((rows[1]!.querySelector("span[aria-hidden]") as unknown as HTMLElement).className).toContain("invisible");
  expect((rows[3]!.querySelector("span[aria-hidden]") as unknown as HTMLElement).className).not.toContain("invisible");
  expect(rows[3]!.textContent).toContain("Add the held precedence");
  expect(rows[5]!.textContent).toContain(translate("en", "mobile2.board.catalogCount", { count: 12 }));
});

test("the board has no Host section: background processes are rows in the host sheet behind ⋯", async () => {
  const root = mount({ files: [asking, running, finished, backgroundTask] });
  expect(await waitFor(() => board(root) !== null)).toBe(true);
  expect(board(root)!.textContent).not.toContain("next dev · port 8899");
  expect(sections(root)).not.toContain("host");
  /* Nor a docked strip above the board, which is what the phone used to show. */
  expect(q(root, "[data-mobile2-host-tasks]")).toBeNull();

  click(q(root, '[data-mobile2-open="menu"]'));
  await settle();
  click(q(root, '[data-mobile2-open="host"]'));
  await settle();
  const sheet = q(root, '[data-mobile2-sheet="host"]')!;
  expect(sheet).not.toBeNull();
  expect(sheet.textContent).toContain("next dev · port 8899");
  expect(sheet.textContent).toContain(translate("en", "mobile2.host.pid", { pid: 41_822 }));
});

test("the Needs-you rows the bar's badge counts are the conversations queued and the pipelines waiting on a decision", async () => {
  const root = mount({ pipelines: [decisionPipeline, runningPipeline], mobileShell: host(2) });
  expect(await waitFor(() => board(root) !== null)).toBe(true);
  const rows = all(root, "[data-mobile2-row]").filter((row) => ["conversation", "pipeline"].includes(row.getAttribute("data-mobile2-row") ?? ""));
  const queued = rows.filter((row) => row.closest("[data-mobile2-board]") && ["waiting", "needs_decision", "stalled", "limit"].includes(row.getAttribute("data-mobile2-state") ?? ""));
  expect(queued).toHaveLength(2);
  /* The count is not this leaf's arithmetic: the badge, the queue sheet and
     its «Next ›» read ONE list, scoped to the project behind the badge, and
     the Viewer composes it from the same pure answer that put these rows on
     the board (`Viewer.switching.dom.test.tsx` proves the scoping over two
     projects). What this asserts is that the answer under the rows and the
     number over them are the same number. */
  const model = buildMobileBoard({
    files: [asking, running, finished],
    pipelines: [decisionPipeline, runningPipeline],
    project: PROJECT,
    now: NOW,
  });
  expect(model.attentionCount).toBe(queued.length);
  expect(needsDecisionPipelineRows([decisionPipeline, runningPipeline], PROJECT, NOW)).toHaveLength(1);
  const badge = q(root, "[data-mobile2-attention-count]")!;
  expect(badge).not.toBeNull();
  expect(badge.getAttribute("data-mobile2-attention-count")).toBe(String(model.attentionCount));
  expect(badge.getAttribute("aria-label")).toBe(translate("en", "mobile2.bar.attention", { count: model.attentionCount }));
});

test("opening a board row stamps the card seen (#1244) and pushes the conversation over the board", async () => {
  const root = mount();
  expect(await waitFor(() => board(root) !== null)).toBe(true);
  expect(mutations.filter((mutation) => mutation.kind === "mark-seen")).toEqual([]);

  const row = all(root, '[data-mobile2-row="conversation"]').find((el) => el.getAttribute("data-mobile2-path") === finished.path)!;
  expect(row).toBeDefined();
  click(row);
  await settle();

  /* The open gesture: the durable acknowledgement, the conversation screen on
     top of the board, and that conversation under it. */
  const seen = mutations.filter((mutation) => mutation.kind === "mark-seen");
  expect(seen).toHaveLength(1);
  expect(String(seen[0]!.id)).toContain("conversation_/repo/done.jsonl");
  expect(topScreen(getMobileNav().getState())).toEqual({ kind: "chat", id: finished.path });
  expect(await waitFor(() => board(root) === null)).toBe(true);
  /* The conversation screen names itself in the BAR's title cell (mobile v2
     lane 3): the pane it opens carries no header of its own. */
  expect(q(root, '[data-testid="mobile-focused-pane"]')).not.toBeNull();
  expect(q(root, "[data-mobile2-title-text]")?.textContent).toContain(finished.title);
  /* The row places its node itself and does NOT go through the catalog
     resolver. That resolver lands by resetting the shell to the board
     (`nav.home()`, which predates the conversation screen), so routing a row
     through it collapsed the screen this very gesture had just pushed and
     re-pushed it from an effect — the conversation mounted twice with a frame
     of board between. Nothing on this list needs what the resolver adds: a
     board row is a file the scan already carries, never a beyond-cap pin. */
  expect(opened).toEqual([]);

  /* ‹ pops back to the list the operator came from, and stays there. (What
     the pop replays is the Viewer's own focus entry, so the replay itself is
     driven — and its red proved — in `Viewer.switching.dom.test.tsx`.) */
  click(q(root, "[data-mobile2-back]"));
  await settle();
  expect(await waitFor(() => board(root) !== null)).toBe(true);
  expect(topScreen(getMobileNav().getState())).toEqual({ kind: "board" });

  /* Backing out is not a lock: the same row opens again. */
  click(all(root, '[data-mobile2-row="conversation"]').find((el) => el.getAttribute("data-mobile2-path") === finished.path)!);
  await settle();
  expect(topScreen(getMobileNav().getState())).toEqual({ kind: "chat", id: finished.path });
});

test("the board's footer lands the operator in the orchestrator's conversation, and invites one when there is none", async () => {
  /* README §4.1 and §7 Q2: one 44 px target, one tap to the orchestrator. It
     never sends from the board — the reply is written in the conversation. */
  const root = mount();
  expect(await waitFor(() => board(root) !== null)).toBe(true);
  /* Over a vacancy the slot is the invitation's other half (lane 6): it says
     what the board is missing instead of offering to talk to nothing. */
  const empty = q(root, "[data-mobile2-board-dock]")!;
  expect(empty).not.toBeNull();
  expect(empty.textContent).toContain(translate("en", "mobile2.seat.createDock"));

  seatAnswer = {
    project: PROJECT, seatEpoch: 1, conversationId: "conversation_atlas_orchestrator", path: running.path,
    mandate: "Run the atlas board.", state: "active", designatedAt: "2100-01-02T13:00:00.000Z",
    intent: { clientRequestId: "seat-atlas-1", mode: "existing", launchId: null, error: null },
  };
  resetOrchestratorSeatCacheForTests();
  const seated = mount();
  /* The slot is there either way now, so what is waited for is the seat read
     landing — the footer changing from the invitation to the conversation. */
  expect(await waitFor(() => q(seated, "[data-mobile2-board-dock]")?.textContent?.includes(translate("en", "mobile2.board.tellOrchestrator")) === true)).toBe(true);
  const dock = q(seated, "[data-mobile2-board-dock]")!;
  expect(dock.getAttribute("aria-label")).toBe(translate("en", "mobile2.board.tellOrchestratorLabel"));
  expect(dock.className).toContain("min-h-11");
  /* The seat is the card above the sections, never a row inside them. */
  expect(all(seated, '[data-mobile2-row="conversation"]').map((row) => row.getAttribute("data-mobile2-path")))
    .not.toContain(running.path);

  click(dock);
  await settle();
  expect(topScreen(getMobileNav().getState())).toEqual({ kind: "chat", id: running.path });
  expect(q(seated, '[data-testid="mobile-focused-pane"]')).not.toBeNull();
  expect(q(seated, "[data-mobile2-title-text]")?.textContent).toContain(running.title);
  /* Same open as a row's, and the same reason it is not the resolver's. */
  expect(opened).toEqual([]);
});

test("a row at its account's limit says which account and when the window reopens", async () => {
  /* README §4.1: the state phrase is what the operator is waiting on, and for
     a wall that is the clock — «Main resets 16:40». The read carries both
     halves; a row that only said «at the account limit» made the operator open
     the conversation to find out when to come back. */
  const root = mount({ files: [asking, running, finished, limited] });
  expect(await waitFor(() => board(root) !== null)).toBe(true);
  const row = all(root, '[data-mobile2-row="conversation"]').find((el) => el.getAttribute("data-mobile2-path") === limited.path)!;
  expect(row).toBeDefined();
  /* A wall needs the operator, so the row is in the queue, edged and badged. */
  expect(row.getAttribute("data-mobile2-state")).toBe("limit");
  expect(row.textContent).toContain(translate("en", "mobile2.board.badgeLimit"));
  expect(q(row, "[data-mobile2-phrase]")!.textContent).toBe(translate("en", "mobile2.board.limitAccountResets", {
    account: "Main", time: formatResetClock(RESET_AT, NOW),
  }));
});

test("the phone reads the seat ONCE: the board keeps it out of the list and the card renders from the same answer", async () => {
  /* Both readers need the same fact — the board, to keep the seat out of the
     sections; the card, to show its state — and the read is a 6 s poll, so a
     second instance for the same key doubled every phone's seat traffic to
     answer one question. */
  seatAnswer = {
    project: PROJECT, seatEpoch: 1, conversationId: "conversation_atlas_orchestrator", path: running.path,
    mandate: "Run the atlas board.", state: "active", designatedAt: "2100-01-02T13:00:00.000Z",
    intent: { clientRequestId: "seat-atlas-1", mode: "existing", launchId: null, error: null },
  };
  resetOrchestratorSeatCacheForTests();
  seatReads = 0;
  const root = mount();
  /* The dock is in the slot either way now, so the seat read landing is what
     is waited for: the footer says «Tell the orchestrator…» only once it has. */
  expect(await waitFor(() => q(root, "[data-mobile2-board-dock]")?.textContent?.includes(translate("en", "mobile2.board.tellOrchestrator")) === true)).toBe(true);

  /* The board has the answer: the seat's conversation is the card, not a row. */
  expect(all(root, '[data-mobile2-row="conversation"]').map((el) => el.getAttribute("data-mobile2-path")))
    .not.toContain(running.path);
  /* And so does the card: it is seated — the invitation is gone — from the
     same answer, without a read of its own. */
  const card = q(root, '[data-testid="mobile-orchestrator-slot"] [data-mobile2-seat-card]')!;
  expect(card.getAttribute("data-mobile2-seat-state")).toBe("live");
  expect(card.getAttribute("data-mobile2-seat-shape")).toBe("seat");
  expect(card.getAttribute("data-mobile2-seat-tap")).toBe("conversation");
  expect(seatReads).toBe(1);
});
