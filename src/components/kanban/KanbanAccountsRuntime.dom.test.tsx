import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

import type { PatchPipelineRequest, Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { ConversationMigration, FileEntry } from "@/lib/types";

import { stageDigest, stageDigests } from "@/lib/pipelines/stageDigest";
import { emptyStore, installSnapshot, type RuntimeSnapshot } from "@/components/runtime/runtimeModel";
import type { RuntimeBus, RuntimeBusState } from "@/hooks/runtimeBus";

import type { PipelinePorts, PipelineWriteResult } from "./pipelinePorts";
import type { TaskMutationPorts } from "./useTaskMutations";

/* A conversation's account switch as the runtime session reports it (#1695
   K6): the journal projects a queued reconfigure on the session
   (`pendingReconfigure`, with the account it names) for every page. A page
   that never sent the switch, or was reloaded since, reports it from there and
   offers no second switch. Invented records; the runtime store is installed
   from a snapshot and every route answers from stubs; no account is switched. */

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const dom = new Window({ url: "http://localhost/", width: 1440, height: 900 });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
  File: dom.File,
  FileReader: dom.FileReader,
  IntersectionObserver: undefined,
  ResizeObserver: TestResizeObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(dom.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });

const NOW = 1_800_000_000;
const RESET = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
const account = (id: string, label: string, plan: string, usedPercent: number) => ({
  id, label, kind: "managed", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null,
  auth: { state: "authenticated", plan }, limits: { state: "fresh", session: { usedPercent, resetsAt: RESET, windowMinutes: 300 }, weekly: null },
});
const ACCOUNTS = {
  claude: { active: "default", accounts: [account("default", "Account A", "Max", 72), account("account-c", "Account C", "Max", 18), account("account-g", "Account G", "Pro", 41), account("account-e", "Account E", "Pro", 100)], mutationLocked: false, migration: null, autoBalance: null },
  codex: { active: "default", accounts: [account("default", "Account B", "Pro", 35)], mutationLocked: false, migration: null, autoBalance: null },
};
/* Claude work in this project may use accounts A, C and E. */
const BINDINGS = { project: "fixture", engines: { claude: { engine: "claude", restricted: true, allowed: ["default", "account-c", "account-e"].map((accountId) => ({ accountId, label: accountId })) }, codex: { engine: "codex", restricted: false, allowed: [{ accountId: "default", label: "Account B" }] } } };

/* The conversation host route: every switch the board sent, answered as `hostAnswer` says. */
const hostRequests: Array<Record<string, unknown>> = [];
const migrationRequests: Array<Record<string, unknown>> = [];
let hostAnswer: "queued" | "lost" | { status: number; error: string } = "queued";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith("/api/logs")) {
    const { reqs } = JSON.parse(String(init?.body ?? "{}")) as { reqs: Array<{ id: string }> };
    return json({ chunks: Object.fromEntries(reqs.map((req) => [req.id, { data: "", start: 0, offset: 0, size: 0 }])) });
  }
  if (url === "/api/accounts") return json(ACCOUNTS);
  if (url.startsWith("/api/account-project-bindings?project=")) return json(BINDINGS);
  if (/^\/api\/conversations\/[^/]+\/migration$/.test(url)) {
    migrationRequests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return json({ withdraw: "withdrawn" });
  }
  if (url === "/api/conversation-host") {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    hostRequests.push(body);
    if (hostAnswer === "lost") throw new TypeError("Failed to fetch");
    if (typeof hostAnswer === "object") return json({ error: hostAnswer.error }, hostAnswer.status);
    const operationId = `op-${hostRequests.length}`;
    const outside = !["default", "account-c", "account-e"].includes(String(body.accountId));
    return json({ ok: true, structured: true, operationId, receipt: { operationId, status: "queued" }, ...(outside ? { accountOverride: { outsidePool: true, recorded: true } } : {}) }, 202);
  }
  return json({});
}) as unknown as typeof fetch;

function inertRuntimeState(): RuntimeBusState {
  return { store: emptyStore(), connection: "offline", resyncedAt: null, lastEventAt: null, enabled: false, structuredHostsEnabled: false };
}
let runtimeState = inertRuntimeState();
const runtimeListeners = new Set<() => void>();
const runtimeBus: RuntimeBus = {
  getState: () => runtimeState,
  subscribe: (listener) => { runtimeListeners.add(listener); return () => runtimeListeners.delete(listener); },
  subscribeFilesRevision: () => () => {},
  start: () => {},
  stop: () => {},
  refresh: async () => true,
};
const actualRuntimeBus = await import("@/hooks/runtimeBus");
mock.module("@/hooks/runtimeBus", () => ({ ...actualRuntimeBus, getRuntimeBus: () => runtimeBus, isRuntimeUiEnabled: () => true }));
afterAll(() => {
  mock.module("@/hooks/runtimeBus", () => actualRuntimeBus);
});

const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { KanbanBoard } = await import("./KanbanBoard");
const { readPickedAccount, resetPickedAccountsForTests, setPickedAccount } = await import("@/lib/accounts/intendedAccount");
const { conversationIdentity } = await import("@/lib/accounts/identity");

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
  localStorage.clear();
  hostRequests.length = 0;
  migrationRequests.length = 0;
  hostAnswer = "queued";
  runtimeState = inertRuntimeState();
  resetPickedAccountsForTests();
});

const REV = (n: number) => ["task-v1:00000000", "0000", "4000", "8000", String(n).padStart(12, "0")].join("-");
const iso = (secondsAgo: number) => new Date((NOW - secondsAgo) * 1000).toISOString();

function conversation(name: string, over: Partial<FileEntry> = {}): FileEntry {
  return {
    path: `/fixture/${name}.jsonl`, conversationId: `conversation_${name}`, title: name, project: "fixture", root: "claude-projects", kind: "session", fmt: "claude",
    engine: "claude", mtime: NOW - 600, size: 0, activity: "idle", proc: null, pid: null, parent: null, model: "opus", pendingQuestion: null, waitingInput: null, name,
    ...over,
  } as FileEntry;
}

const role = (roleId: string) => ({ roleId, engine: "claude", model: "opus", effort: "high", access: "read-write", promptScaffold: null });
const stage = (id: string, roleId: string, next: string | null, over: Record<string, unknown> = {}) => ({ id, kind: "run", role: { roleId }, prompt: `{{prev.output}}\n\nStage ${id}.`, next, onFail: null, effectiveRole: role(roleId), ...over });
const attempt = (n: number, state: string, file: FileEntry, over: Record<string, unknown> = {}) => ({
  n, state, effectiveRole: role("verifier"), launchId: null, conversationId: file.conversationId, sessionId: null, agentPath: file.path, paneId: null, flowId: null,
  startedAt: iso(1200), completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null, ...over,
});

const build = conversation("build-1");
const verify = conversation("verify-1", { effort: "high", activity: "live", proc: "running", pid: 4401, authoritativeTurn: { state: "busy", source: "lifecycle", terminalAt: null }, lastTurn: { startedAt: (NOW - 400) * 1000, endedAt: null } } as Partial<FileEntry>);

function searchPipeline(merge: Record<string, unknown> = {}, verifyAttempt: Record<string, unknown> = {}): Pipeline {
  return {
    id: "p-search", task: "Restore search results", taskIds: ["t-search"], project: "fixture", state: "running", branch: "pipeline/search",
    stages: [stage("build", "builder", "verify"), stage("verify", "verifier", "merge"), stage("merge", "cleaner", null, merge)],
    runs: [
      { stageId: "build", attempts: [attempt(1, "passed", build)] },
      { stageId: "verify", attempts: [attempt(1, "running", verify, verifyAttempt)] },
    ],
    cursor: { stageId: "verify", state: "running", input: null, activatedBy: null },
    worktreeDir: "/fixture/worktree", createdAt: iso(9000),
  } as unknown as Pipeline;
}

const idlePorts: TaskMutationPorts = { patch: async () => ({ ok: false, status: 500, error: "unused" }), read: async () => null, changed: () => {} };
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/* The pipeline route: the engine's digest guard and the binding's refusal decide against the record as it is then. */
function pipelineRoute(stored: () => Pipeline) {
  const patches: PatchPipelineRequest[] = [];
  const reads: string[] = [];
  const state = { answers: [] as PipelineWriteResult[], record: null as Pipeline | null, beforeWrite: null as (() => void) | null };
  const ports: PipelinePorts = {
    read: async (id) => {
      reads.push(id);
      const pipeline = state.record ?? stored();
      return { pipeline, stageDigests: stageDigests(pipeline.stages) };
    },
    patch: async (_id, body) => {
      patches.push(body);
      const queued = state.answers.shift();
      if (queued) return queued;
      state.beforeWrite?.();
      state.beforeWrite = null;
      const current = state.record ?? stored();
      const target = current.stages.find((entry) => entry.id === body.stageId);
      if (body.action === "override-stage" && target && body.expectedStageDigest !== undefined && stageDigest(target) !== body.expectedStageDigest) {
        return { ok: false, status: 409, error: "the stage changed since it was read; read it again before overriding it", code: "STAGE_CHANGED", field: "expectedStageDigest" };
      }
      return { ok: true, pipeline: current };
    },
    refresh: () => {},
  };
  return { ports, patches, reads, state };
}

function mount(pipeline: Pipeline, files: FileEntry[] = [build, verify]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  let current = pipeline;
  let currentFiles = files;
  const route = pipelineRoute(() => current);
  const render = () => flushSync(() => root.render(
    <KanbanBoard
      project="fixture"
      groups={[]}
      manual={[]}
      files={currentFiles}
      flows={[]}
      pipelines={[current]}
      tasks={[]}
      allTasks={[{ id: "t-search", project: "fixture", text: "Restore search results after the index rebuild", status: "assigned", placement: "unplaced", assignments: [], createdAt: iso(9000), updatedAt: iso(600), revision: REV(1) } as BoardTask]}
      drafts={[]}
      now={NOW}
      loaded
      catalogFailures={0}
      selection={new Set()}
      onOpenConversations={() => {}}
      seatRefs={null}
      mutationPorts={idlePorts}
      pipelinePorts={route.ports}
      readerStorage={null}
    />,
  ));
  render();
  return {
    host,
    route,
    update(next: { pipeline?: Pipeline; files?: FileEntry[] }) {
      if (next.pipeline) current = next.pipeline;
      if (next.files) currentFiles = next.files;
      render();
    },
  };
}

const card = (host: HTMLElement) => host.querySelector<HTMLElement>('.card[data-id="task:t-search"]')!;
const click = (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  flushSync(() => (element as HTMLElement).click());
};
const press = (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  (element as HTMLElement).focus();
  click(element);
};
const same = (actual: unknown, expected: unknown) => expect(actual === expected && expected !== null && expected !== undefined).toBe(true);
const receiptTexts = (host: HTMLElement) => [...host.querySelectorAll("[data-kanban-receipt] .msg")].map((node) => node.textContent);
const picker = (host: HTMLElement) => host.querySelector<HTMLElement>(".popover.acct-pop");
const rows = (host: HTMLElement) => [...(picker(host)?.querySelectorAll<HTMLElement>(".acct-row") ?? [])].map((row) => ({
  id: row.dataset.account,
  name: row.querySelector(".nm")?.textContent,
  tag: row.querySelector(".tag")?.textContent,
  checked: row.getAttribute("aria-checked") === "true",
  disabled: row.getAttribute("aria-disabled") === "true",
}));
const row = (host: HTMLElement, id: string) => picker(host)!.querySelector<HTMLElement>(`.acct-row[data-account="${id}"]`);
const stageChip = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-account-trigger="stage:p-search:merge"]');
const conversationChip = (host: HTMLElement) => host.querySelector<HTMLElement>(`[data-account-trigger="${verify.conversationId}"]`);
const chipText = (chip: HTMLElement | null) => [...(chip?.querySelectorAll(".cur, .arrow, .to, .when") ?? [])].map((node) => node.textContent).join(" ");
const kv = (host: HTMLElement) => [...(picker(host)?.querySelectorAll(".acct-now .kv") ?? [])].map((line) => [line.querySelector(".k")?.textContent, line.querySelector(".v")?.textContent]);
const notes = (host: HTMLElement) => [...(picker(host)?.querySelectorAll(".acct-sub, .note") ?? [])].map((node) => node.textContent);

async function openVerify(host: HTMLElement) {
  click(card(host).querySelector('.psummary [data-stage="verify"]'));
  await tick();
}
async function openPicker(host: HTMLElement) {
  press(conversationChip(host));
  await tick(20);
}
const closePicker = async () => {
  flushSync(() => document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event));
  await tick();
};

/** The runtime store as a fresh page reads it: this conversation's session, with the queued reconfigure it projects. */
function installRuntime(pending: { operationId: string; accountId: string | null } | null, over: { accountId?: string; turn?: "running" | "idle"; receipts?: Array<{ operationId: string; status: string; reason?: string }> } = {}) {
  const snapshot = {
    schemaVersion: 1, snapshotSeq: 1, retentionFloorSeq: 0, structuredHostsEnabled: true, runtime: { hostEpoch: 1, health: "ready" }, filesRevision: 1,
    sessions: [{
      conversationId: verify.conversationId, sessionKey: { engine: "claude", sessionId: "verify-session" }, hostKind: "claude-broker", host: "hosted", turn: over.turn ?? "running",
      provenance: "structured", revision: 1, attentionIds: [],
      recentReceipts: (over.receipts ?? []).map((receipt, index) => ({ idempotencyKey: receipt.operationId, conversationId: verify.conversationId, kind: "reconfigure", at: iso(60), revision: index + 1, ...receipt })),
      accountId: over.accountId ?? "default", parentConversationId: null, flowId: null, workflowId: null, cwd: "/fixture", artifactPath: verify.path,
      capabilities: { steer: false, structuredAttention: true }, activeTurnId: (over.turn ?? "running") === "running" ? "turn-1" : null,
      pendingReconfigure: pending ? { operationId: pending.operationId, model: "opus", effort: "high", fast: null, ...(pending.accountId ? { accountId: pending.accountId } : {}) } : null,
    }],
    attentions: [], recentOperations: [], edges: [], flows: [], workflows: [], tasks: [], deployments: [],
  } as unknown as RuntimeSnapshot;
  runtimeState = { store: installSnapshot(snapshot), connection: "live", resyncedAt: null, lastEventAt: Date.now(), enabled: true, structuredHostsEnabled: true };
  for (const listener of runtimeListeners) flushSync(() => listener());
}

test("a pick another page queued is shown here, and a pick made here replaces it with no cancel first", async () => {
  installRuntime({ operationId: "op-elsewhere", accountId: "account-g" });
  const { host } = mount(searchPipeline());
  await tick();
  await openVerify(host);
  expect(chipText(conversationChip(host))).toBe("Account A → Account G with the next message");
  await openPicker(host);
  expect(kv(host).at(-1)).toEqual(["Pending", "Account G · moves with the next message"]);
  expect(picker(host)!.querySelector("[data-account-pending]")?.getAttribute("data-account-source")).toBe("runtime");
  /* Not this page's alone: the runtime session reports it for every page. */
  expect(notes(host)).not.toContain("Known to this page only. A reload or another page won't show this switch until the server records it.");
  /* #1846: a pick still waiting for the next message is replaced by another pick, which the queue supersedes;
     no cancel has to settle before it. */
  expect(picker(host)!.querySelector("[data-account-cancel]")?.getAttribute("data-account-cancel")).toBe("pick");
  click(row(host, "account-c"));
  expect(chipText(conversationChip(host))).toBe("Account A → Account C with the next message");
  await tick(40);
  expect(migrationRequests).toEqual([]);
  expect(hostRequests.map((body) => body.accountId)).toEqual(["account-c"]);
});

test("a switch the queue is already applying locks this page's picker: no cancel, no change, nothing sent", async () => {
  installRuntime({ operationId: "op-applying", accountId: "account-g" }, { receipts: [{ operationId: "op-applying", status: "applying" }] });
  const { host } = mount(searchPipeline());
  await tick();
  await openVerify(host);
  expect(chipText(conversationChip(host))).toBe("Account A → Account G switching…");
  await openPicker(host);
  expect(picker(host)!.querySelector("[data-account-cancel]")).toBeNull();
  expect(notes(host)).toContain("Too late to cancel: the switch has started.");
  expect(rows(host).map((entry) => [entry.id, entry.tag, entry.checked, entry.disabled])).toEqual([
    ["default", "current", false, true],
    ["account-c", "", false, true],
    ["account-g", "pending", true, true],
    ["account-e", expect.stringMatching(/^limit · resets \d/), false, true],
  ]);
  click(row(host, "account-c"));
  await tick(40);
  expect(hostRequests).toEqual([]);
  expect(migrationRequests).toEqual([]);
});

test("a superseded switch does not clear the newer target, and the migration record takes precedence once it exists", async () => {
  /* The journal failed op-1 as superseded; the session still projects op-2, the newer switch. */
  installRuntime({ operationId: "op-2", accountId: "account-c" }, { receipts: [{ operationId: "op-1", status: "failed", reason: "superseded" }, { operationId: "op-2", status: "queued" }] });
  const { host, update } = mount(searchPipeline());
  await tick();
  await openVerify(host);
  expect(chipText(conversationChip(host))).toBe("Account A → Account C with the next message");
  await openPicker(host);
  /* The newer switch is the one standing: a cancel is a pick of the running account. */
  expect(picker(host)!.querySelector("[data-account-cancel]")?.getAttribute("data-account-cancel")).toBe("pick");
  await closePicker();

  update({ files: [build, { ...verify, migration: { intentId: "intent-1", trigger: "manual", phase: "preparing", targetAccountId: "account-c", targetLabel: "account-c", failure: null, revision: 4 } }] });
  await tick();
  expect(chipText(conversationChip(host))).toBe("Account A → Account C switching…");
  await openPicker(host);
  expect(picker(host)!.querySelector("[data-account-pending]")?.getAttribute("data-account-source")).toBe("record");
  expect(picker(host)!.querySelector("[data-account-cancel]")).toBeNull();
  expect(rows(host).every((entry) => entry.disabled)).toBe(true);
  await closePicker();

  /* Applied: the session runs on the target and projects nothing pending; the accounts open again. */
  update({ files: [build, verify] });
  installRuntime(null, { accountId: "account-c", receipts: [{ operationId: "op-2", status: "applied" }] });
  await tick();
  expect(chipText(conversationChip(host))).toBe("Account C");
  await openPicker(host);
  expect(rows(host).find((entry) => entry.id === "account-g")?.disabled).toBe(false);
  expect(hostRequests).toEqual([]);
});

test("a pending change of model or effort alone is shown as it is and also locks the accounts, since a choice would replace it", async () => {
  installRuntime({ operationId: "op-settings", accountId: null });
  const { host } = mount(searchPipeline());
  await tick();
  await openVerify(host);
  expect(chipText(conversationChip(host))).toBe("Account A settings pending");
  await openPicker(host);
  expect(kv(host).at(-1)).toEqual(["Pending", "opus · high · no account change"]);
  expect(notes(host)).toContain("A change of model or effort is pending. Choosing an account now would replace it, so accounts stay unavailable while the runtime session reports it pending.");
  expect(notes(host)).not.toContain("Cancelling or changing a pending switch isn't available yet: the ways that exist today can cancel messages held for it.");
  expect(rows(host).every((entry) => entry.disabled)).toBe(true);
  expect(rows(host).find((entry) => entry.id === "default")?.checked).toBe(false);
  click(row(host, "account-c"));
  await tick(40);
  expect(hostRequests).toEqual([]);
});

test("a queued switch on an idle conversation says queued, never that it waits for a turn; its clearing is no success", async () => {
  installRuntime({ operationId: "op-idle", accountId: "account-g" }, { turn: "idle" });
  const { host } = mount(searchPipeline(), [build, { ...verify, activity: "idle", proc: null, pid: null, authoritativeTurn: { state: "idle", source: "lifecycle", terminalAt: null } } as unknown as FileEntry]);
  await tick();
  await openVerify(host);
  expect(chipText(conversationChip(host))).toBe("Account A → Account G with the next message");
  await openPicker(host);
  expect(kv(host).at(-1)).toEqual(["Pending", "Account G · moves with the next message"]);
  expect(notes(host)).toContain("No turn is running. The choice shows at once, and the conversation moves to the chosen account with its next message.");
  expect(notes(host).some((note) => /current turn/.test(note))).toBe(false);
  await closePicker();

  /* The projection clears while the conversation still runs on account A: nothing says it switched. */
  installRuntime(null, { turn: "idle" });
  await tick();
  expect(chipText(conversationChip(host))).toBe("Account A");
  const receipts = [...host.querySelectorAll("[data-kanban-receipt] .msg")].map((node) => node.textContent ?? "");
  expect(receipts.some((text) => text.includes("now runs on"))).toBe(false);
  await openPicker(host);
  expect(rows(host).find((entry) => entry.id === "account-g")?.disabled).toBe(false);
  expect(hostRequests).toEqual([]);
});

/* #1846 critique P1: the board's chip and picker read and write the one picked-account store the runtime pill,
   the card badge and the phone title use, so a pick made on any of them shows on all of them in one frame. */

test("a pick made in the runtime pill shows on the board's chip and picker in the same frame, before any projection", async () => {
  installRuntime(null);
  const { host } = mount(searchPipeline());
  await tick();
  await openVerify(host);
  expect(chipText(conversationChip(host))).toBe("Account A");
  /* What the pill's pick writes, and nothing else: no answer, no snapshot. */
  flushSync(() => setPickedAccount(conversationIdentity(verify), "account-g"));
  expect(chipText(conversationChip(host))).toBe("Account A → Account G with the next message");
  await openPicker(host);
  expect(kv(host).at(-1)).toEqual(["Pending", "Account G · moves with the next message"]);
  expect(picker(host)!.querySelector("[data-account-pending]")?.getAttribute("data-account-source")).toBe("pick");
  expect(rows(host).find((entry) => entry.id === "account-g")?.checked).toBe(true);
  expect(rows(host).find((entry) => entry.id === "account-c")?.disabled).toBe(false);
  expect(notes(host)).not.toContain("Too late to cancel: the switch has started.");
  await closePicker();
  expect(hostRequests).toEqual([]);

  /* Taken back in the pill while the projection still reports the pick: the chip follows in the same frame. */
  installRuntime({ operationId: "op-pill", accountId: "account-g" });
  flushSync(() => setPickedAccount(conversationIdentity(verify), "default"));
  expect(chipText(conversationChip(host))).toBe("Account A");
});

test("a pick made in the board picker is written to the shared store at once, and the running account takes it back with one reconfigure", async () => {
  installRuntime(null);
  const { host } = mount(searchPipeline());
  await tick();
  await openVerify(host);
  await openPicker(host);
  click(row(host, "account-c"));
  /* Same frame: every other account surface reads this store. */
  expect(readPickedAccount(conversationIdentity(verify))).toBe("account-c");
  expect(chipText(conversationChip(host))).toBe("Account A → Account C with the next message");
  await tick(40);
  expect(hostRequests.map((body) => body.accountId)).toEqual(["account-c"]);

  /* The projection arrives; then the cancel is a pick of the account it runs on. */
  installRuntime({ operationId: "op-1", accountId: "account-c" });
  await tick();
  await openPicker(host);
  click(picker(host)!.querySelector("[data-account-cancel]"));
  expect(readPickedAccount(conversationIdentity(verify))).toBe("default");
  expect(chipText(conversationChip(host))).toBe("Account A");
  await tick(40);
  expect(hostRequests.map((body) => body.accountId)).toEqual(["account-c", "default"]);
  expect(migrationRequests).toEqual([]);
});

test("a board pick the route refuses goes back on every surface and is said once", async () => {
  installRuntime(null);
  hostAnswer = { status: 409, error: "the account is signed out" };
  const { host } = mount(searchPipeline());
  await tick();
  await openVerify(host);
  await openPicker(host);
  click(row(host, "account-c"));
  expect(readPickedAccount(conversationIdentity(verify))).toBe("account-c");
  await tick(40);
  expect(readPickedAccount(conversationIdentity(verify))).toBeNull();
  expect(chipText(conversationChip(host))).toBe("Account A");
  expect(hostRequests).toHaveLength(1);
  expect(receiptTexts(host).filter((text) => text?.includes("the account is signed out"))).toHaveLength(1);
});
