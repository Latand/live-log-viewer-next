import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import type { BranchGroup } from "@/components/projectModel";
import type { FileEntry } from "@/lib/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { MobileScreen } from "@/components/mobile/mobileNav";

/*
 * Issue #419 — chat-first viewport, as mobile v2 lanes 3 and 10 leave it. The
 * conversation screen owns no chrome of its own: no strip, no pane header, no
 * inline pipeline rail, no dock sheet. The pipelines are ONE row in the
 * conversation's `⋯` menu (README §4.2, P2-9), and the row PUSHES a screen:
 * the stage conversation's own pipeline, else the pipelines list. Opening and
 * closing a sheet never remounts the focused pane — a sheet is over the
 * screen, never instead of it (§3.3).
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

const { MobileFocusView } = await import("@/components/mobile/MobileFocusView");
const { getMobileNav, topScreen } = await import("@/components/mobile/mobileNav");

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  matchMedia: (q: string) => ({ matches: /max-width/.test(String(q)), media: String(q), onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }),
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  fetch: (async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" })) as unknown as typeof fetch,
};
(dom as unknown as { matchMedia: unknown }).matchMedia = OVERRIDES.matchMedia;
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
  (dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

let roots: Root[] = [];
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; getMobileNav().home(); });
afterEach(async () => { for (const r of roots) flushSync(() => r.unmount()); roots = []; await settle(); dom.sessionStorage.clear(); });

function mount(node: React.ReactElement): Root {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(node));
  return root;
}

function pipe(id: string, state: string): Pipeline {
  return {
    id, task: `Task ${id}`, project: "demo", repoDir: "/r", worktreeDir: "/w",
    branch: "b", baseBranch: "main", baseRef: "a", lastPassedCommit: "a",
    stages: [
      { id: "plan", kind: "run", prompt: "", next: "build", effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-only", promptScaffold: null } },
      { id: "build", kind: "run", prompt: "", next: null, effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } },
    ],
    runs: [], cursor: null, state, pausedState: null, stateDetail: null,
    srcPath: null, srcConversationId: null, createdAt: new Date(0).toISOString(), closedAt: null,
  } as unknown as Pipeline;
}

const pipelines = [pipe("p-run", "running"), pipe("p-done1", "completed"), pipe("p-done2", "completed")];

function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects", name: overrides.path, project: "demo", title: overrides.path,
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1_000, size: 10,
    activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null,
    ...overrides,
  };
}

function view({ surface = pipelines, empty = false }: { surface?: Pipeline[]; empty?: boolean } = {}) {
  const conversation = entry({ path: "/session", title: "Main session", activity: "live", mtime: 9_000 });
  const group: BranchGroup = { key: conversation.path, columns: [{ file: conversation, tasks: [] }], returnable: [], finished: [], smt: conversation.mtime, orphanTask: false };
  return (
    <MobileFocusView
      project="demo" groups={empty ? [] : [group]} manual={[]} files={empty ? [] : [conversation]} flows={[]}
      pipelines={surface} surfacePipelines={surface} tasks={[]} drafts={[]}
      loaded focus={null} onSelect={() => {}} onClose={() => {}} onDraftClose={() => {}} onDraftSpawned={() => {}}
    />
  );
}

/** Open the conversation's `⋯` and return the sheet it put on screen. */
function openMenu(): HTMLElement {
  const more = dom.document.querySelector('[data-mobile2-open="menu"]') as unknown as HTMLButtonElement;
  expect(more).not.toBeNull();
  flushSync(() => more.click());
  return dom.document.querySelector('[data-mobile2-sheet="menu"]') as unknown as HTMLElement;
}

/** Tap the menu's pipeline row. The row PUSHES a screen (P2-9), so what comes
    back is the navigation stack's top. */
async function tapPipelineRow(): Promise<MobileScreen> {
  const row = openMenu().querySelector('[data-testid="mobile-menu-pipeline"]') as unknown as HTMLButtonElement;
  expect(row).not.toBeNull();
  flushSync(() => row.click());
  await settle();
  return topScreen(getMobileNav().getState());
}

test("a focused conversation reserves ZERO rows for the pipelines: they are the menu's first row (#419, README \u00a74.2)", async () => {
  roots.push(mount(view()));
  await settle();

  const shell = dom.document.querySelector('[data-testid="mobile-chat-shell"]')!;
  /* Nothing about a pipeline is on the screen itself — no rail, no summary
     trigger in a strip, no bottom shelf. The strip that used to carry the
     trigger is gone with the rest of the conversation screen's chrome. */
  expect(shell.querySelector('[data-testid="mobile-pipeline-dock"]')).toBeNull();
  expect(shell.querySelector('[data-testid="mobile-pipeline-summary"]')).toBeNull();
  expect(shell.querySelector('[data-testid="mobile-bottom-shelf"]')).toBeNull();

  /* The reach is one labelled row, first in the menu, ahead of every identity
     action — and it is a 44 px row like every other (\u00a72 rule 7). */
  const sheet = openMenu();
  const row = sheet.querySelector('[data-testid="mobile-menu-pipeline"]') as unknown as HTMLElement;
  expect(row).not.toBeNull();
  expect(row.className).toContain("min-h-11");
  expect(row.textContent).toContain("3 pipelines");
  const rows = [...sheet.querySelectorAll("[data-mobile2-menu-row]")].map((node) => node.getAttribute("data-mobile2-menu-row"));
  expect(rows[0]).toBe("pipeline");
});

test("the menu's pipeline row pushes the pipelines list; nothing of the retired dock sheet mounts (P2-9, lane 10)", async () => {
  roots.push(mount(view()));
  await settle();
  expect(await tapPipelineRow()).toEqual({ kind: "pipelines" });
  expect(dom.document.querySelector('[data-testid="mobile-pipeline-sheet"]')).toBeNull();
  expect(dom.document.querySelector('[data-testid="mobile-pipeline-dock"]')).toBeNull();
  expect(dom.document.querySelector('[data-mobile2-sheet]')).toBeNull();
});

test("on a stage conversation the row names its stage and pushes that pipeline (P2-9, §4.2)", async () => {
  /* The focused conversation ran the running pipeline's first stage. */
  const staged = {
    ...pipe("p-run", "running"),
    runs: [{ stageId: "plan", attempts: [{ n: 1, state: "running", agentPath: "/session", flowId: null }] }],
    cursor: { stageId: "plan", state: "running", input: null, activatedBy: null },
  } as unknown as Pipeline;
  roots.push(mount(view({ surface: [staged, pipe("p-done1", "completed")] })));
  await settle();
  const row = openMenu().querySelector('[data-testid="mobile-menu-pipeline"]') as unknown as HTMLButtonElement;
  expect(row.textContent).toContain("Task p-run");
  expect(row.textContent).toContain("stage 1/2");
  flushSync(() => row.click());
  await settle();
  expect(topScreen(getMobileNav().getState())).toEqual({ kind: "pipeline", id: "p-run" });
});

test("the conversation screen mounts no pane header at 390px: the bar's title cell is the identity (\u00a73.4)", async () => {
  roots.push(mount(view()));
  await settle();

  /* Five to six 44 px controls on one 390 px line left the title one to four
     characters (2026-08 audit finding 4). The header does not exist here now;
     the bar carries the title on one line and the meta line under it. */
  expect(dom.document.querySelector('[data-testid="mobile-focused-pane"] header')).toBeNull();
  const title = dom.document.querySelector("[data-mobile2-chat-title]") as HTMLElement | null;
  expect(title).not.toBeNull();
  expect(title!.querySelector("[data-mobile2-title-text]")?.textContent).toContain("Main session");
  expect(title!.querySelector("[data-mobile2-chat-state]")).not.toBeNull();
});

test("with nothing to show the leaf says so and mounts no dock: a provisioning pipeline is the board's row and screen, not this leaf's surface (lane 10)", async () => {
  roots.push(mount(view({ surface: [pipe("p-new", "provisioning")], empty: true })));
  await settle();
  const shell = dom.document.querySelector('[data-testid="mobile-chat-shell"]')!;
  expect(shell.textContent).toContain("No conversations yet");
  expect(dom.document.querySelector('[data-testid="mobile-pipeline-dock"]')).toBeNull();
  expect(dom.document.querySelector('[aria-label="Pipeline stages"]')).toBeNull();
});

test("the focus shell stamps the chat-first transcript budget onto the DOM it governs (#419)", async () => {
  roots.push(mount(view()));
  await settle();

  const shell = dom.document.querySelector('[data-testid="mobile-chat-shell"]')!;
  /* The transcript's guaranteed viewport share travels with the shell root, and
     the root keeps the #353 horizontal-overflow clip. */
  expect(Number(shell.getAttribute("data-chat-min-share"))).toBeGreaterThanOrEqual(0.6);
  expect(shell.className).toContain("overflow-x-clip");
  expect(shell.className).toContain("max-w-[100dvw]");
});

test("the focused chat is one 100dvh-bounded shell whose pane owns the remaining height (#440)", async () => {
  roots.push(mount(view()));
  await settle();

  const shell = dom.document.querySelector('[data-testid="mobile-chat-shell"]') as HTMLElement | null;
  expect(shell).not.toBeNull();
  expect(shell!.className).toContain("h-full");
  expect(shell!.className).toContain("max-h-[100dvh]");
  expect(shell!.className).toContain("overflow-hidden");

  const pane = shell!.querySelector('[data-testid="mobile-focused-pane"]') as HTMLElement | null;
  expect(pane).not.toBeNull();
  expect(pane!.className).toContain("min-h-0");
  expect(pane!.className).toContain("flex-1");

  const transcript = pane!.querySelector(".overflow-y-auto") as HTMLElement | null;
  expect(transcript).not.toBeNull();
  expect(transcript!.className).toContain("min-h-0");
  expect(transcript!.className).toContain("flex-1");
});

test("opening and closing a sheet never remounts the focused pane (\u00a73.3)", async () => {
  roots.push(mount(view()));
  await settle();

  const paneBefore = dom.document.querySelector("textarea");
  expect(paneBefore).not.toBeNull();

  openMenu();
  await settle();
  expect(dom.document.querySelector('[data-mobile2-sheet="menu"]')).not.toBeNull();

  const close = dom.document.querySelector("[data-mobile2-close]") as unknown as HTMLButtonElement;
  flushSync(() => close.click());
  await settle();
  expect(dom.document.querySelector('[data-mobile2-sheet="menu"]')).toBeNull();

  const paneAfter = dom.document.querySelector("textarea");
  /* Same node instance \u2014 the screen stayed mounted under the sheet. */
  expect(paneAfter).toBe(paneBefore);
});
