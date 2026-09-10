import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { FileEntry } from "@/lib/types";

/**
 * THE COMPOSER THE DOCK LOST (operator report, 2026-09-10).
 *
 * The seat's conversation was hosted and idle — the registry answered
 * `deliverable: true` for it — the dock rendered its feed and its control
 * strip, and there was no input anywhere on the page. A live badge over a
 * conversation with nothing to type into says «it is working» and offers no way
 * to find out; the operator read it as a fabricated live status.
 *
 * WHY IT SHIPPED INVISIBLY, and why this file exists beside
 * `OrchestratorPanel.dom.test.tsx` rather than inside it: that suite mounts the
 * PANEL, and a tree with no `VoiceComposerHost` in it keeps the inline
 * card-scoped composer by design (`TmuxComposer`'s dispatcher). So the assertion
 * there — "an active seat mounts the REAL conversation column, feed and
 * composer" — passes on a code path production never takes. Production mounts
 * the Viewer, the Viewer mounts the host, and the dock's composer is HOISTED:
 * the dock publishes a place, and the host renders the one composer into it.
 *
 * This file mounts the real `Viewer`, so the hoisted path is the one under test.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  location: dom.location,
  history: dom.history,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Element: dom.Element,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  MutationObserver: dom.MutationObserver,
  ResizeObserver: dom.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: undefined,
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});

const matchMedia = (query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
});
Object.assign(globalThis, { matchMedia });
Object.assign(dom, { matchMedia });

(dom.HTMLElement.prototype as unknown as { animate: () => unknown }).animate = () => ({
  finished: Promise.resolve(),
  cancel() {},
  finish() {},
  addEventListener() {},
  removeEventListener() {},
});

mock.module("@/hooks/runtimeBus", () => ({
  SNAPSHOT_URL: "/api/runtime/snapshot",
  STREAM_URL: "/api/runtime/stream",
  STREAM_RECONNECTED_EVENT: "llv:stream-reconnected",
  isRuntimeUiEnabled: () => false,
  getRuntimeBus: () => ({
    getState: () => ({ connection: "offline" }),
    subscribe: () => () => {},
    subscribeFilesRevision: () => () => {},
  }),
}));

const { Viewer } = await import("../Viewer");
const { resetFilesClientCacheForTests } = await import("@/hooks/useFiles");
const { OPEN_KEY } = await import("./OrchestratorDock");

const PROJECT = "atlas";
const SEAT_CONVERSATION = "conversation_orch";
const originalFetch = globalThis.fetch;

/** The seat's conversation as the catalog carries it: a hosted Claude session,
    quiet at this instant, which is what an idle host looks like from here. */
const seatFile: FileEntry = {
  path: "/transcripts/orch.jsonl",
  root: "claude-projects",
  name: "orch.jsonl",
  project: PROJECT,
  title: "Orchestrator",
  engine: "claude",
  kind: "session",
  fmt: "claude",
  parent: null,
  mtime: 1_760_000_000,
  size: 12,
  activity: "live",
  proc: "running",
  pid: 4_242,
  conversationId: SEAT_CONVERSATION,
  model: "opus",
  pendingQuestion: null,
  waitingInput: null,
} as FileEntry;

const activeSeat = () => ({
  project: PROJECT,
  seatEpoch: 3,
  conversationId: SEAT_CONVERSATION,
  path: seatFile.path,
  mandate: "own the board",
  promptVersion: null,
  predecessorConversationId: null,
  state: "active" as const,
  intent: { clientRequestId: "req-aaaaaaaa", mode: "spawn" as const, launchId: null, error: null },
  designatedAt: "2026-09-10T00:00:00.000Z",
  activatedAt: "2026-09-10T00:00:01.000Z",
});

/** The designation that was refused, exactly as the seat route reports it: a
    pending intent carrying its terminal error, over a still-seated incumbent. */
const refusedPending = () => ({
  project: PROJECT,
  seatEpoch: 4,
  conversationId: null,
  path: null,
  mandate: "own the board",
  promptVersion: null,
  predecessorConversationId: null,
  state: "pending" as const,
  intent: {
    clientRequestId: "req-bbbbbbbb",
    mode: "spawn" as const,
    launchId: null,
    error: "codex account spare-carrier is not allowed on project atlas (allowed codex accounts: reserved-carrier)",
  },
  designatedAt: "2026-09-10T00:10:00.000Z",
  activatedAt: null,
});

let pending: ReturnType<typeof refusedPending> | null = null;

function stubFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("/api/files")) {
      return new Response(JSON.stringify({
        files: [seatFile],
        projectCatalog: [{ project: PROJECT, conversations: 1 }],
      }));
    }
    if (url.startsWith("/api/orchestrator/seat/status")) {
      return new Response(JSON.stringify({
        project: PROJECT,
        designated: true,
        conversationId: SEAT_CONVERSATION,
        engine: "claude",
        model: "opus",
        accountId: "spare-carrier",
        transcriptPath: seatFile.path,
        /* The registry's own answer for this seat in the incident: a host that
           is running and a turn that is not. */
        liveness: { lifecycle: "waiting", hostState: "alive", silentForMs: 211_916 },
        rotation: { recommended: false, level: "none", reasons: [], thresholdUnknown: true },
      }));
    }
    if (url.startsWith("/api/orchestrator/seat")) {
      return new Response(JSON.stringify({ seat: activeSeat(), pending, exists: true }));
    }
    /* Everything else answers 404, exactly as the dock's own shell test does:
       an unstubbed reader must not be handed a body it will misparse. */
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

let mounted: { unmount: () => void } | null = null;

beforeEach(() => {
  resetFilesClientCacheForTests();
  dom.localStorage.clear();
  dom.sessionStorage.clear();
  dom.location.hash = "";
  dom.document.body.replaceChildren();
  pending = null;
  stubFetch();
});

afterEach(() => {
  if (mounted) {
    const root = mounted;
    mounted = null;
    act(() => root.unmount());
  }
  globalThis.fetch = originalFetch;
  dom.document.body.replaceChildren();
});

async function mountViewerOnProject(): Promise<HTMLElement> {
  dom.localStorage.setItem("llvProject", PROJECT);
  dom.localStorage.setItem(`${OPEN_KEY}:${PROJECT}`, "1");
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  mounted = root;
  await act(async () => { root.render(<Viewer />); });
  await act(async () => {
    dom.location.hash = `#p=${encodeURIComponent(PROJECT)}`;
    dom.dispatchEvent(new dom.Event("hashchange"));
  });
  for (let round = 0; round < 6; round += 1) {
    await act(async () => { await Bun.sleep(40); });
  }
  return host as unknown as HTMLElement;
}

/** The composer, wherever the hoist put it — the dock's place, or the parked
    container the host uses when it has nowhere to portal into. The operator can
    only type into the first; both are asserted so a composer that exists but is
    unreachable is never mistaken for one that is missing entirely. */
function composerIn(host: HTMLElement): { inDock: boolean; parked: boolean; places: number } {
  const dock = host.querySelector("[data-orchestrator-conversation]");
  return {
    inDock: Boolean(dock?.querySelector("textarea")),
    parked: host.querySelectorAll("[data-testid=voice-composer-parked]").length > 0,
    places: host.querySelectorAll("[data-testid=voice-composer-card-slot]").length,
  };
}

test("REGRESSION: a seated, hosted orchestrator has a composer in the dock under the Viewer-level hoist", async () => {
  const host = await mountViewerOnProject();

  /* The dock bound the seat's conversation and published its composer place. */
  expect(host.querySelector(`[data-orchestrator-conversation="${SEAT_CONVERSATION}"]`)).not.toBeNull();
  expect(composerIn(host).places).toBe(1);
  /* And the one hoisted composer renders into it. A place with no composer in
     it is the incident: feed, control strip, live badge, nothing to type. */
  expect(composerIn(host)).toMatchObject({ inDock: true, parked: false });
});

test("REGRESSION: a REFUSED designation over a live incumbent keeps both the reason and the composer", async () => {
  /* The panel's whole promise for this state: the incumbent stays, the failure
     is readable, and the way forward is still a message to the agent that is
     still running. Losing the composer here turns a recoverable seat into a
     status display. */
  pending = refusedPending();
  const host = await mountViewerOnProject();

  const banner = host.querySelector("[data-orchestrator-intent-error]");
  expect(banner?.textContent).toContain("is not allowed on project atlas");
  expect(composerIn(host)).toMatchObject({ inDock: true, parked: false });
});

