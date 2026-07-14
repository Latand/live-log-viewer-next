import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { Flow, Round } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import { emptyStore } from "@/components/runtime/runtimeModel";

import type { DeckRound } from "./RoundDeck";

/*
 * Finding 6 (issue #241): the REAL review-deck wrapper (`RoundDeck` →
 * `BranchPane`) must mount the control strip on its front card, classify a
 * scanner-shaped subagent as `live-subagent`, and drop the composer on a
 * finished/headless round while keeping the strip. A regression fails here
 * independently of the board and mobile wrappers.
 */

const dom = new HappyWindow();
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
function bindDomGlobals() {
  Object.assign(globalThis, {
    window: dom, document: dom.document, navigator: dom.navigator,
    Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
    Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent,
    sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
    ResizeObserver: TestResizeObserver, IntersectionObserver: undefined,
  });
}
bindDomGlobals();

function structuredRoot(): RuntimeSessionView {
  return { session: { hostKind: "claude-broker", host: "hosted", artifactPath: "/root.jsonl" } as RuntimeSessionView["session"], uiState: {} as RuntimeSessionView["uiState"], attentions: [], receipts: [], legacy: false };
}
const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualLogTail = await import("@/hooks/useLogTail");
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ enabled: true, connection: "live", resyncedAt: null, lastEventAt: null, store: emptyStore() }),
  useRuntime: () => ({ enabled: true, connection: "live", resyncedAt: null, store: emptyStore() }),
  useRuntimeSession: () => null,
  useRuntimeSessionByArtifact: (path: string | null) => (path === "/root.jsonl" ? structuredRoot() : null),
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
mock.module("@/hooks/useLogTail", () => ({
  useLogTail: () => ({
    lines: [], linesStart: 0, size: 0, loading: false, error: null, tickTime: null,
    paused: false, setPaused: () => undefined, clear: () => undefined,
    hasMore: false, loadingOlder: false, loadOlder: async () => 0, prependGen: 0,
  }),
}));

const { RoundDeck } = await import("./RoundDeck");

const roots = new Set<Root>();
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  dom.sessionStorage.clear();
});

/* Scanner-shaped Claude subagent reviewer transcript: proc/pid null. */
const subagent: FileEntry = {
  path: "/child.jsonl", root: "claude-projects", name: "child.jsonl", project: "project", title: "reviewer",
  engine: "claude", kind: "subagent", fmt: "claude", parent: "/root.jsonl", mtime: 1, size: 1, activity: "live",
  proc: null, pid: null, conversationId: "conv-child", model: "sonnet", pendingQuestion: null, waitingInput: null,
};

function round(over: Partial<Round> = {}): Round {
  return {
    n: 1, reviewerPath: "/child.jsonl", findingsPath: null, triggeredBy: "marker", readyNote: null,
    verdict: null, findingsCount: null, startedAt: "2026-07-12T00:00:00Z", reviewedAt: null, relayedAt: null, error: null,
    ...over,
  } as Round;
}

function flow(reviewerMode: Flow["reviewerMode"]): Flow {
  return {
    id: "flow-1", template: "implement-review-loop", project: "project", cwd: "/project", implementerPath: "/impl.jsonl",
    roles: { implementer: { engine: "claude", model: null, effort: null }, reviewer: { engine: "claude", model: null, effort: null } },
    baseRef: "base", baseMode: "head", mode: "auto", reviewerMode, roundLimit: 5, state: "reviewing", stateDetail: null,
    rounds: [], createdAt: "2026-07-12T00:00:00Z", closedAt: null,
  } as Flow;
}

function render(rounds: DeckRound[], reviewerMode: Flow["reviewerMode"] = "pane"): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const rootInstance = createRoot(host as unknown as HTMLElement);
  roots.add(rootInstance);
  flushSync(() => rootInstance.render(<RoundDeck flow={flow(reviewerMode)} rounds={rounds} focusRound={null} dormant />));
  return host as unknown as HTMLElement;
}

const surface = (host: HTMLElement) => host.querySelector("[data-agent-control-strip]")?.getAttribute("data-strip-surface") ?? null;
const hasComposer = (host: HTMLElement) => host.querySelector("textarea") !== null;

test("an in-progress round mounts the strip (live-subagent) above a composer", () => {
  const host = render([{ key: "r1", round: round(), file: subagent }]);
  expect(surface(host)).toBe("live-subagent");
  expect(hasComposer(host)).toBe(true);
});

test("a finished round keeps the strip but drops the composer", () => {
  const host = render([{ key: "r1", round: round({ verdict: "APPROVE", reviewedAt: "2026-07-12T01:00:00Z" }), file: subagent }]);
  expect(surface(host)).toBe("live-subagent");
  expect(hasComposer(host)).toBe(false);
});

test("a headless flow drops the composer even for an in-progress round", () => {
  const host = render([{ key: "r1", round: round(), file: subagent }], "headless");
  expect(surface(host)).toBe("live-subagent");
  expect(hasComposer(host)).toBe(false);
});
