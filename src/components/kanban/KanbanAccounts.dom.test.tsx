import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

import type { PatchPipelineRequest, Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { ConversationMigration, FileEntry } from "@/lib/types";

import { stageDigest, stageDigests } from "@/lib/pipelines/stageDigest";

import type { PipelinePorts, PipelineWriteResult } from "./pipelinePorts";
import type { TaskMutationPorts } from "./useTaskMutations";

/* Account choice on the kanban board (#1695 K6), rendered by React: the
   account chip on a waiting stage's header and on a conversation's identity
   row, and the picker each opens. A waiting stage's account goes through
   `override-stage` with the digest of its read; a conversation switches with
   the `reconfigure` the conversation header already sends. Invented records;
   the pipeline, account and conversation routes answer from stubs; no route
   or state directory is touched, and no account is switched. */

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
let hostAnswer: "queued" | "lost" | { status: number; error: string } = "queued";
/* The conversation migration route (#1705): cancels and withdrawals, answered as `migrationAnswer` says. */
const migrationRequests: Array<{ conversationId: string; body: Record<string, unknown> }> = [];
let migrationAnswer: "ok" | "replayed" | "lost" | { status: number; error?: string; code?: string } = "ok";
/* Every write the board sent, in order. */
const writes: string[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith("/api/logs")) {
    const { reqs } = JSON.parse(String(init?.body ?? "{}")) as { reqs: Array<{ id: string }> };
    return json({ chunks: Object.fromEntries(reqs.map((req) => [req.id, { data: "", start: 0, offset: 0, size: 0 }])) });
  }
  if (url === "/api/accounts") return json(ACCOUNTS);
  if (url.startsWith("/api/account-project-bindings?project=")) return json(BINDINGS);
  const migrationRoute = /^\/api\/conversations\/([^/]+)\/migration$/.exec(url);
  if (migrationRoute) {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    migrationRequests.push({ conversationId: decodeURIComponent(migrationRoute[1]!), body });
    writes.push(`migration:${String(body.action)}`);
    if (migrationAnswer === "lost") throw new TypeError("Failed to fetch");
    if (typeof migrationAnswer === "object") return json({ ...(migrationAnswer.error ? { error: migrationAnswer.error } : {}), ...(migrationAnswer.code ? { code: migrationAnswer.code } : {}) }, migrationAnswer.status);
    const conversation = { id: decodeURIComponent(migrationRoute[1]!), migration: { phase: "rolled-back" } };
    return json(body.action === "withdraw"
      ? { withdraw: migrationAnswer === "replayed" ? "replayed" : "withdrawn", conversation }
      : { cancel: migrationAnswer === "replayed" ? "replayed" : "cancelled", conversation });
  }
  if (url === "/api/conversation-host") {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    hostRequests.push(body);
    writes.push(`reconfigure:${String(body.accountId)}`);
    if (hostAnswer === "lost") throw new TypeError("Failed to fetch");
    if (typeof hostAnswer === "object") return json({ error: hostAnswer.error }, hostAnswer.status);
    const operationId = `op-${hostRequests.length}`;
    const outside = !["default", "account-c", "account-e"].includes(String(body.accountId));
    return json({ ok: true, structured: true, operationId, receipt: { operationId, status: "queued" }, ...(outside ? { accountOverride: { outsidePool: true, recorded: true } } : {}) }, 202);
  }
  return json({});
}) as unknown as typeof fetch;

const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { KanbanBoard } = await import("./KanbanBoard");

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
  localStorage.clear();
  hostRequests.length = 0;
  hostAnswer = "queued";
  migrationRequests.length = 0;
  migrationAnswer = "ok";
  writes.length = 0;
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
      onOpenCatalog={() => {}}
      onOpenOnBoard={() => {}}
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

async function openWaitingStage(host: HTMLElement) {
  click(card(host).querySelector('.psummary [data-stage="merge"]'));
  await tick();
}
async function openPicker(host: HTMLElement, chip: HTMLElement | null) {
  press(chip);
  await tick(20);
}
async function openVerify(host: HTMLElement) {
  click(card(host).querySelector('.psummary [data-stage="verify"]'));
  await tick();
}

test("a waiting stage names its first turn's account; the picker weighs each account against the project's, and a choice writes that account alone", async () => {
  const { host, route, update } = mount(searchPipeline());
  await tick();
  await openWaitingStage(host);
  expect(chipText(stageChip(host))).toBe("Project's choice");
  await openPicker(host, stageChip(host));
  expect(picker(host)?.querySelector(".head")?.textContent).toBe("Account · Cleaner · Claude");
  expect(kv(host)).toEqual([["First turn on", "Project's choice"]]);
  expect(rows(host).map(({ id, name, tag, checked, disabled }) => [id, name, tag, checked, disabled])).toEqual([
    ["", "Project's choice", "chosen", true, false],
    ["default", "Account A · Max", "", false, false],
    ["account-c", "Account C · Max", "", false, false],
    ["account-g", "Account G · Pro", "not allowed for this project", false, true],
    ["account-e", "Account E · Pro", expect.stringMatching(/^limit · resets \d/), false, false],
  ]);
  same(document.activeElement, row(host, ""));
  /* The binding refuses it for a stage: nothing is sent, and the picker stays. */
  click(row(host, "account-g"));
  await tick();
  expect(route.patches).toEqual([]);
  expect(picker(host)).toBeTruthy();

  click(row(host, "account-c"));
  await tick();
  expect(picker(host)).toBeNull();
  same(document.activeElement, stageChip(host));
  expect(route.reads).toEqual(["p-search"]);
  expect(route.patches).toEqual([{ action: "override-stage", stageId: "merge", account: "account-c", expectedStageDigest: stageDigest(searchPipeline().stages[2]!) }]);
  expect(receiptTexts(host)).toEqual(["Cleaner runs on Account C from its first turn"]);
  update({ pipeline: searchPipeline({ account: "account-c" }) });
  expect(chipText(stageChip(host))).toBe("Account C");
});

test("the project's choice clears a stage's pin, and the stage's menu opens the same picker", async () => {
  const { host, route } = mount(searchPipeline({ account: "account-c" }));
  await tick();
  await openWaitingStage(host);
  click(card(host).querySelector("[data-panel-menu]"));
  const item = [...host.querySelectorAll<HTMLElement>('.menu [role="menuitem"]')].find((entry) => entry.textContent === "Run on account…");
  click(item);
  await tick(20);
  expect(kv(host)).toEqual([["First turn on", "Account C · Max · 18% of 5h"]]);
  expect(rows(host).filter((entry) => entry.checked).map((entry) => entry.id)).toEqual(["account-c"]);
  click(row(host, ""));
  await tick();
  expect(route.patches).toEqual([{ action: "override-stage", stageId: "merge", account: null, expectedStageDigest: stageDigest(searchPipeline({ account: "account-c" }).stages[2]!) }]);
  expect(receiptTexts(host)).toEqual(["Cleaner uses the project's choice of account"]);
});

test("a stage another client changed after the read keeps that client's account; the receipt says what it runs on now and nothing is resent", async () => {
  const { host, route } = mount(searchPipeline());
  await tick();
  await openWaitingStage(host);
  route.state.beforeWrite = () => { route.state.record = searchPipeline({ account: "account-e" }); };
  await openPicker(host, stageChip(host));
  click(row(host, "account-c"));
  await tick();
  expect(route.patches).toHaveLength(1);
  expect(route.reads).toEqual(["p-search", "p-search"]);
  expect(receiptTexts(host)).toEqual(["Cleaner was changed elsewhere and runs on Account E now. Nothing was overwritten."]);
});

test("the server's refusal keeps its words beside a Retry; a choice with no answer is not confirmed until a read shows the stage holds it", async () => {
  const { host, route, update } = mount(searchPipeline());
  await tick();
  await openWaitingStage(host);
  route.state.answers.push({ ok: false, status: 409, error: "claude account account-c is not allowed on project fixture" });
  await openPicker(host, stageChip(host));
  click(row(host, "account-c"));
  await tick();
  const refused = host.querySelector("[data-kanban-receipt].error");
  expect(refused?.querySelector(".msg")?.textContent).toBe("Cleaner's account wasn't changed: claude account account-c is not allowed on project fixture");
  expect(refused?.querySelector(".act")?.textContent).toBe("Retry");

  route.state.answers.push({ ok: false, status: 0, error: "Failed to fetch", unknown: true });
  await openPicker(host, stageChip(host));
  click(row(host, "account-c"));
  await tick();
  expect(chipText(stageChip(host))).toBe("Project's choice → Account C not confirmed");
  expect(receiptTexts(host).at(-1)).toBe("Changing Cleaner's account got no answer. It may have been saved.");
  await openPicker(host, stageChip(host));
  expect(kv(host)).toEqual([["First turn on", "Project's choice"], ["Pending", "Account C · not confirmed"]]);
  /* Check again only reads: the stage does not hold it yet, so it stays unconfirmed. */
  click(picker(host)!.querySelector("[data-account-check]"));
  await tick();
  expect(route.patches).toHaveLength(2);
  expect(receiptTexts(host).at(-1)).toBe("Still not confirmed: Cleaner doesn't run on Account C yet");
  route.state.record = searchPipeline({ account: "account-c" });
  update({ pipeline: searchPipeline({ account: "account-c" }) });
  await openPicker(host, stageChip(host));
  click(picker(host)!.querySelector("[data-account-check]"));
  await tick();
  expect(route.patches).toHaveLength(2);
  expect(receiptTexts(host).at(-1)).toBe("Cleaner runs on Account C from its first turn");
  expect(chipText(stageChip(host))).toBe("Account C");
});

test("a conversation switches with the header's reconfigure; an account outside the project's is offered and recorded, and with no runtime plane the switch waits for the turn with its target known to this page only", async () => {
  const { host, update } = mount(searchPipeline({}, { accountId: "account-c" }));
  await tick();
  await openVerify(host);
  expect(chipText(conversationChip(host))).toBe("Account A");
  await openPicker(host, conversationChip(host));
  expect(picker(host)?.querySelector(".head")?.textContent).toBe("Account · Verifier · Claude");
  expect(kv(host)).toEqual([["Current turn on", "Account A · Max · 72% of 5h"], ["Stage setting", "Project's choice"], ["Launched on", "Account C"]]);
  expect(rows(host).map(({ id, tag, checked, disabled }) => [id, tag, checked, disabled])).toEqual([
    ["default", "current", true, false],
    ["account-c", "", false, false],
    /* Stage policy refuses it for a stage's first turn; a running conversation may take it, recorded (#1279). */
    ["account-g", "outside this project's accounts", false, false],
    ["account-e", expect.stringMatching(/^limit · resets \d/), false, false],
  ]);
  expect(notes(host)).toEqual([
    "The running turn is never interrupted. The switch waits for it to end, then this conversation continues on the chosen account.",
    "Accounts outside this project's accounts can be chosen for a conversation; the choice is recorded as yours.",
  ]);
  click(row(host, "account-g"));
  await tick(20);
  expect(hostRequests).toEqual([{ action: "reconfigure", path: verify.path, conversationId: verify.conversationId, accountId: "account-g", model: "opus", effort: "high" }]);
  expect(receiptTexts(host)).toEqual([
    "Switch to Account G requested for Verifier. It waits for the current turn to end.",
    "Account G is outside this project's accounts; the switch is recorded as your choice",
  ]);
  expect(chipText(conversationChip(host))).toBe("Account A → Account G after this turn");

  await openPicker(host, conversationChip(host));
  expect(kv(host).at(-1)).toEqual(["Pending", "Account G · waits for the current turn to end"]);
  expect(picker(host)!.querySelector("[data-account-pending]")?.getAttribute("data-account-source")).toBe("page");
  expect(notes(host)[0]).toBe("Known to this page only. A reload or another page won't show this switch until the server records it.");
  /* Still queued: it can be cancelled by its operation, or changed. */
  expect(picker(host)!.querySelector("[data-account-cancel]")?.getAttribute("data-account-cancel")).toBe("withdraw");
  expect(picker(host)!.querySelector(".acct-lbl")?.textContent).toBe("Change the pending account");
  expect(rows(host).map((entry) => [entry.id, entry.tag, entry.checked, entry.disabled])).toEqual([
    ["default", "current", false, false],
    ["account-c", "", false, false],
    ["account-g", "pending", true, false],
    ["account-e", expect.stringMatching(/^limit · resets \d/), false, false],
  ]);
  flushSync(() => document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event));
  await tick(40);
  expect(hostRequests).toHaveLength(1);
  expect(migrationRequests).toEqual([]);

  /* Done only when the conversation runs on the target. */
  update({ files: [build, { ...verify, path: "/fixture/accounts/claude/account-g/verify-1.jsonl" }] });
  await tick();
  expect(chipText(conversationChip(host))).toBe("Account G");
  expect(receiptTexts(host).at(-1)).toBe("Verifier now runs on Account G");
});

test("a switch the migration record reports shows for every page: waiting with messages held, then failed with its reason; nothing is sent", async () => {
  const waiting: ConversationMigration = { intentId: "intent-1", trigger: "manual", phase: "waiting-turn", targetAccountId: "account-c", targetLabel: "account-c", failure: null, revision: 2 };
  const { host, update } = mount(searchPipeline(), [build, { ...verify, migration: waiting }]);
  await tick();
  await openVerify(host);
  expect(chipText(conversationChip(host))).toBe("Account A → Account C after this turn");
  await openPicker(host, conversationChip(host));
  expect(kv(host).at(-1)).toEqual(["Pending", "Account C · waits for the current turn to end"]);
  expect(picker(host)!.querySelector("[data-account-pending]")?.getAttribute("data-account-source")).toBe("record");
  expect(notes(host).slice(0, 2)).toEqual([
    "Messages sent now are held and delivered after the switch, in the order they were sent. Cancel delivers them on the current account instead.",
    "Not carried: a message bound to the current turn, injected context, or attachments only the sending browser holds. Each ends failed with its reason, keeps the text the Viewer holds for it, and its receipt says whether sending it again is safe.",
  ]);
  /* Still waiting for its turn: cancellable by the record's revision. */
  expect(picker(host)!.querySelector("[data-account-cancel]")?.getAttribute("data-account-cancel")).toBe("cancel");
  expect(rows(host).find((entry) => entry.id === "account-g")?.disabled).toBe(false);
  flushSync(() => document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event));
  await tick();
  update({ files: [build, { ...verify, migration: { ...waiting, phase: "failed-recoverable", failure: "successor did not start" } }] });
  expect(chipText(conversationChip(host))).toBe("Account A → Account C switch failed");
  await openPicker(host, conversationChip(host));
  expect(kv(host).at(-1)).toEqual(["Pending", "Account C · the switch failed: successor did not start"]);
  expect(notes(host)[0]).toBe("Retry it, or keep the current account, from the banner above the conversation.");
  expect(picker(host)!.querySelector("[data-account-cancel]")).toBeNull();
  expect(rows(host).every((entry) => entry.disabled)).toBe(true);
  expect(hostRequests).toEqual([]);
  expect(migrationRequests).toEqual([]);
});

test("a switch with no answer is not confirmed and never resent; a refused one says why and leaves the accounts open", async () => {
  hostAnswer = "lost";
  const { host } = mount(searchPipeline());
  await tick();
  await openVerify(host);
  await openPicker(host, conversationChip(host));
  click(row(host, "account-c"));
  await tick(20);
  expect(chipText(conversationChip(host))).toBe("Account A → Account C not confirmed");
  expect(receiptTexts(host)).toEqual(["Switching Verifier to Account C got no answer. It may be queued; this page won't send it again."]);
  await openPicker(host, conversationChip(host));
  expect(kv(host).at(-1)).toEqual(["Pending", "Account C · the request got no answer"]);
  expect(rows(host).every((entry) => entry.disabled)).toBe(true);
  await tick(80);
  expect(hostRequests).toHaveLength(1);
  flushSync(() => document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event));
  roots.splice(0).forEach((root) => flushSync(() => root.unmount()));
  document.body.replaceChildren();

  hostAnswer = { status: 400, error: "account is not available for claude" };
  const second = mount(searchPipeline());
  await tick();
  await openVerify(second.host);
  await openPicker(second.host, conversationChip(second.host));
  click(row(second.host, "account-c"));
  await tick(20);
  expect(receiptTexts(second.host)).toEqual(["Switch to Account C refused: account is not available for claude"]);
  expect(chipText(conversationChip(second.host))).toBe("Account A");
  await openPicker(second.host, conversationChip(second.host));
  expect(rows(second.host).find((entry) => entry.id === "account-c")?.disabled).toBe(false);
});

test("a 503 that can follow dispatch is not confirmed: the accounts stay locked and exactly one request is sent", async () => {
  hostAnswer = { status: 503, error: "runtime host socket closed" };
  const { host } = mount(searchPipeline());
  await tick();
  await openVerify(host);
  await openPicker(host, conversationChip(host));
  click(row(host, "account-c"));
  await tick(20);
  expect(chipText(conversationChip(host))).toBe("Account A → Account C not confirmed");
  expect(receiptTexts(host)).toEqual(["Switching Verifier to Account C got no answer. It may be queued; this page won't send it again."]);
  await openPicker(host, conversationChip(host));
  expect(kv(host).at(-1)).toEqual(["Pending", "Account C · the request got no answer"]);
  expect(notes(host)[0]).toBe("It may or may not have reached the server, and this page can't tell. Accounts stay unavailable here so nothing is sent twice; reloading the page ends this page's lock.");
  expect(rows(host).every((entry) => entry.disabled)).toBe(true);
  click(row(host, "account-g"));
  await tick(40);
  expect(hostRequests).toHaveLength(1);
});

const waitingC = (over: Partial<ConversationMigration> = {}): ConversationMigration => ({ intentId: "intent-1", trigger: "manual", phase: "waiting-turn", targetAccountId: "account-c", targetLabel: "account-c", failure: null, revision: 2, ...over });

test("Cancel on a switch waiting for its turn sends cancel with the record's revision and nothing else", async () => {
  const { host } = mount(searchPipeline(), [build, { ...verify, migration: waitingC() }]);
  await tick();
  await openVerify(host);
  await openPicker(host, conversationChip(host));
  click(picker(host)!.querySelector("[data-account-cancel]"));
  await tick(20);
  expect(migrationRequests).toEqual([{ conversationId: verify.conversationId!, body: { action: "cancel", expectedRevision: 2 } }]);
  expect(hostRequests).toEqual([]);
  expect(receiptTexts(host)).toEqual(["Cancelled the switch to Account C for Verifier"]);
});

test("a switch past waiting for its turn offers no Cancel and no Change", async () => {
  const { host } = mount(searchPipeline(), [build, { ...verify, migration: waitingC({ phase: "preparing" }) }]);
  await tick();
  await openVerify(host);
  expect(chipText(conversationChip(host))).toBe("Account A → Account C switching…");
  await openPicker(host, conversationChip(host));
  expect(picker(host)!.querySelector("[data-account-cancel]")).toBeNull();
  expect(notes(host)).toContain("Too late to cancel: the switch has started.");
  expect(rows(host).every((entry) => entry.disabled)).toBe(true);
  click(row(host, "account-g"));
  await tick(40);
  expect(migrationRequests).toEqual([]);
  expect(hostRequests).toEqual([]);
});

test("Change withdraws the queued switch first and asks for the new account only once the cancel is confirmed", async () => {
  const { host } = mount(searchPipeline());
  await tick();
  await openVerify(host);
  await openPicker(host, conversationChip(host));
  click(row(host, "account-c"));
  await tick(20);
  expect(chipText(conversationChip(host))).toBe("Account A → Account C after this turn");

  await openPicker(host, conversationChip(host));
  click(row(host, "account-g"));
  await tick(40);
  expect(writes).toEqual(["reconfigure:account-c", "migration:withdraw", "reconfigure:account-g"]);
  expect(migrationRequests).toEqual([{ conversationId: verify.conversationId!, body: { action: "withdraw", operationId: "op-1" } }]);
  expect(receiptTexts(host).slice(-2)).toEqual([
    "Switch to Account G requested for Verifier. It waits for the current turn to end.",
    "Account G is outside this project's accounts; the switch is recorded as your choice",
  ]);
  expect(receiptTexts(host)).toContain("Cancelled the switch to Account C for Verifier");
  /* The cancelled switch's own request ended with the cancel, not as a failure. */
  expect(receiptTexts(host).some((text) => text.includes("failed"))).toBe(false);
  expect(chipText(conversationChip(host))).toBe("Account A → Account G after this turn");
});

test("a refused cancel requests no new account and says why", async () => {
  migrationAnswer = { status: 409, error: "the queue has already claimed this switch; cancel it with the migration's revision", code: "SWITCH_CLAIMED" };
  const { host } = mount(searchPipeline());
  await tick();
  await openVerify(host);
  await openPicker(host, conversationChip(host));
  click(row(host, "account-c"));
  await tick(20);
  await openPicker(host, conversationChip(host));
  click(row(host, "account-g"));
  await tick(40);
  expect(writes).toEqual(["reconfigure:account-c", "migration:withdraw"]);
  expect(receiptTexts(host).at(-1)).toBe("The switch to Account C was already claimed. Open the picker again to cancel it once it shows as waiting. Account G was not requested.");
});

test("a cancel with no answer, or a server error after it may have run, locks this page: one cancel request, no new switch", async () => {
  for (const answer of ["lost", { status: 503, error: "runtime host socket closed" }] as const) {
    migrationAnswer = answer;
    const { host } = mount(searchPipeline(), [build, { ...verify, migration: waitingC() }]);
    await tick();
    await openVerify(host);
    await openPicker(host, conversationChip(host));
    click(row(host, "account-g"));
    await tick(40);
    expect(chipText(conversationChip(host))).toBe("Account A → Account C cancel not confirmed");
    expect(receiptTexts(host).at(-1)).toBe("Cancelling the switch to Account C got no answer. It may have been cancelled; this page won't send it again. Account G was not requested.");
    await openPicker(host, conversationChip(host));
    expect(kv(host).at(-1)).toEqual(["Pending", "Account C · the cancel got no answer"]);
    expect(notes(host)).toContain("The cancel may or may not have reached the server, and this page can't tell. Nothing more is sent from here for this switch; the lock ends once it no longer shows as pending, or on reload.");
    expect(picker(host)!.querySelector("[data-account-cancel]")).toBeNull();
    expect(rows(host).every((entry) => entry.disabled)).toBe(true);
    click(row(host, "account-e"));
    await tick(40);
    expect(migrationRequests).toHaveLength(1);
    expect(hostRequests).toEqual([]);
    for (const root of roots.splice(0)) flushSync(() => root.unmount());
    document.body.replaceChildren();
    migrationRequests.length = 0;
    writes.length = 0;
  }
});

test("an unanswered cancel locks only the switch it named: once that switch is gone a later switch offers Cancel again, even at the same revision", async () => {
  migrationAnswer = "lost";
  const { host, update } = mount(searchPipeline(), [build, { ...verify, migration: waitingC() }]);
  await tick();
  await openVerify(host);
  await openPicker(host, conversationChip(host));
  click(picker(host)!.querySelector("[data-account-cancel]"));
  await tick(40);
  expect(chipText(conversationChip(host))).toBe("Account A → Account C cancel not confirmed");

  /* The record shows C's switch rolled back. Nothing says this page's cancel did it, so no success is shown; the lock ends. */
  update({ files: [build, { ...verify, migration: waitingC({ phase: "rolled-back" }) }] });
  await tick(20);
  expect(chipText(conversationChip(host))).toBe("Account A");
  expect(receiptTexts(host).some((text) => text.startsWith("Cancelled"))).toBe(false);

  /* A later switch to G, from another page, happens to carry the same revision under its own intent. */
  update({ files: [build, { ...verify, migration: waitingC({ intentId: "intent-2", targetAccountId: "account-g", targetLabel: "account-g" }) }] });
  await tick(20);
  expect(chipText(conversationChip(host))).toBe("Account A → Account G after this turn");
  await openPicker(host, conversationChip(host));
  expect(kv(host).at(-1)?.[1]).not.toContain("cancel got no answer");
  expect(notes(host).some((note) => note.startsWith("The cancel may or may not"))).toBe(false);
  migrationAnswer = "ok";
  click(picker(host)!.querySelector('[data-account-cancel="cancel"]'));
  await tick(40);
  expect(migrationRequests).toHaveLength(2);
  expect(migrationRequests.at(-1)?.body).toEqual({ action: "cancel", expectedRevision: 2 });
  expect(receiptTexts(host).at(-1)).toBe("Cancelled the switch to Account G for Verifier");
});

test("the same cancel answered as a replay reads as cancelled, and a switch that already ended reads as no longer pending, never as started", async () => {
  migrationAnswer = "replayed";
  const first = mount(searchPipeline(), [build, { ...verify, migration: waitingC() }]);
  await tick();
  await openVerify(first.host);
  await openPicker(first.host, conversationChip(first.host));
  click(picker(first.host)!.querySelector("[data-account-cancel]"));
  await tick(40);
  expect(receiptTexts(first.host).at(-1)).toBe("Cancelled the switch to Account C for Verifier");
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();

  migrationAnswer = { status: 409, error: "the switch is no longer pending", code: "SWITCH_NOT_PENDING" };
  const second = mount(searchPipeline(), [build, { ...verify, migration: waitingC() }]);
  await tick();
  await openVerify(second.host);
  await openPicker(second.host, conversationChip(second.host));
  click(picker(second.host)!.querySelector("[data-account-cancel]"));
  await tick(40);
  expect(receiptTexts(second.host).at(-1)).toBe("The switch to Account C is no longer pending");
});

test("a cancel refused before anything was written (the journal unreadable) offers Retry, which sends it again only when chosen", async () => {
  migrationAnswer = { status: 503, error: "the runtime host could not be read; nothing was withdrawn", code: "RUNTIME_UNREADABLE" };
  const { host } = mount(searchPipeline());
  await tick();
  await openVerify(host);
  await openPicker(host, conversationChip(host));
  click(row(host, "account-c"));
  await tick(20);
  await openPicker(host, conversationChip(host));
  click(picker(host)!.querySelector("[data-account-cancel]"));
  await tick(40);
  const receipt = [...host.querySelectorAll("[data-kanban-receipt].error")].at(-1);
  expect(receipt?.querySelector(".msg")?.textContent).toBe("Couldn't read the runtime host, so the switch to Account C was not cancelled");
  expect(migrationRequests).toHaveLength(1);
  migrationAnswer = "ok";
  click(receipt?.querySelector(".act"));
  await tick(40);
  expect(migrationRequests).toHaveLength(2);
  expect(receiptTexts(host).at(-1)).toBe("Cancelled the switch to Account C for Verifier");
});

test("the Stages sheet carries the same chips: a waiting stage's pane names its first turn's account, a started stage's reader its conversation's", async () => {
  const { host } = mount(searchPipeline({ account: "account-c" }));
  await tick();
  press(card(host).querySelector("[data-open-stages]"));
  await tick(20);
  const pane = (stageId: string) => host.querySelector<HTMLElement>(`[data-stages-sheet] .pane[data-stage="${stageId}"]`)!;
  expect(chipText(pane("merge").querySelector('[data-account-trigger="stage:p-search:merge"]'))).toBe("Account C");
  expect(chipText(pane("verify").querySelector(`[data-account-trigger="${verify.conversationId}"]`))).toBe("Account A");
  await openPicker(host, pane("merge").querySelector('[data-account-trigger="stage:p-search:merge"]'));
  expect(picker(host)?.querySelector(".head")?.textContent).toBe("Account · Cleaner · Claude");
});
