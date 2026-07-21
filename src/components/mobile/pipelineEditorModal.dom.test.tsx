import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import type { BoardTask } from "@/lib/tasks/types";
import type { Pipeline } from "@/lib/pipelines/types";

/*
 * #507 final review F2 — the on-canvas stage editor opens ABOVE the mobile
 * pipeline dock sheet, and the two must not fight over keyboard ownership. With
 * the editor open: Tab and Shift+Tab stay inside the editor (the sheet's own
 * trap yields), Escape closes ONLY the editor and returns focus to its trigger,
 * and a second Escape then closes the sheet back to its opener.
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
  fetch: (async () => ({ ok: true, status: 200, json: async () => ({ roles: [] }), text: async () => "" })) as unknown as typeof fetch,
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

/* A draft with a configurable stage so the strip renders a "Configure stage"
   chip that opens the on-canvas editor above the sheet. */
const pipeline = {
  id: "p1", task: "Compose on canvas", project: "demo", repoDir: "/r", worktreeDir: "/w",
  branch: "b", baseBranch: "main", baseRef: "a", lastPassedCommit: "a",
  stages: [
    { id: "plan", kind: "run", role: { roleId: "builder" }, prompt: "{{task}}", next: null, effectiveRole: { roleId: "builder", engine: "codex", model: "gpt-5.6", effort: "high", access: "read-write", promptScaffold: null } },
  ],
  runs: [], cursor: { stageId: "plan", state: "pending", input: null, activatedBy: null }, state: "draft", pausedState: null, stateDetail: null,
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

const pressKey = (init: { key: string; shiftKey?: boolean }) => {
  flushSync(() => {
    dom.document.dispatchEvent(new dom.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }) as never);
  });
};

async function openEditor(host: HTMLElement): Promise<{ sheet: HTMLElement; editor: HTMLElement; trigger: HTMLElement }> {
  const opener = host.querySelector('[data-testid="opener"]') as unknown as HTMLElement;
  opener.focus();
  flushSync(() => opener.click());
  const sheet = host.querySelector('[data-testid="mobile-pipeline-sheet"]') as unknown as HTMLElement;
  /* Expand the dock rail so its PipelineStrip (and the configure chip) renders. */
  const dockSummary = sheet.querySelector('[data-testid="mobile-pipeline-dock-summary"]') as unknown as HTMLElement;
  flushSync(() => dockSummary.click());
  await settle();
  const trigger = sheet.querySelector('button[aria-label^="Configure stage"]') as unknown as HTMLElement;
  trigger.focus();
  flushSync(() => (trigger as unknown as { click: () => void }).click());
  await settle();
  const body = dom.document.body as unknown as HTMLElement;
  const editor = body.querySelector('[role="dialog"][aria-modal="true"][aria-label^="Configuration for stage"]') as unknown as HTMLElement;
  return { sheet, editor, trigger };
}

test("the stage editor opens as a modal above the sheet and takes focus (#507 final F2)", async () => {
  const host = mount();
  const { editor } = await openEditor(host);
  expect(editor).toBeTruthy();
  const active = dom.document.activeElement as unknown as Node | null;
  expect(active && (editor as unknown as { contains: (n: Node) => boolean }).contains(active as never)).toBe(true);
});

test("Tab and Shift+Tab stay inside the stage editor, not the sheet beneath (#507 final F2)", async () => {
  const host = mount();
  const { editor } = await openEditor(host);
  const focusables = [...editor.querySelectorAll("button, input, select, textarea, [tabindex]:not([tabindex=\"-1\"])")]
    .filter((el) => !(el as HTMLElement).hasAttribute("disabled")) as unknown as HTMLElement[];
  expect(focusables.length).toBeGreaterThan(1);
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;

  /* Tab from the last focusable wraps to the first — and never leaves the editor. */
  last.focus();
  pressKey({ key: "Tab" });
  const afterTab = dom.document.activeElement as unknown as Node;
  expect((editor as unknown as { contains: (n: Node) => boolean }).contains(afterTab)).toBe(true);
  expect(dom.document.activeElement).toBe(first as never);

  /* Shift+Tab from the first wraps to the last, still inside the editor. */
  first.focus();
  pressKey({ key: "Tab", shiftKey: true });
  const afterShift = dom.document.activeElement as unknown as Node;
  expect((editor as unknown as { contains: (n: Node) => boolean }).contains(afterShift)).toBe(true);
  expect(dom.document.activeElement).toBe(last as never);
});

test("Escape closes only the editor and returns focus to its trigger; the sheet stays open (#507 final F2)", async () => {
  const host = mount();
  const { trigger } = await openEditor(host);

  pressKey({ key: "Escape" });
  await settle();

  const body = dom.document.body as unknown as HTMLElement;
  /* The editor is gone but the sheet remains — Escape did not close the wrong surface. */
  expect(body.querySelector('[aria-label^="Configuration for stage"]')).toBeNull();
  expect(host.querySelector('[data-testid="mobile-pipeline-sheet"]')).not.toBeNull();
  /* Focus returned to the configure chip that opened the editor. */
  expect(dom.document.activeElement).toBe(trigger as never);

  /* A second Escape now closes the sheet back to its opener. */
  pressKey({ key: "Escape" });
  await settle();
  expect(host.querySelector('[data-testid="mobile-pipeline-sheet"]')).toBeNull();
  expect(dom.document.activeElement).toBe(host.querySelector('[data-testid="opener"]') as never);
});
