import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import type { BoardTask } from "@/lib/tasks/types";
import type { Pipeline } from "@/lib/pipelines/types";

/*
 * PR #431 — the pipeline bottom sheet is a real modal dialog: focus moves into
 * it on open, Tab cycles inside it, Escape closes it, and focus returns to the
 * opener (the summary row) on close.
 */

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const inertRuntime = { enabled: false, connection: "offline" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inertRuntime, lastEventAt: null }),
  useRuntime: () => inertRuntime,
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));

const { MobilePipelineDockSheet } = await import("@/components/mobile/MobilePipelineDockSheet");

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  matchMedia: (q: string) => ({ matches: /max-width/.test(String(q)), media: String(q), onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }),
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  fetch: (async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" })) as unknown as typeof fetch,
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

let roots: Root[] = [];
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; });
afterEach(async () => { for (const r of roots) flushSync(() => r.unmount()); roots = []; await settle(); });

const pipeline = {
  id: "p1", task: "Ship the mobile dock", project: "demo", repoDir: "/r", worktreeDir: "/w",
  branch: "b", baseBranch: "main", baseRef: "a", lastPassedCommit: "a",
  stages: [
    { id: "plan", kind: "run", prompt: "", next: "build", effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-only", promptScaffold: null } },
    { id: "build", kind: "run", prompt: "", next: null, effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } },
  ],
  runs: [], cursor: null, state: "provisioning", pausedState: null, stateDetail: null,
  srcPath: null, srcConversationId: null, createdAt: new Date(0).toISOString(), closedAt: null,
} as unknown as Pipeline;

const renderProps = {
  flows: [],
  files: [],
  renderablePaths: new Set<string>(),
  renderableFlows: new Set<string>(),
  linkedTasksByPipeline: new Map<string, BoardTask[]>(),
  onOpenPath: () => {},
  onOpenFlow: () => {},
  onOpenTask: () => {},
};

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-testid="opener" onClick={() => setOpen(true)}>Open pipelines</button>
      {open ? <MobilePipelineDockSheet pipelines={[pipeline]} render={renderProps} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function mount(): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(<Harness />));
  roots.push(root);
  return host as unknown as HTMLElement;
}

function openSheet(host: HTMLElement): HTMLElement {
  const opener = host.querySelector('[data-testid="opener"]') as unknown as HTMLElement;
  opener.focus();
  flushSync(() => opener.click());
  return host.querySelector('[data-testid="mobile-pipeline-sheet"]') as unknown as HTMLElement;
}

const pressKey = (init: { key: string; shiftKey?: boolean }) => {
  flushSync(() => {
    dom.document.dispatchEvent(new dom.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }) as never);
  });
};

test("the sheet is a modal dialog that takes focus on open (PR #431)", () => {
  const host = mount();
  const sheet = openSheet(host);
  expect(sheet).not.toBeNull();
  expect(sheet.getAttribute("role")).toBe("dialog");
  expect(sheet.getAttribute("aria-modal")).toBe("true");
  /* Focus moved off the opener and into the dialog subtree. */
  const active = dom.document.activeElement as unknown as Node | null;
  expect(active && (sheet as unknown as Node) !== null && (sheet.contains(active as never) || active === (sheet as unknown as Node))).toBe(true);
});

test("Escape closes the sheet and focus returns to the opener (PR #431)", async () => {
  const host = mount();
  openSheet(host);
  pressKey({ key: "Escape" });
  await settle();
  expect(host.querySelector('[data-testid="mobile-pipeline-sheet"]')).toBeNull();
  const opener = host.querySelector('[data-testid="opener"]');
  expect(dom.document.activeElement).toBe(opener as never);
});

test("closing via the close button also restores focus to the opener (PR #431)", async () => {
  const host = mount();
  const sheet = openSheet(host);
  const close = sheet.querySelector('button[aria-label="Close pipelines"]') as unknown as HTMLElement;
  flushSync(() => close.click());
  await settle();
  expect(host.querySelector('[data-testid="mobile-pipeline-sheet"]')).toBeNull();
  expect(dom.document.activeElement).toBe(host.querySelector('[data-testid="opener"]') as never);
});

test("Tab is trapped inside the sheet in both directions (PR #431)", () => {
  const host = mount();
  const sheet = openSheet(host);
  const focusables = [...sheet.querySelectorAll("button")] as unknown as HTMLElement[];
  expect(focusables.length).toBeGreaterThan(0);
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;

  /* Tab from the last focusable wraps to the first — never out of the sheet. */
  last.focus();
  pressKey({ key: "Tab" });
  expect(dom.document.activeElement).toBe(first as never);

  /* Shift+Tab from the first wraps to the last. */
  first.focus();
  pressKey({ key: "Tab", shiftKey: true });
  expect(dom.document.activeElement).toBe(last as never);
});
