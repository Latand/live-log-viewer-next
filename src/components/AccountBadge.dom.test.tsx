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
mock.module("./tasks/taskToast", () => ({ pushTaskToast: () => {} }));

const { AccountBadge } = await import("./AccountBadge");

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
  document.body.replaceChildren();
  localStorage.clear();
  requests.length = 0;
  responseBody = {
    ok: true,
    operationId: "account-switch-one",
    receipt: { operationId: "account-switch-one", status: "queued" },
  };
});

test("the card account chip queues a conversation-scoped switch and disables signed-out targets", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<AccountBadge engine="codex" accountId="source" file={file} />); });

  const chip = host.querySelector("[data-conversation-account-chip]")!;
  await act(async () => { chip.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
  const menu = host.querySelector("[data-conversation-account-menu]")!;
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
  expect(host.textContent).toContain("Account switch pending");
  await act(async () => root.unmount());
});

test("a legacy account switch settles when scanner ownership reaches the target account", async () => {
  responseBody = { ok: true, outcome: "pending" };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<AccountBadge engine="codex" accountId="source" file={file} />); });

  await act(async () => {
    host.querySelector<HTMLElement>("[data-conversation-account-chip]")!
      .dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  });
  const rows = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
  await act(async () => {
    rows[1]!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.textContent).toContain("Account switch pending");

  await act(async () => { root.render(<AccountBadge engine="codex" accountId="target" file={file} />); });
  expect(host.textContent).not.toContain("Account switch pending");
  await act(async () => root.unmount());
});

test("a failed legacy account switch clears its pending badge and re-enables choices", async () => {
  responseBody = { ok: true, outcome: "pending" };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<AccountBadge engine="codex" accountId="source" file={file} />); });

  await act(async () => {
    host.querySelector<HTMLElement>("[data-conversation-account-chip]")!
      .dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  });
  const rows = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
  await act(async () => {
    rows[1]!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.textContent).toContain("Account switch pending");

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

  expect(host.textContent).not.toContain("Account switch pending");
  await act(async () => {
    host.querySelector<HTMLElement>("[data-conversation-account-chip]")!
      .dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  });
  const reopenedRows = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
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
  const rows = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
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
