import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";
import type { FileEntry } from "@/lib/types";

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  MouseEvent: dom.MouseEvent,
  Event: dom.Event,
  localStorage: dom.localStorage,
});
(dom as unknown as { matchMedia(query: string): unknown }).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

mock.module("@/hooks/useEngineAccounts", () => ({
  useEngineAccounts: () => ({
    accounts: [
      { id: "source", label: "Source", authPresent: true, loginPending: false },
      { id: "target", label: "Target", authPresent: true, loginPending: false },
      { id: "signed-out", label: "Signed out", authPresent: false, loginPending: false },
    ],
    active: "source",
  }),
}));
/** Recorded, because the answer to an out-of-pool switch is a toast and nothing
    else: it is the one place the operator learns the choice was recorded — or
    that it was not. */
const toasts: { kind: string; message: string }[] = [];
mock.module("./tasks/taskToast", () => ({
  pushTaskToast: (kind: string, message: string) => { toasts.push({ kind, message }); },
}));

const { AccountBadge } = await import("./AccountBadge");
const { resetPickedAccountsForTests } = await import("@/lib/accounts/intendedAccount");

const file: FileEntry = {
  path: "/sessions/source.jsonl",
  root: "codex-sessions",
  name: "source.jsonl",
  project: "viewer",
  title: "source",
  engine: "codex",
  kind: "session",
  fmt: "codex",
  parent: null,
  mtime: 1,
  size: 1,
  activity: "recent",
  proc: "running",
  pid: 10,
  conversationId: "conversation_account_switch",
  model: "gpt-5.6-sol",
  effort: "high",
  fast: false,
  pendingQuestion: null,
  waitingInput: null,
};

const requests: Record<string, unknown>[] = [];
let responseBody: Record<string, unknown> = {
  ok: true,
  operationId: "account-switch-one",
  receipt: { operationId: "account-switch-one", status: "queued" },
};
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
  return new Response(JSON.stringify(responseBody), { status: 202, headers: { "content-type": "application/json" } });
}) as typeof fetch;

afterEach(() => {
  resetPickedAccountsForTests();
  document.body.replaceChildren();
  localStorage.clear();
  requests.length = 0;
  toasts.length = 0;
  responseBody = {
    ok: true,
    operationId: "account-switch-one",
    receipt: { operationId: "account-switch-one", status: "queued" },
  };
});

test("the card account chip records the pick at once, with no spinner, and disables signed-out targets", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<AccountBadge engine="codex" accountId="source" file={file} />); });

  const chip = host.querySelector("[data-conversation-account-chip]")!;
  await act(async () => { chip.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
  const menu = document.querySelector("[data-conversation-account-menu]")!;
  const rows = [...menu.querySelectorAll('[role="menuitemradio"]')] as HTMLButtonElement[];
  expect(rows.map((row) => row.textContent?.trim())).toEqual(["Source", "Target", "Signed out"]);
  expect(rows[2]!.disabled).toBe(true);

  await act(async () => {
    rows[1]!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(requests).toEqual([expect.objectContaining({
    action: "reconfigure",
    conversationId: "conversation_account_switch",
    accountId: "target",
    model: "gpt-5.6-sol",
    effort: "high",
    fast: false,
  })]);
  /* #1846: the chip names where the next message goes and waits for nothing. */
  const pickedChip = host.querySelector("[data-conversation-account-chip]")!;
  expect(pickedChip.getAttribute("data-conversation-account-next")).toBe("target");
  /* Named by the label its menu row carries (#1846 critique P2). */
  expect(pickedChip.textContent).toContain("@ Source");
  expect(pickedChip.textContent).toContain("→ Target");
  expect(pickedChip.getAttribute("aria-busy")).toBeNull();
  expect(pickedChip.querySelector(".animate-spin")).toBeNull();
  await act(async () => root.unmount());
});

test("a pick retires once the conversation runs on the picked account", async () => {
  responseBody = { ok: true, outcome: "pending" };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<AccountBadge engine="codex" accountId="source" file={file} />); });

  await act(async () => {
    host.querySelector<HTMLElement>("[data-conversation-account-chip]")!
      .dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  });
  const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
  await act(async () => {
    rows[1]!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.textContent).toContain("→ Target");

  await act(async () => { root.render(<AccountBadge engine="codex" accountId="target" file={file} />); });
  expect(host.textContent).not.toContain("→");
  expect(toasts).toEqual([]);
  await act(async () => root.unmount());
});

test("a failed legacy account switch takes the pick back and says why", async () => {
  responseBody = { ok: true, outcome: "pending" };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<AccountBadge engine="codex" accountId="source" file={file} />); });

  await act(async () => {
    host.querySelector<HTMLElement>("[data-conversation-account-chip]")!
      .dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  });
  const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
  await act(async () => {
    rows[1]!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.textContent).toContain("→ Target");

  const failedFile: FileEntry = {
    ...file,
    migration: {
      intentId: "legacy-account-switch",
      trigger: "manual",
      phase: "failed-recoverable",
      targetAccountId: "target",
      failure: "successor authentication expired",
      revision: 2,
    },
  };
  await act(async () => {
    root.render(<AccountBadge engine="codex" accountId="source" file={failedFile} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(host.textContent).not.toContain("→");
  expect(toasts).toEqual([{ kind: "err", message: "successor authentication expired" }]);
  await act(async () => {
    host.querySelector<HTMLElement>("[data-conversation-account-chip]")!
      .dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  });
  const reopenedRows = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
  expect(reopenedRows[1]!.disabled).toBeFalse();
  await act(async () => root.unmount());
});

test("an account switch carries the latest conversation runtime profile", async () => {
  localStorage.setItem("llvAgentRuntime:conversation_account_switch:profile", JSON.stringify({
    model: "gpt-5.6-terra",
    effort: "medium",
    fast: true,
  }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<AccountBadge engine="codex" accountId="source" file={file} />); });

  await act(async () => {
    host.querySelector<HTMLElement>("[data-conversation-account-chip]")!
      .dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  });
  const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
  await act(async () => {
    rows[1]!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(requests[0]).toMatchObject({
    accountId: "target",
    model: "gpt-5.6-terra",
    effort: "medium",
    fast: true,
  });
  await act(async () => root.unmount());
});

/** Click "Target" on an open chip menu and let the answer settle. */
async function switchToTarget(host: HTMLElement): Promise<void> {
  await act(async () => {
    host.querySelector<HTMLElement>("[data-conversation-account-chip]")!
      .dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  });
  const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
  await act(async () => {
    rows[1]!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test("an out-of-pool switch that was recorded says so", async () => {
  responseBody = {
    ok: true,
    outcome: "pending",
    accountOverride: { outsidePool: true, recorded: true },
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<AccountBadge engine="codex" accountId="source" file={file} />); });

  await switchToTarget(host);

  expect(toasts).toEqual([{ kind: "ok", message: expect.stringContaining("recorded as your choice") }]);
  await act(async () => root.unmount());
});

test("an out-of-pool switch the journal could not record is not answered \"recorded\"", async () => {
  /* The switch went through — a record that would not write is not a decision
     anybody made — and this is the only surface that can tell the operator the
     one thing the project's accounts will not show them afterwards. Answered
     with the recorded wording, it said the opposite of what happened. */
  responseBody = {
    ok: true,
    outcome: "pending",
    accountOverride: { outsidePool: true, recorded: false, recordFailure: "the journal write failed" },
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<AccountBadge engine="codex" accountId="source" file={file} />); });

  await switchToTarget(host);

  expect(toasts).toHaveLength(1);
  expect(toasts[0]!.kind).toBe("err");
  expect(toasts[0]!.message).toContain("the record could not be written");
  expect(toasts[0]!.message).not.toContain("recorded as your choice");
  /* The switch itself still happened, so the badge names it. */
  expect(host.textContent).toContain("→ Target");
  await act(async () => root.unmount());
});

test("a switch inside the project's pool says nothing at all", async () => {
  responseBody = { ok: true, outcome: "pending" };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<AccountBadge engine="codex" accountId="source" file={file} />); });

  await switchToTarget(host);

  expect(toasts).toEqual([]);
  await act(async () => root.unmount());
});

test("the account it runs on takes a waiting pick back, and nothing waits a minute to call it an error", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<AccountBadge engine="codex" accountId="source" file={file} />); });
  await switchToTarget(host);
  await act(async () => {
    host.querySelector<HTMLElement>("[data-conversation-account-chip]")!
      .dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  });
  const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
  expect(rows.map((row) => row.disabled)).toEqual([false, false, true]);
  expect(rows[0]!.querySelector("[data-conversation-account-cancel]")!.textContent).toBe("cancel switch");
  expect(rows[1]!.getAttribute("aria-checked")).toBe("true");
  await act(async () => {
    rows[0]!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(requests.map((request) => request.accountId)).toEqual(["target", "source"]);
  expect(host.textContent).not.toContain("→");
  expect(toasts).toEqual([]);
  await act(async () => root.unmount());
});

test("a claimed pick whose receipt went back to queued still offers no cancel on the chip", async () => {
  const queuedAgain = {
    conversationId: "conversation_account_switch",
    pendingReconfigure: { operationId: "pick-target", model: "gpt-5.6-sol", effort: "high", fast: false, accountId: "target" },
    recentReceipts: [{
      operationId: "pick-target", idempotencyKey: "pick-target", conversationId: "conversation_account_switch",
      kind: "reconfigure", status: "queued", reason: "turn-boundary", at: "2026-09-19T10:00:00.000Z", revision: 7,
    }],
  } as unknown as import("./runtime/runtimeModel").RuntimeSession;
  const claimed: FileEntry = { ...file, switchApplying: { operationId: "pick-target" } };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<AccountBadge engine="codex" accountId="source" file={claimed} runtimeSession={queuedAgain} />); });
  await act(async () => {
    host.querySelector<HTMLElement>("[data-conversation-account-chip]")!
      .dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  });
  const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
  expect(rows[0]!.querySelector("[data-conversation-account-cancel]")).toBeNull();
  expect(rows[0]!.querySelector("[data-conversation-account-switching]")!.textContent).toBe("switching now");
  expect(rows[0]!.disabled).toBe(true);
  expect(requests).toEqual([]);
  await act(async () => root.unmount());
});

test("a pick a message already engaged offers no cancel on the chip, and a tap keeps no local pick", async () => {
  const applying = {
    conversationId: "conversation_account_switch",
    pendingReconfigure: { operationId: "pick-target", model: "gpt-5.6-sol", effort: "high", fast: false, accountId: "target" },
    recentReceipts: [{
      operationId: "pick-target", idempotencyKey: "pick-target", conversationId: "conversation_account_switch",
      kind: "reconfigure", status: "applying", at: "2026-09-19T10:00:00.000Z", revision: 6,
    }],
  } as unknown as import("./runtime/runtimeModel").RuntimeSession;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<AccountBadge engine="codex" accountId="source" file={file} runtimeSession={applying} />); });
  expect(host.querySelector("[data-conversation-account-chip]")!.getAttribute("data-conversation-account-next")).toBe("target");
  await act(async () => {
    host.querySelector<HTMLElement>("[data-conversation-account-chip]")!
      .dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  });
  const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
  expect(rows[0]!.querySelector("[data-conversation-account-cancel]")).toBeNull();
  expect(rows[0]!.querySelector("[data-conversation-account-switching]")!.textContent).toBe("switching now");
  expect(rows[0]!.disabled).toBe(true);
  await act(async () => {
    rows[0]!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(requests).toEqual([]);
  expect(host.querySelector("[data-conversation-account-chip]")!.getAttribute("data-conversation-account-next")).toBe("target");
  await act(async () => root.unmount());
});
