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
import { setLocale, translate } from "@/lib/i18n";

const dom = new Window();
installActEnv();
class ImmediateFileReader {
  result: string | null = null;
  error: null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  readAsDataURL(file: File): void {
    const mime = file.type || "image/png";
    this.result = `data:${mime};base64,${Buffer.from(file.name).toString("base64")}`;
    queueMicrotask(() => this.onload?.());
  }
}
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
  FileReader: ImmediateFileReader,
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
/* Capture the real implementations BEFORE mock.module rewires the registry:
   the namespace's members are live bindings, so reading them after the mock
   would resolve to the mock itself (infinite recursion). */
const realUseRuntimeSession = actualRuntimeHooks.useRuntimeSession;
const realUseRuntimeReceiptsForArtifact = actualRuntimeHooks.useRuntimeReceiptsForArtifact;
/* bun's mock.module registry is global and the afterAll restore does NOT reach
   test files loaded later, so an unconditional stub would leak this structured
   view into every downstream pane test (it flipped 6 BranchPane surfaces to
   "structured"). The mock therefore delegates to the REAL hooks for every
   conversation except this file's own `conv-snapshot` — loaded after this
   file, other suites observe real behavior. The real hook always runs first
   so the hook order never varies across the branch. */
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeSession: (conversationId: string | null) => {
    const real = realUseRuntimeSession(conversationId);
    return conversationId === "conv-snapshot" ? structuredView : real;
  },
  useRuntimeReceiptsForArtifact: (path: string | null, conversationId?: string | null) => {
    const real = realUseRuntimeReceiptsForArtifact(path, conversationId);
    return path === "/codex-snapshot.jsonl" || conversationId === "conv-snapshot" ? [] : real;
  },
}));
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

const { TmuxComposer } = await import("./TmuxComposer");
const { writeProfile } = await import("./runtimeProfile");

const realFetch = globalThis.fetch;

afterEach(() => {
  setLocale("en");
  structuredView.session.host = "hosted";
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
  images?: Array<{ base64: string; mime: string }>;
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
    if (url !== "/api/runtime/send") throw new Error(`unexpected request: ${url}`);
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

async function pasteImages(host: HTMLElement, names: string[]): Promise<void> {
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, {
    onPaste(event: unknown): void;
  }>)[propsKey]!;
  const files = names.map((name) => new dom.File([name], name, { type: "image/png" }) as unknown as File);
  await act(async () => {
    props.onPaste({
      clipboardData: {
        items: files.map((image) => ({ type: image.type, getAsFile: () => image })),
      },
      preventDefault() {},
    });
    await Promise.resolve();
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (host.querySelectorAll('[data-testid="attachment-tile"][data-status="ready"]').length === names.length) return;
  }
  throw new Error("image attachments did not finish reading");
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

test("unhosted structured composer sends through durable recovery admission", async () => {
  structuredView.session.host = "unhosted";
  const sends: SendBody[] = [];
  mockWire(sends, [delivered]);

  const { host, root } = await renderInto(<TmuxComposer file={file} deadHost />);
  const { type, submit } = composerControls(host);
  await settle(() => type("continue while the host recovers"));
  await settle(() => submit());

  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({
    text: "continue while the host recovers",
    idempotencyKey: expect.any(String),
  });
  await act(async () => root.unmount());
});

test("dead structured image-only submission keeps every selected image off the unsafe recovery path", async () => {
  const sends: SendBody[] = [];
  mockWire(sends, [() => ({ status: 503, json: { error: "recovery failed before image admission" } })]);

  const { host, root } = await renderInto(<TmuxComposer file={file} />);
  await pasteImages(host, ["first.png", "second.png"]);
  expect(host.querySelectorAll('[data-testid="attachment-tile"][data-status="ready"]')).toHaveLength(2);

  structuredView.session.host = "unhosted";
  await act(async () => {
    root.render(<TmuxComposer file={file} deadHost />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const imagePicker = host.querySelector(`button[aria-label="${translate("en", "composer.addImages")}"]`) as HTMLButtonElement;
  const send = host.querySelector('button[type="submit"]') as HTMLButtonElement;
  expect(imagePicker.disabled).toBe(true);
  expect(send.disabled).toBe(true);

  await settle(() => composerControls(host).submit());
  expect(sends).toHaveLength(0);
  expect(host.querySelectorAll('[data-testid="attachment-tile"][data-status="ready"]')).toHaveLength(2);
  await act(async () => root.unmount());
});

test("dead structured text-plus-image submission preserves the complete draft with image-specific recovery guidance", async () => {
  const sends: SendBody[] = [];
  mockWire(sends, [() => ({ status: 503, json: { error: "recovery failed before image admission" } })]);

  const { host, root } = await renderInto(<TmuxComposer file={file} />);
  const { type } = composerControls(host);
  await settle(() => type("keep this text with both screenshots"));
  await pasteImages(host, ["context.png", "result.png"]);

  structuredView.session.host = "unhosted";
  await act(async () => {
    root.render(<TmuxComposer file={file} deadHost />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settle(() => composerControls(host).submit());

  expect(sends).toHaveLength(0);
  expect((host.querySelector("textarea") as HTMLTextAreaElement).value)
    .toBe("keep this text with both screenshots");
  expect(host.querySelectorAll('[data-testid="attachment-tile"][data-status="ready"]')).toHaveLength(2);
  expect(host.textContent).toContain(translate("en", "composer.imagesBlockedDuringRecovery"));
  await act(async () => root.unmount());
});

test("structured recovery state is bounded and exposes retry details", async () => {
  structuredView.session.host = "unhosted";
  let finishRecovery!: (response: Response) => void;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/tmux/targets") {
      return { ok: true, status: 200, json: async () => ({ targets: {} }) } as Response;
    }
    if (url !== "/api/runtime/send") throw new Error(`unexpected request: ${url}`);
    return new Promise<Response>((resolve) => { finishRecovery = resolve; });
  }) as typeof fetch;

  const { host, root } = await renderInto(<TmuxComposer file={file} deadHost />);
  const { type, submit } = composerControls(host);
  await settle(() => type("preserve this recovery draft"));
  await settle(() => submit());
  expect(host.textContent).toContain(translate("en", "composer.receiptRecovering"));

  await act(async () => {
    finishRecovery({
      ok: false,
      status: 503,
      json: async () => ({ error: "recovery attempt failed; retry is available" }),
    } as Response);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.textContent).toContain("recovery attempt failed; retry is available");
  expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("preserve this recovery draft");
  await act(async () => root.unmount());
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

test("the delegating mock leaks nothing: another conversation resolves the REAL session and takes the legacy send path", async () => {
  /* Regression for the bun mock.module leak: an unconditional structured stub
     here flipped every later-loaded pane test (e.g. BranchPane.render) to the
     "structured" surface. With the delegate in place, any conversation other
     than conv-snapshot must observe the real hook — a null session — and send
     via /api/tmux, never /api/runtime/send. */
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return { ok: true, status: 200, json: async () => ({ ok: true, targets: {} }) } as Response;
  }) as typeof fetch;
  const other: FileEntry = {
    ...file, path: "/codex-other.jsonl", name: "codex-other.jsonl", conversationId: "conv-other",
  } as FileEntry;

  const { host, root } = await renderInto(<TmuxComposer file={other} />);
  const { type, submit } = composerControls(host);
  await settle(() => type("legacy route"));
  await settle(() => submit());

  expect(urls).toContain("/api/tmux");
  expect(urls).not.toContain("/api/runtime/send");
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
