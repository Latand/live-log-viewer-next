import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import { resetEngineAccountsStoresForTests } from "@/hooks/useEngineAccounts";
import { setLocale } from "@/lib/i18n";
import { TaskToastHost } from "./tasks/taskToast";
import type { FileEntry } from "@/lib/types";

import { RuntimePill, RuntimeSwitchHold } from "./RuntimePill";
import { resetPickedAccountsForTests, setPickedAccount } from "@/lib/accounts/intendedAccount";
import type { RuntimeSession } from "./runtime/runtimeModel";

/*
 * An account pick is optimistic (#1846). On a structured conversation the tap
 * records THIS conversation's intended account and every runtime surface says
 * so in the same frame — «runs on A · next on B» — while the request is still
 * unanswered and while the agent is mid-turn. Nothing waits, nothing spins,
 * and nothing moves the engine's launch account for every other conversation.
 * A move that failed when a message engaged it says why, and offers the two
 * obvious ways on.
 *
 * Account ids and labels are invented.
 */

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
  PointerEvent: dom.MouseEvent,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
});
let mobile = true;
(dom as unknown as { matchMedia(query: string): unknown }).matchMedia = (query: string) => ({
  matches: mobile,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

const ACCOUNTS = [
  { id: "acct-a", label: "Account A", kind: "managed", authPresent: true, authHealth: "authenticated", loginPending: false, loginState: "authenticated", deviceAuth: null },
  { id: "acct-b", label: "Account B", kind: "managed", authPresent: true, authHealth: "authenticated", loginPending: false, loginState: "authenticated", deviceAuth: null },
];

const calls: { url: string; body: Record<string, unknown> | null }[] = [];
const realFetch = globalThis.fetch;
/** The answer a reconfigure gets; held open until a case releases it. */
let answerReconfigure: (response: Response) => void = () => {};

beforeEach(() => {
  setLocale("en");
  mobile = true;
  calls.length = 0;
  resetEngineAccountsStoresForTests();
  resetPickedAccountsForTests();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : (input as URL).toString());
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ url, body });
    if (url === "/api/accounts") {
      return new Response(JSON.stringify({
        claude: { active: "acct-a", accounts: ACCOUNTS, migration: null, autoBalance: null },
        codex: { active: null, accounts: [], migration: null, autoBalance: null },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "/api/tmux") return await new Promise<Response>((resolve) => { answerReconfigure = resolve; });
    return new Response(JSON.stringify({ keepCurrent: "released" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});

const file: FileEntry = {
  path: "/state/accounts/claude/acct-a/projects/viewer/session.jsonl",
  root: "claude-projects", name: "session.jsonl", project: "viewer",
  title: "Rework the board filters", engine: "claude", kind: "session", fmt: "claude",
  parent: null, mtime: 1, size: 1, activity: "live", proc: "running", pid: 11,
  conversationId: "conversation_intent", model: "opus", effort: "high", fast: false,
  pendingQuestion: null, waitingInput: null,
} as FileEntry;

/** The agent is mid-turn; `pending` is the pick the runtime session projects for every page. */
function session(pending: string | null): RuntimeSession {
  return {
    conversationId: "conversation_intent",
    sessionKey: { engine: "claude", sessionId: "session-intent" },
    hostKind: "claude-broker",
    host: "hosted",
    turn: "running",
    provenance: "structured",
    revision: 4,
    attentionIds: [],
    recentReceipts: [],
    accountId: "acct-a",
    parentConversationId: null,
    flowId: null,
    workflowId: null,
    cwd: "/repo",
    artifactPath: file.path,
    capabilities: { steer: true, structuredAttention: true },
    activeTurnId: "turn-running",
    pendingReconfigure: pending
      ? { operationId: "pick-op", model: "claude-opus-5", effort: "high", fast: null, accountId: pending }
      : null,
    drift: null,
  };
}

async function mount(node: React.ReactElement): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
    await new Promise((r) => setTimeout(r, 0));
  });
  /* The accounts store answers on its first read; its labels are what every surface names accounts by. */
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
  return { host, root };
}

async function openSheet(node: React.ReactElement) {
  const mounted = await mount(node);
  await act(async () => {
    (mounted.host.querySelector("[data-runtime-pill]") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 5));
  });
  for (let attempt = 0; attempt < 40 && document.querySelectorAll("[data-runtime-sheet-account]").length < 2; attempt += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
  return mounted;
}

const row = (id: string) => document.querySelector(`[data-runtime-sheet-account="${id}"]`) as HTMLButtonElement;
const header = () => document.querySelector("[data-runtime-sheet-account-current]")!.textContent;

test("a pick mid-turn shows on the sheet in the same frame, sends no migration, and moves no engine account", async () => {
  const { host, root } = await openSheet(<RuntimePill file={file} surface="structured" runtimeSession={session(null)} />);
  expect(header()).toBe("runs on Account A");
  expect(row("acct-a").getAttribute("data-runtime-account-next")).toBe("true");

  /* One synchronous flush after the tap, with the request still unanswered. */
  act(() => { row("acct-b").click(); });
  expect(header()).toBe("runs on Account A · next on Account B");
  expect(row("acct-b").getAttribute("data-runtime-account-next")).toBe("true");
  expect(row("acct-a").getAttribute("data-runtime-account-next")).toBeNull();
  /* The account it runs on can be picked again, which takes the pick back. */
  expect(row("acct-a").disabled).toBe(false);
  /* No spinner: nothing is being applied, the pick waits for the next message. */
  expect(host.querySelector("[data-runtime-switch-pending]")).toBeNull();

  /* What left the page: this conversation's reconfigure naming the account, and nothing else. */
  const sent = calls.filter((call) => call.url !== "/api/accounts");
  expect(sent).toHaveLength(1);
  expect(sent[0]!.url).toBe("/api/tmux");
  expect(sent[0]!.body).toMatchObject({ action: "reconfigure", path: file.path, accountId: "acct-b" });
  expect(calls.some((call) => call.url.includes("/active") || call.url.includes("/migration"))).toBe(false);

  await act(async () => {
    answerReconfigure(new Response(JSON.stringify({ ok: true, structured: true, operationId: "pick-op", receipt: { operationId: "pick-op", status: "queued" } }), { status: 202 }));
    await new Promise((r) => setTimeout(r, 5));
  });
  /* The projection arrives, the agent is still mid-turn: still no spinner, still «next on». */
  await act(async () => {
    root.render(<RuntimePill file={file} surface="structured" runtimeSession={session("acct-b")} />);
    await new Promise((r) => setTimeout(r, 5));
  });
  expect(header()).toBe("runs on Account A · next on Account B");
  expect(host.querySelector("[data-runtime-switch-pending]")).toBeNull();
  expect(host.querySelector("[data-runtime-pill]")!.getAttribute("aria-busy")).toBeNull();
  await act(async () => root.unmount());
});

test("picking the running account again takes the pick back at once", async () => {
  const { root } = await openSheet(<RuntimePill file={file} surface="structured" runtimeSession={session("acct-b")} />);
  expect(header()).toBe("runs on Account A · next on Account B");
  act(() => { row("acct-a").click(); });
  expect(header()).toBe("runs on Account A");
  expect(row("acct-a").getAttribute("data-runtime-account-next")).toBe("true");
  expect(calls.filter((call) => call.url === "/api/tmux").map((call) => call.body)).toMatchObject([{ action: "reconfigure", accountId: "acct-a" }]);
  await act(async () => root.unmount());
});

test("a pick the server refuses goes back to what it was, and says why", async () => {
  const { root } = await openSheet(<RuntimePill file={file} surface="structured" runtimeSession={session(null)} />);
  act(() => { row("acct-b").click(); });
  expect(header()).toBe("runs on Account A · next on Account B");
  await act(async () => {
    answerReconfigure(new Response(JSON.stringify({ error: "account is not available for claude" }), { status: 400 }));
    await new Promise((r) => setTimeout(r, 5));
  });
  expect(header()).toBe("runs on Account A");
  await act(async () => root.unmount());
});

test("the desktop popover says where the next message goes, and its Account panel picks per conversation", async () => {
  mobile = false;
  const { host, root } = await mount(<RuntimePill file={file} surface="structured" runtimeSession={session("acct-b")} />);
  await act(async () => {
    (host.querySelector("[data-runtime-pill]") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(document.querySelector("[data-runtime-popover-account]")!.textContent).toBe("runs on Account A · next on Account B");
  const accountRow = document.querySelector('[data-runtime-row="submenu"][data-runtime-value="account"]') as HTMLButtonElement;
  expect(accountRow.textContent).toContain("Account B");
  await act(async () => {
    accountRow.click();
    await new Promise((r) => setTimeout(r, 5));
  });
  for (let attempt = 0; attempt < 40 && document.querySelectorAll('[data-runtime-row="account"]').length < 2; attempt += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
  const rows = [...document.querySelectorAll('[data-runtime-row="account"]')] as HTMLButtonElement[];
  expect(rows.map((item) => [item.getAttribute("data-runtime-value"), item.getAttribute("aria-checked")]))
    .toEqual([["account-acct-a", "false"], ["account-acct-b", "true"]]);
  /* The way back says what it does, as an action, and nothing else competes with the account's name. */
  const wayBack = rows[0]!.querySelector('[data-runtime-row-detail="action"]')!;
  expect(wayBack.textContent).toBe("cancel switch");
  expect(wayBack.className).toContain("text-accent");
  act(() => { rows[0]!.click(); });
  expect(calls.filter((call) => call.url === "/api/tmux").map((call) => call.body)).toMatchObject([{ action: "reconfigure", accountId: "acct-a" }]);
  await act(async () => root.unmount());
});

test("a move that failed at engagement holds the message with its reason and the two ways on", async () => {
  mobile = false;
  const held: FileEntry = {
    ...file,
    switchHold: { targetAccountId: "acct-b", reason: "claude account requires authentication", since: "2026-09-19T10:00:00.000Z" },
  };
  const { host, root } = await mount(<><RuntimeSwitchHold file={held} /><RuntimePill file={held} surface="structured" runtimeSession={session(null)} /></>);
  const notice = host.querySelector("[data-runtime-switch-hold]")!;
  /* Its own line, apart from the pill's row, with full-size targets. */
  expect(notice.closest("[data-runtime-pill]")).toBeNull();
  expect(host.querySelector("[data-runtime-switch-hold-keep]")!.className).toContain("min-h-11");
  expect(host.querySelector("[data-runtime-switch-hold-pick]")!.className).toContain("min-h-11");
  expect(notice.getAttribute("role")).toBe("alert");
  expect(notice.textContent).toContain("Not sent: moving to Account B failed — the account is signed out");
  expect(notice.textContent).toContain("Send on Account A");
  expect(notice.textContent).toContain("Pick another account");

  act(() => { (host.querySelector("[data-runtime-switch-hold-keep]") as HTMLButtonElement).click(); });
  expect(host.querySelector("[data-runtime-switch-hold]")).toBeNull();
  const keep = calls.find((call) => call.url.endsWith("/migration"));
  expect(keep).toMatchObject({ url: "/api/conversations/conversation_intent/migration", body: { action: "keep-current" } });
  await act(async () => root.unmount());
});

test("«Pick another account» opens the account choice", async () => {
  mobile = false;
  const held: FileEntry = {
    ...file,
    switchHold: { targetAccountId: "acct-b", reason: "the migration was refused", since: "2026-09-19T10:00:00.000Z" },
  };
  const { host, root } = await mount(<><RuntimeSwitchHold file={held} /><RuntimePill file={held} surface="structured" runtimeSession={session(null)} /></>);
  await act(async () => {
    (host.querySelector("[data-runtime-switch-hold-pick]") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 5));
  });
  expect(document.querySelector('[data-runtime-row="back"]')!.textContent).toContain("Account");
  await act(async () => root.unmount());
});

test("taking a pick back ends quiet: no error face, no toast, and the running row says it cancels", async () => {
  const { host, root } = await openSheet(<><TaskToastHost /><RuntimePill file={file} surface="structured" runtimeSession={session("acct-b")} /></>);
  /* While the pick waits, the account it runs on is the way back and says so. */
  expect(row("acct-a").querySelector("[data-runtime-account-cancel]")!.textContent).toBe("cancel switch");
  act(() => { row("acct-a").click(); });
  expect(header()).toBe("runs on Account A");
  expect(row("acct-a").querySelector("[data-runtime-account-cancel]")).toBeNull();
  /* The queue settles the withdrawn pick as a failed receipt with reason «cancelled». */
  const withdrawn: RuntimeSession = {
    ...session(null),
    revision: 5,
    recentReceipts: [{
      operationId: "pick-op", idempotencyKey: "pick-op", conversationId: "conversation_intent",
      kind: "reconfigure", status: "failed", reason: "cancelled", at: "2026-09-19T10:00:00.000Z", revision: 5,
    }],
  };
  await act(async () => {
    root.render(<><TaskToastHost /><RuntimePill file={file} surface="structured" runtimeSession={withdrawn} /></>);
    await new Promise((r) => setTimeout(r, 5));
  });
  expect(host.textContent).not.toContain("cancelled");
  expect(host.querySelector("[data-runtime-pill]")!.innerHTML).not.toContain("danger");
  expect(host.querySelector("[data-runtime-switch-pending]")).toBeNull();
  await act(async () => root.unmount());
});

test("an account pick the session projects writes no pending phase for a later page to restore as a spinner", async () => {
  const { host, root } = await mount(<RuntimePill file={file} surface="structured" runtimeSession={session("acct-b")} />);
  expect([...Array(localStorage.length).keys()].map((i) => localStorage.getItem(localStorage.key(i)!))).not.toContain("pending");
  await act(async () => root.unmount());
  /* A fresh page after the pick ended elsewhere: the chip keeps its model and tier. */
  const again = await mount(<RuntimePill file={file} surface="structured" runtimeSession={session(null)} />);
  const pill = again.host.querySelector("[data-runtime-pill]")!;
  expect(pill.getAttribute("aria-busy")).toBeNull();
  expect(again.host.querySelector("[data-runtime-switch-pending]")).toBeNull();
  expect(host.isConnected).toBe(true);
  await act(async () => again.root.unmount());
});

test("a held message names the known causes of a failed move in the operator's language", async () => {
  const { switchHoldReason } = await import("./RuntimePill");
  const { translate } = await import("@/lib/i18n");
  const uk = (key: string, vars?: Record<string, string | number>) => translate("uk", key as never, vars);
  expect(switchHoldReason(uk as never, "the account is signed out")).toBe("з акаунта виконано вихід");
  expect(switchHoldReason(uk as never, "You have reached your usage limit.")).toBe("акаунт вичерпав ліміт використання");
  expect(switchHoldReason(uk as never, "the migration was refused")).toBe("акаунт відмовив");
  /* Anything else is the server's own words, as they came. */
  expect(switchHoldReason(uk as never, "structured host delivery failed")).toBe("structured host delivery failed");
});

/* #1846 critique P2: the same account had two names on one page — ids in the «runs on · next on» line, labels
   in the rows beside it. Every surface names it by its label now, and by its id only when the list does not
   enumerate it. */
test("the «runs on · next on» line names accounts by the labels the rows use, the id only for an unlisted one", async () => {
  mobile = false;
  const unlisted: FileEntry = { ...file, path: "/state/accounts/claude/legacy-home/projects/viewer/session.jsonl" };
  const { host, root } = await mount(<RuntimePill file={unlisted} surface="structured" runtimeSession={{ ...session("acct-b"), accountId: "legacy-home" }} />);
  await act(async () => {
    (host.querySelector("[data-runtime-pill]") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(document.querySelector("[data-runtime-popover-account]")!.textContent).toBe("runs on legacy-home · next on Account B");
  await act(async () => root.unmount());
});

/* #1846 critique P3: on desktop the popover closes on a pick, so the pill it was made on carries the mark. */
test("the desktop pill's face carries the waiting pick, and drops it once the pick is taken back", async () => {
  mobile = false;
  const { host, root } = await mount(<RuntimePill file={file} surface="structured" runtimeSession={session(null)} />);
  const pill = () => host.querySelector("[data-runtime-pill]")!;
  expect(host.querySelector("[data-runtime-pill-next-account]")).toBeNull();
  act(() => { setPickedAccount("conversation_intent", "acct-b"); });
  expect(host.querySelector("[data-runtime-pill-next-account]")!.textContent).toBe("→ Account B");
  expect(host.querySelector("[data-runtime-pill-next-account]")!.className).toContain("text-accent");
  expect(pill().getAttribute("aria-label")).toContain("runs on Account A · next on Account B");
  act(() => { setPickedAccount("conversation_intent", null); });
  expect(host.querySelector("[data-runtime-pill-next-account]")).toBeNull();
  expect(pill().getAttribute("aria-label")).not.toContain("next on");
  await act(async () => root.unmount());
});

/** The projected pick to B after a message engaged it: the queue is moving the conversation now. */
function applyingSession(): RuntimeSession {
  return {
    ...session("acct-b"),
    revision: 6,
    recentReceipts: [{
      operationId: "pick-op", idempotencyKey: "pick-op", conversationId: "conversation_intent",
      kind: "reconfigure", status: "applying", at: "2026-09-19T10:00:00.000Z", revision: 6,
    }],
  };
}

test("a pick a message already engaged offers no cancel on the sheet, and a tap keeps no local pick", async () => {
  const { root } = await openSheet(<RuntimePill file={file} surface="structured" runtimeSession={applyingSession()} />);
  expect(header()).toBe("runs on Account A · next on Account B");
  expect(row("acct-a").querySelector("[data-runtime-account-cancel]")).toBeNull();
  expect(row("acct-a").querySelector("[data-runtime-account-switching]")!.textContent).toBe("switching now");
  expect(row("acct-a").disabled).toBe(true);
  act(() => { row("acct-a").click(); });
  expect(header()).toBe("runs on Account A · next on Account B");
  expect(calls.filter((call) => call.url === "/api/tmux")).toEqual([]);
  await act(async () => root.unmount());
});

/* #1846 review: the move waits on its migration, so the receipt went back to `queued`; the registry's claim
   still holds it, and the files response projects that claim. */
test("a claimed pick whose receipt went back to queued still offers no cancel on the sheet", async () => {
  const queuedAgain: RuntimeSession = {
    ...applyingSession(),
    recentReceipts: [{ ...applyingSession().recentReceipts[0]!, status: "queued", reason: "turn-boundary" }],
  };
  const claimed: FileEntry = { ...file, switchApplying: { operationId: "pick-op" } };
  const { root } = await openSheet(<RuntimePill file={claimed} surface="structured" runtimeSession={queuedAgain} />);
  expect(row("acct-a").querySelector("[data-runtime-account-cancel]")).toBeNull();
  expect(row("acct-a").querySelector("[data-runtime-account-switching]")!.textContent).toBe("switching now");
  expect(row("acct-a").disabled).toBe(true);
  act(() => { row("acct-a").click(); });
  expect(calls.filter((call) => call.url === "/api/tmux")).toEqual([]);
  await act(async () => root.unmount());
});

test("a pick a message already engaged offers no cancel in the desktop popover's Account panel", async () => {
  mobile = false;
  const { host, root } = await mount(<RuntimePill file={file} surface="structured" runtimeSession={applyingSession()} />);
  await act(async () => {
    (host.querySelector("[data-runtime-pill]") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    (document.querySelector('[data-runtime-row="submenu"][data-runtime-value="account"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 5));
  });
  for (let attempt = 0; attempt < 40 && document.querySelectorAll('[data-runtime-row="account"]').length < 2; attempt += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
  const running = document.querySelector('[data-runtime-row="account"][data-runtime-value="account-acct-a"]') as HTMLButtonElement;
  expect(running.querySelector('[data-runtime-row-detail="action"]')).toBeNull();
  expect(running.textContent).toContain("switching now");
  act(() => { running.click(); });
  expect(document.querySelector("[data-runtime-popover-account]")?.textContent ?? "runs on Account A · next on Account B")
    .toBe("runs on Account A · next on Account B");
  expect(calls.filter((call) => call.url === "/api/tmux")).toEqual([]);
  await act(async () => root.unmount());
});
