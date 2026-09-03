import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import { emptyStore } from "@/components/runtime/runtimeModel";

/*
 * Finding 6 (issue #241) after mobile v2 lane 3: the REAL mobile focus wrapper
 * (`MobileFocusView` → `MobileShell` → `BranchPane`) must reach every runtime
 * control of the focused conversation — including a scanner-shaped subagent,
 * whose capabilities come from its structured ROOT — and each one must be a
 * LABELLED 44 px row, because an icon-only control has no touch route to its
 * meaning (2026-08 audit finding 18).
 *
 * So the strip itself does not render on the phone at all: it is the
 * conversation's `⋯` menu that carries Stop, Compact, Re-check, Open in
 * terminal, Details & host and Kill, off the same hooks the desktop strip
 * reads. Regressions in the phone layout fail here independently.
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
// The phone layout: force useIsMobile true.
(dom as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (query: string) => ({
  matches: true, media: query, addEventListener() {}, removeEventListener() {},
});

function structuredRoot(): RuntimeSessionView {
  return { session: { hostKind: "claude-broker", host: "hosted", artifactPath: "/root.jsonl" } as RuntimeSessionView["session"], uiState: {} as RuntimeSessionView["uiState"], attentions: [], receipts: [], legacy: false, structuredControlsEnabled: true };
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

const { MobileFocusView } = await import("./MobileFocusView");

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

/* Scanner-shaped Claude subagent focused on the phone. */
const subagent: FileEntry = {
  path: "/child.jsonl", root: "claude-projects", name: "child.jsonl", project: "project", title: "child",
  engine: "claude", kind: "subagent", fmt: "claude", parent: "/root.jsonl", mtime: 2, size: 1, activity: "live",
  proc: null, pid: null, conversationId: "conv-child", model: "sonnet", pendingQuestion: null, waitingInput: null,
};

test("the phone renders no inline control strip: every control is a labelled 44 px row in the conversation menu", () => {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const rootInstance = createRoot(host as unknown as HTMLElement);
  roots.add(rootInstance);
  flushSync(() => rootInstance.render(
    <MobileFocusView
      project="project"
      groups={[]}
      manual={[subagent]}
      files={[subagent]}
      flows={[]}
      pipelines={[]}
      tasks={[]}
      drafts={[]}
      loaded
      focus="/child.jsonl"
      onSelect={() => undefined}
      onClose={() => undefined}
      onDraftClose={() => undefined}
      onDraftSpawned={() => undefined}
    />,
  ));
  const root = host as unknown as HTMLElement;

  /* Nothing on the screen: no strip, and no details disclosure that used to
     hide it — the whole two-row pane header is gone on the phone. */
  expect(root.querySelector("[data-agent-control-strip]")).toBeNull();
  expect(root.querySelector('[data-testid="mobile-details-toggle"]')).toBeNull();
  expect(root.querySelector('[data-testid="mobile-focused-pane"] header')).toBeNull();

  /* One overflow, and the controls are inside it. */
  const more = root.querySelector('[data-mobile2-open="menu"]') as HTMLButtonElement;
  expect(more).not.toBeNull();
  flushSync(() => more.click());
  const sheet = root.querySelector('[data-mobile2-sheet="menu"]') as HTMLElement;
  expect(sheet).not.toBeNull();

  const rows = [...sheet.querySelectorAll("[data-mobile2-menu-row]")] as unknown as HTMLElement[];
  const named = rows.map((row) => row.getAttribute("data-mobile2-menu-row"));
  /* The structured root answers for its subagent, so the runtime controls are
     the ones the capability matrix admits — not an empty menu. */
  expect(named).toContain("stop");
  expect(named).toContain("host");
  expect(named).toContain("kill");
  expect(named).toContain("rename");

  for (const row of rows) {
    /* 44 px, labelled, and the label is words rather than an icon alone. */
    expect(row.className).toContain("min-h-11");
    expect((row.textContent ?? "").trim().length).toBeGreaterThan(0);
  }

  /* Kill is last and destructive, and it asks nothing before acting (Q4). */
  expect(named[named.length - 1]).toBe("kill");
  const kill = sheet.querySelector('[data-testid="mobile-menu-kill"]') as HTMLElement;
  expect(kill.className).toContain("text-danger");
});
