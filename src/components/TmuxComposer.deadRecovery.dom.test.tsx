/**
 * Issue #499 (repair round) — the dead STRUCTURED host composer must present
 * exactly the production capability set, truthfully, in both locales:
 *
 *   - Send stays enabled: text is admitted durably and delivered after the
 *     host recovers (the capability matrix's `dead` row keeps send ENABLED);
 *   - the image restriction is explained inline (the matrix disables images
 *     with `composer.imagesBlockedDuringRecovery` while the host is down);
 *   - the model/reasoning pill is NOT offered (the matrix hides `runtime` on
 *     the dead surface), so no committed evidence may depict one.
 *
 * Mirrors the mock-wire pattern of TmuxComposer.sendReadiness.dom.test.tsx
 * with the session's host axis flipped to `dead`.
 */
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { RuntimeSessionView } from "@/hooks/useRuntime";
import type { FileEntry } from "@/lib/types";
import { setLocale, translate } from "@/lib/i18n";

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
let mobile = false;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: mobile,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

/** A structured codex-app-server session whose host axis is dead — exactly the
    runtime-bus projection behind the BranchPane dead-recovery composition. */
function deadStructuredView(conversationId: string): RuntimeSessionView {
  return {
    session: {
      conversationId,
      sessionKey: { engine: "codex", sessionId: "codex-session-499-dead" },
      hostKind: "codex-app-server",
      host: "dead",
      turn: "idle",
      provenance: "structured",
      revision: 5,
      attentionIds: [],
      recentReceipts: [],
      accountId: null,
      parentConversationId: null,
      flowId: null,
      workflowId: null,
      cwd: "/home/user/projects/viewer",
      artifactPath: null,
      capabilities: {
        steer: true,
        structuredAttention: true,
        imageInput: { supported: true },
        runtimeSettings: { perTurnEffort: true, perTurnModel: false },
      },
      activeTurnId: null,
    },
    uiState: {},
    attentions: [],
    receipts: [],
    legacy: false,
    structuredControlsEnabled: true,
  } as unknown as RuntimeSessionView;
}

const VIEWS: Record<string, RuntimeSessionView> = {
  "conv-499-dead": deadStructuredView("conv-499-dead"),
};

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const realUseRuntime = actualRuntimeHooks.useRuntime;
const realUseRuntimeSession = actualRuntimeHooks.useRuntimeSession;
const realUseRuntimeReceiptsForArtifact = actualRuntimeHooks.useRuntimeReceiptsForArtifact;
let runtimePlaneAuthoritative = true;
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntime: () => {
    const real = realUseRuntime();
    return runtimePlaneAuthoritative ? { ...real, enabled: true } : real;
  },
  useRuntimeSession: (conversationId: string | null) => {
    const real = realUseRuntimeSession(conversationId);
    return (conversationId && VIEWS[conversationId]) || real;
  },
  useRuntimeReceiptsForArtifact: (path: string | null, conversationId?: string | null) => {
    const real = realUseRuntimeReceiptsForArtifact(path, conversationId);
    return conversationId && VIEWS[conversationId] ? [] : real;
  },
  refreshRuntime: () => Promise.resolve(true),
}));
afterAll(() => {
  runtimePlaneAuthoritative = false;
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

const { TmuxComposer } = await import("./TmuxComposer");

const realFetch = globalThis.fetch;

afterEach(() => {
  setLocale("en");
  mobile = false;
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});

function deadViewerFile(): FileEntry {
  return {
    path: "/codex-viewer-499.jsonl",
    root: "codex-sessions",
    name: "codex-viewer-499.jsonl",
    project: "viewer",
    title: "Viewer-launched conversation",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: "running",
    pid: null,
    conversationId: "conv-499-dead",
    spawnOrigin: "viewer",
    model: "gpt-5.6-sol",
    effort: "high",
    fast: false,
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
}

function quietWire(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/tmux/targets") return { ok: true, status: 200, json: async () => ({ targets: {} }) } as Response;
    throw new Error(`unexpected request: ${url}`);
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

test.each(["en", "uk"] as const)(
  "[%s] a dead structured host keeps Send admitting text durably and explains the image restriction inline, with no pill",
  async (locale) => {
    setLocale(locale);
    mobile = true;
    quietWire();
    const { host, root } = await renderInto(<TmuxComposer file={deadViewerFile()} deadHost />);

    /* Durable text admission: typing enables the live Send (the structured
       recovery admission), never an aria-disabled draft-only surface. */
    const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
    const props = (textarea as unknown as Record<string, { onChange: (e: unknown) => void }>)[propsKey]!;
    flushSync(() => props.onChange({ target: { value: "Recover and continue this task." } }));
    const send = host.querySelector(`button[aria-label="${translate(locale, "composer.sendToAgent")}"]`) as HTMLButtonElement;
    expect(send).toBeTruthy();
    expect(send.getAttribute("aria-disabled")).toBe("false");
    expect(send.disabled).toBe(false);

    /* The image restriction is explained inline in the current locale — a
       phone has no tooltip, so the disabled picker alone would be mute. */
    expect(host.textContent).toContain(translate(locale, "composer.imagesBlockedDuringRecovery"));

    /* Production capability visibility: the matrix hides the runtime control
       on the dead surface, so no model/reasoning pill may render. */
    expect(host.querySelector("[data-runtime-pill]")).toBeNull();

    flushSync(() => root.unmount());
  },
);
