/**
 * P1 — a dead conversation cannot be continued: the composer re-stamped a stale
 * unresolved generation's idempotency key onto the operator's NEW message, so
 * the send either silently replayed the stale bytes or hit the registry's
 * reservation guard ("client message id is already reserved for another
 * request") and the conversation became uncontinuable.
 *
 * These tests drive the REAL composer form against a mocked /api/runtime/send
 * wire across an unmount/remount (the durable-records rebuild) and pin the key
 * lifecycle: a genuinely new message always leaves under a FRESH key carrying
 * ITS OWN text; a retry of a failed submission replays the original key and
 * bytes exactly; an edited resend is a new message under a new key.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import type { RuntimeSessionView } from "@/hooks/useRuntime";
import type { FileEntry } from "@/lib/types";
import { setLocale } from "@/lib/i18n";
import { installTmuxComposerRuntimeForTests, resetTmuxComposerRuntimeForTests } from "@/test-helpers/tmuxComposerRuntime";

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  File: dom.File,
  FileReader: dom.FileReader,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

/* A structured codex-app-server host for the conversation, so the send path is
   `sendRuntimeMessage` — the seam the production defect lived on. */
const structuredView: RuntimeSessionView = {
  session: {
    conversationId: "conv-stale-key",
    hostKind: "codex-app-server",
    host: "hosted",
    capabilities: { imageInput: { supported: true }, runtimeSettings: { perTurnEffort: true, perTurnModel: false } },
    recentReceipts: [],
  },
  uiState: {},
  attentions: [],
  receipts: [],
  legacy: false,
  structuredControlsEnabled: true,
} as unknown as RuntimeSessionView;

import { TmuxComposer } from "./TmuxComposer";
import { readOutbox, resetOutboxForTests, retryOutbox } from "./conversation/outbox";

const realFetch = globalThis.fetch;

beforeEach(() => {
  structuredView.receipts = [];
  installTmuxComposerRuntimeForTests({
    useRuntimeView: (candidate) => candidate.conversationId === "conv-stale-key" ? structuredView : null,
    refreshRuntime: async () => true,
    useRuntimeReceipts: () => structuredView.receipts,
  });
});

afterEach(() => {
  resetTmuxComposerRuntimeForTests();
  setLocale("en");
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  resetOutboxForTests();
});

const file: FileEntry = {
  path: "/codex-stale-key.jsonl", root: "codex-sessions", name: "codex-stale-key.jsonl", project: "viewer",
  title: "Codex", engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1,
  size: 1, activity: "idle", proc: "running", pid: null, conversationId: "conv-stale-key",
  pendingQuestion: null, waitingInput: null,
} as FileEntry;

interface SendBody {
  idempotencyKey: string;
  text: string;
}

function mockWire(sends: SendBody[], respond: Array<(body: SendBody) => { status: number; json: unknown }>): void {
  let call = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: { body?: string }) => {
    const url = String(input);
    if (url === "/api/tmux/targets") return { ok: true, status: 200, json: async () => ({ targets: {} }) } as Response;
    if (url !== "/api/runtime/send") throw new Error(`unexpected request: ${url}`);
    const body = JSON.parse(init?.body ?? "{}") as SendBody;
    sends.push(body);
    const script = respond[Math.min(call++, respond.length - 1)]!(body);
    return { ok: script.status < 400, status: script.status, json: async () => script.json } as Response;
  }) as typeof fetch;
}

const delivered = (body: SendBody) => ({
  status: 200,
  json: {
    ok: true,
    receipt: {
      operationId: `op-${body.idempotencyKey}`,
      idempotencyKey: body.idempotencyKey,
      conversationId: "conv-stale-key",
      kind: "send",
      status: "delivered",
      text: body.text,
      at: new Date().toISOString(),
      revision: 1,
    },
  },
});

async function renderInto(node: React.ReactElement): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
    await new Promise((r) => setTimeout(r, 0));
  });
  return { host, root };
}

const settle = async (fn: () => void) => {
  await act(async () => {
    fn();
    await new Promise((r) => setTimeout(r, 0));
  });
};

function composerControls(host: HTMLElement) {
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const form = textarea.closest("form")!;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const type = (value: string) =>
    (textarea as unknown as Record<string, { onChange: (e: unknown) => void }>)[propsKey]!
      .onChange({ target: { value } });
  const submit = () => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
  return { type, submit };
}

test("a remount cannot stamp a stale unresolved generation's key onto the operator's new message", async () => {
  const sends: SendBody[] = [];
  mockWire(sends, [
    /* The host is gone: the first send fails on a 503 whose admission stays
       uncertain, so the generation persists as an unresolved pending record —
       the durable state the operator's tab rebuilds from. */
    () => ({ status: 503, json: { ok: false, error: "structured host ownership is unavailable; retry after runtime synchronization" } }),
    delivered,
  ]);

  const rendered = await renderInto(<TmuxComposer file={file} />);
  const host = rendered.host;
  let root = rendered.root;
  await settle(() => composerControls(host).type("the message the dead host never received"));
  await settle(() => composerControls(host).submit());
  expect(sends).toHaveLength(1);
  expect(sends[0]!.text).toBe("the message the dead host never received");
  /* The unresolved generation is durable and cannot be locally retried. */
  expect(sessionStorage.getItem("llvPendingSend:conv-stale-key")).toContain(sends[0]!.idempotencyKey);
  expect(readOutbox("conv-stale-key").find((entry) => entry.deliveryUncertain)?.id).toBe(sends[0]!.idempotencyKey);

  /* The tab reloads: the composer rebuilds its outbox state from the durable
     records while the stale generation is still unresolved. */
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => {
    root.render(<TmuxComposer file={file} />);
    await new Promise((r) => setTimeout(r, 0));
  });

  /* The operator types a genuinely NEW message. It must leave under a FRESH
     key carrying ITS OWN text — never the stale generation's key or bytes. */
  await settle(() => composerControls(host).type("a brand new message"));
  await settle(() => composerControls(host).submit());
  expect(sends).toHaveLength(1);
  const queued = readOutbox("conv-stale-key").find(entry => entry.text === "a brand new message")!;
  expect(queued.id).not.toBe(sends[0]!.idempotencyKey);
  expect(queued.state).toBe("queued");
  structuredView.receipts = [delivered(sends[0]!).json.receipt as RuntimeSessionView["receipts"][number]];
  await settle(() => root.render(<TmuxComposer file={file} />));
  expect(sends).toHaveLength(2);
  expect(sends[1]!.text).toBe("a brand new message");
  expect(sends[1]!.idempotencyKey).not.toBe(sends[0]!.idempotencyKey);

  await act(async () => root.unmount());
});

test("a retry replays the failed generation exactly while an edited resend is a new message", async () => {
  const sends: SendBody[] = [];
  mockWire(sends, [
    body => ({ status: 503, json: { ok: false, receipt: {
      operationId: "safe-original", conversationId: "conv-stale-key", idempotencyKey: body.idempotencyKey,
      kind: "send", status: "failed", resend: "safe", reason: "pre-dispatch rejection",
      at: new Date().toISOString(), revision: 1,
    } } }),
    delivered,
  ]);

  const { host, root } = await renderInto(<TmuxComposer file={file} />);
  await settle(() => composerControls(host).type("recover the stalled worktree"));
  await settle(() => composerControls(host).submit());
  expect(sends).toHaveLength(1);

  /* Retrying the failed bubble replays the SAME key with the SAME bytes: an
     idempotent replay, never a second distinct message. */
  const failed = readOutbox("conv-stale-key").find((entry) => entry.state === "failed")!;
  await settle(() => retryOutbox("conv-stale-key", failed.id));
  expect(sends).toHaveLength(2);
  expect(sends[1]!.idempotencyKey).toBe(sends[0]!.idempotencyKey);
  expect(sends[1]!.text).toBe(sends[0]!.text);

  /* An edited resend is a NEW message: fresh key, its own bytes. */
  await settle(() => composerControls(host).type("recover the stalled worktree, then report"));
  await settle(() => composerControls(host).submit());
  expect(sends).toHaveLength(3);
  expect(sends[2]!.idempotencyKey).not.toBe(sends[0]!.idempotencyKey);
  expect(sends[2]!.text).toBe("recover the stalled worktree, then report");

  await act(async () => root.unmount());
});
