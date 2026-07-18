/**
 * Issue #405 (parent #390 §10) — the frozen per-idempotency-key runtime
 * snapshot at the composer level.
 *
 * The durable-delivery contract says a replayed idempotency key re-delivers
 * with IDENTICAL settings: the runtime override a structured send carries is
 * snapshotted at the key's first attempt, so changing the pill selection
 * between a failure and its retry must never rewrite what that key sends.
 * These tests drive the REAL composer form against a mocked wire and assert
 * the `/api/runtime/send` bodies that `sendRuntimeMessage` posts.
 */
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import type { RuntimeSessionView } from "@/hooks/useRuntime";
import type { FileEntry } from "@/lib/types";
import { setLocale } from "@/lib/i18n";

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

/* A live structured codex-app-server host for the conversation: the send path
   must take `sendRuntimeMessage`, not the legacy /api/tmux POST. */
const structuredView: RuntimeSessionView = {
  session: {
    conversationId: "conv-snapshot",
    hostKind: "codex-app-server",
    host: "hosted",
    capabilities: { imageInput: { supported: true }, runtimeSettings: { perTurnEffort: true, perTurnModel: false } },
  },
  uiState: {},
  attentions: [],
  receipts: [],
  legacy: false,
  structuredControlsEnabled: true,
} as unknown as RuntimeSessionView;

const actualRuntimeHooks = await import("@/hooks/useRuntime");
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeSession: () => structuredView,
  useRuntimeReceiptsForArtifact: () => [],
}));
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

const { TmuxComposer } = await import("./TmuxComposer");
const { writeProfile } = await import("./runtimeProfile");

const realFetch = globalThis.fetch;

afterEach(() => {
  setLocale("en");
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});

const file: FileEntry = {
  path: "/codex-snapshot.jsonl", root: "codex-sessions", name: "codex-snapshot.jsonl", project: "viewer",
  title: "Codex", engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1,
  size: 1, activity: "idle", proc: "running", pid: null, conversationId: "conv-snapshot",
  model: "gpt-5.6-sol", effort: "high", fast: false, pendingQuestion: null, waitingInput: null,
} as FileEntry;

interface SendBody {
  idempotencyKey: string;
  text: string;
  runtime?: { model?: string; effort?: string; fast?: boolean };
}

/** Wire mock: records every /api/runtime/send body; `respond` scripts each
    response in order (a 500 keeps the key retryable, a delivered receipt
    settles it). */
function mockWire(sends: SendBody[], respond: Array<(body: SendBody) => { status: number; json: unknown }>): void {
  let call = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: { body?: string }) => {
    const url = String(input);
    if (url === "/api/tmux/targets") return { ok: true, status: 200, json: async () => ({ targets: {} }) } as Response;
    if (url !== "/api/runtime/send") return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    const body = JSON.parse(init?.body ?? "{}") as SendBody;
    sends.push(body);
    const script = respond[Math.min(call++, respond.length - 1)]!(body);
    return { ok: script.status < 400, status: script.status, json: async () => script.json } as Response;
  }) as typeof fetch;
}

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

/** Type into the composer through its React props (happy-dom input events do
    not reach React's synthetic onChange) and submit the form. */
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

const delivered = (body: SendBody) => ({
  status: 200,
  json: {
    ok: true,
    receipt: {
      operationId: `op-${body.idempotencyKey}`,
      idempotencyKey: body.idempotencyKey,
      conversationId: "conv-snapshot",
      kind: "send",
      status: "delivered",
      text: body.text,
      at: new Date().toISOString(),
      revision: 1,
    },
  },
});

test("a same-key retry re-sends the ORIGINAL runtime snapshot even after the selection changed", async () => {
  // The user explicitly selected ultra before sending (sparse :profile).
  localStorage.setItem("llvAgentRuntime:conv-snapshot:profile", JSON.stringify({ effort: "ultra" }));
  const sends: SendBody[] = [];
  mockWire(sends, [
    () => ({ status: 502, json: { error: "wire down" } }), // retryable: key survives
    delivered,
  ]);

  const { host, root } = await renderInto(<TmuxComposer file={file} />);
  const { type, submit } = composerControls(host);

  await settle(() => type("run the migration"));
  await settle(() => submit());
  expect(sends).toHaveLength(1);
  expect(sends[0]!.runtime).toEqual({ effort: "ultra" });

  // Between the failure and the retry the user flips the pill to low.
  writeProfile(file, { effort: "low" });

  await settle(() => submit());
  expect(sends).toHaveLength(2);
  // Same idempotency key ⇒ byte-identical runtime snapshot (issue #390 §10):
  // the frozen first-attempt settings ride, never the current selection.
  expect(sends[1]!.idempotencyKey).toBe(sends[0]!.idempotencyKey);
  expect(sends[1]!.runtime).toEqual({ effort: "ultra" });
  expect(sends[1]!.text).toBe(sends[0]!.text);

  // The NEXT message is a new key and honestly carries the new selection.
  await settle(() => type("second message"));
  await settle(() => submit());
  expect(sends).toHaveLength(3);
  expect(sends[2]!.idempotencyKey).not.toBe(sends[0]!.idempotencyKey);
  expect(sends[2]!.runtime).toEqual({ effort: "low" });

  await act(async () => root.unmount());
});

test("a send with no explicit selection rides no runtime override, on first attempt and on retry", async () => {
  const sends: SendBody[] = [];
  mockWire(sends, [
    () => ({ status: 502, json: { error: "wire down" } }),
    delivered,
  ]);

  const { host, root } = await renderInto(<TmuxComposer file={file} />);
  const { type, submit } = composerControls(host);

  await settle(() => type("no override"));
  await settle(() => submit());
  // A selection made after admission must not leak into the key's retry.
  writeProfile(file, { effort: "medium" });
  await settle(() => submit());

  expect(sends).toHaveLength(2);
  expect(sends[0]!.runtime).toBeUndefined();
  expect(sends[1]!.idempotencyKey).toBe(sends[0]!.idempotencyKey);
  expect(sends[1]!.runtime).toBeUndefined();

  await act(async () => root.unmount());
});
