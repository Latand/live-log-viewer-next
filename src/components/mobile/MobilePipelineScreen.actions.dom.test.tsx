import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore, type ConnectionState } from "@/components/runtime/runtimeModel";
import { translate } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

/*
 * The phone's pipeline actions (mobile v2 lane 7, #1439; README §4.7, §2 rule
 * 9). The acceptance this file exists for is the one that is easy to fake:
 * retry, skip, pause, resume and archive must reach the SAME actions the
 * desktop reaches — no phone-only subset — act on the tap that names them with
 * no confirmation prompt, and Skip and Archive must carry their inverse in the
 * receipt.
 *
 * So each test drives BOTH surfaces over one recording fetch and compares the
 * requests: the phone's screen and the desktop's `PipelineStrip`, for the same
 * pipeline in the same state. A phone control that invented its own action, or
 * skipped one the desktop has, cannot pass.
 *
 * The two the engine cannot take back — `skip-stage` advances the cursor, and
 * a closed lane has no re-open — are held for the receipt's own window, so the
 * inverse is a real cancellation rather than a button that always answers 409.
 * The window closing sends exactly what the desktop sent.
 */

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const runtime = {
  enabled: false,
  connection: "live" as ConnectionState,
  lastEventAt: null as number | null,
  resyncedAt: null,
  store: emptyStore(),
  structuredHostsEnabled: false,
};
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => runtime,
  useRuntime: () => runtime,
  useRuntimeSelector: (selector: (state: typeof runtime) => unknown) => selector(runtime),
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));

const { MobilePipelineScreen, createPendingPipelineActs } = await import("./MobilePipelineScreen");
const { PipelineStrip } = await import("@/components/pipelines/PipelineStrip");
const { createMobileNav, MobileNavContext } = await import("./mobileNav");
const { receipts } = await import("./MobileReceipt");

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
const G = globalThis as Record<string, unknown>;

/** Every PATCH either surface issues, in order. */
interface Patch { url: string; method: string; body: unknown }
let patches: Patch[] = [];
const recordingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (init?.method === "PATCH") {
    patches.push({ url, method: "PATCH", body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ roles: [] }), { status: 200, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

const OVERRIDES: Record<string, unknown> = {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement, Event: dom.Event, KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  fetch: recordingFetch,
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
beforeAll(() => { for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; } });
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 0));
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

let roots: Root[] = [];
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; patches = []; receipts.dismiss(); });
afterEach(() => { for (const root of roots) flushSync(() => root.unmount()); roots = []; receipts.dismiss(); });

const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

function nav() {
  const entries: { state: unknown; url: string }[] = [{ state: null, url: "http://localhost/#p=atlas" }];
  let index = 0;
  return createMobileNav({
    history: {
      get state() { return entries[index]!.state; },
      pushState(state, _unused, url) { entries.splice(index + 1); entries.push({ state, url: url ?? entries[index]!.url }); index += 1; },
      replaceState(state, _unused, url) { entries[index] = { state, url: url ?? entries[index]!.url }; },
      back() { if (index > 0) index -= 1; },
    },
    href: () => entries[index]!.url,
    onPopstate: () => () => {},
  });
}

function mount(node: React.ReactNode): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(<MobileNavContext.Provider value={nav()}>{node}</MobileNavContext.Provider>));
  roots.push(root);
  return host as unknown as HTMLElement;
}

const q = (host: HTMLElement, selector: string) => host.querySelector(selector) as unknown as HTMLElement | null;
const body = () => dom.document.body as unknown as HTMLElement;
const click = (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  flushSync(() => el.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
};

const NOW = 1_800_000_000;
const at = (secondsAgo: number) => new Date((NOW - secondsAgo) * 1_000).toISOString();

const REVIEW_FILE = file("/repo/review.jsonl");
function file(path: string): FileEntry {
  return {
    root: "claude-projects", name: path.split("/").pop(), path, project: "atlas", title: "Review round 3", engine: "claude",
    kind: "session", fmt: "claude", parent: null, mtime: NOW - 60, size: 2_048, activity: "idle", proc: null, pid: null,
    model: "opus", pendingQuestion: null, waitingInput: null, conversationId: null,
  } as unknown as FileEntry;
}

const ROLE = (roleId: string) => ({ roleId, engine: "claude", model: "opus", effort: "high", access: roleId === "reviewer" ? "read-only" : "read-write", promptScaffold: null });

function pipeline(state: Pipeline["state"]): Pipeline {
  return {
    id: "p2", task: "Fast conversation switching", taskIds: [], project: "atlas", repoDir: "/repo", worktreeDir: "/repo-w",
    branch: "lane/p2", baseBranch: "main", baseRef: "", lastPassedCommit: "",
    stages: [
      { id: "implement", kind: "run", role: { roleId: "builder" }, prompt: "p", next: "review", access: "read-write", effectiveRole: ROLE("builder") },
      { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "p", next: null, onFail: { to: "implement", maxRounds: 3 }, access: "read-only", effectiveRole: ROLE("reviewer") },
    ],
    runs: [{
      stageId: "review",
      attempts: [{
        n: 3, state: "failed", effectiveRole: ROLE("reviewer"), launchId: null, conversationId: null, sessionId: null, agentPath: REVIEW_FILE.path, paneId: null,
        flowId: null, startedAt: at(4_200), completedAt: at(3_600), input: null, activatedBy: null, output: null,
        verdict: { status: "fail", findings: ["one", "two"] }, error: null,
      }],
    }],
    cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null },
    state, pausedState: state === "paused" ? "running" : null, stateDetail: null, srcPath: null, srcConversationId: null,
    createdAt: at(7_200), closedAt: null,
  } as unknown as Pipeline;
}

/** The phone screen with a held-act store whose window this test closes. */
function phone(state: Pipeline["state"]) {
  let due: (() => void) | null = null;
  const acts = createPendingPipelineActs(
    { set: (callback) => { due = callback; return 1; }, clear: () => { due = null; } },
  );
  const host = mount(
    <MobilePipelineScreen pipeline={pipeline(state)} files={[REVIEW_FILE]} now={NOW} onOpenConversation={() => {}} acts={acts} />,
  );
  return {
    host,
    acts,
    tap: (key: string) => click(q(host, `[data-mobile2-pipeline-action="${key}"]`)),
    /** The receipt's four seconds elapse. */
    closeWindow: () => { const run = due; due = null; if (run) flushSync(run); },
    windowOpen: () => due !== null,
  };
}

/** The desktop strip for the same pipeline; `overflow` opens its ⋯ menu. */
function desktop(state: Pipeline["state"]) {
  const host = mount(<PipelineStrip pipeline={pipeline(state)} files={[REVIEW_FILE]} />);
  return {
    host,
    primary: (label: string) => click(q(host, `[aria-label="${label}"]`)),
    menuItem: (text: string) => {
      click(q(host, `[aria-label="${translate("en", "pipelineStrip.moreActions")}"]`));
      const item = Array.from(body().querySelectorAll('[role="menuitem"]')).find((el) => el.textContent?.includes(text));
      click(item ?? null);
    },
  };
}

const patchOf = (index: number) => ({ url: patches[index]!.url, body: patches[index]!.body });

test("retry, pause and resume act on the tap and issue exactly the desktop's PATCH", async () => {
  for (const [state, key, desktopLabel] of [
    ["needs_decision", "retry", translate("en", "pipelineStrip.retryStage")],
    ["running", "pause", translate("en", "pipelineStrip.pause")],
    ["paused", "resume", translate("en", "pipelineStrip.resume")],
  ] as const) {
    patches = [];
    const screen = phone(state);
    screen.tap(key);
    await settle();
    expect(patches.length).toBe(1);
    const fromPhone = patchOf(0);

    const strip = desktop(state);
    strip.primary(desktopLabel);
    await settle();
    expect(patches.length).toBe(2);
    expect(fromPhone).toEqual(patchOf(1));
    /* One tap, one act: nothing asked the operator to confirm it. */
    expect(screen.host.textContent).not.toContain("?");
    for (const root of roots) flushSync(() => root.unmount());
    roots = [];
  }
});

test("skip reaches the desktop's skip-stage, and its receipt carries Retry stage as a real cancellation", async () => {
  const screen = phone("needs_decision");
  screen.tap("skip");
  await settle();

  /* Nothing has gone out yet: the receipt is the window. */
  expect(patches).toEqual([]);
  const receipt = q(body(), "[data-mobile2-receipt]")!;
  expect(receipt.textContent).toContain(translate("en", "mobile2.pipeline.skipped"));
  const inverse = q(receipt, "[data-mobile2-receipt-undo]")!;
  expect(inverse.getAttribute("data-mobile2-receipt-undo")).toBe("retryStage");
  expect(inverse.textContent).toBe(translate("en", "mobile2.receipt.retryStage"));

  /* Taking the inverse cancels the act outright — the engine never sees it. */
  click(inverse);
  await settle();
  expect(patches).toEqual([]);
  expect(screen.windowOpen()).toBe(false);

  /* Skipping again and letting the window close sends the desktop's own PATCH. */
  screen.tap("skip");
  screen.closeWindow();
  await settle();
  expect(patches.length).toBe(1);
  const fromPhone = patchOf(0);

  const strip = desktop("needs_decision");
  strip.menuItem(translate("en", "pipelineStrip.skipStage"));
  await settle();
  expect(patches.length).toBe(2);
  expect(fromPhone).toEqual(patchOf(1));
  expect(fromPhone.body).toEqual({ action: "skip-stage" });
});

test("archive reaches the desktop's close, and its receipt carries Restore as a real cancellation", async () => {
  const screen = phone("completed");
  screen.tap("archive");
  await settle();

  expect(patches).toEqual([]);
  const receipt = q(body(), "[data-mobile2-receipt]")!;
  expect(receipt.textContent).toContain(translate("en", "mobile2.pipeline.archived"));
  const inverse = q(receipt, "[data-mobile2-receipt-undo]")!;
  expect(inverse.getAttribute("data-mobile2-receipt-undo")).toBe("restore");
  expect(inverse.textContent).toBe(translate("en", "mobile2.receipt.restore"));

  click(inverse);
  await settle();
  expect(patches).toEqual([]);

  screen.tap("archive");
  screen.closeWindow();
  await settle();
  expect(patches.length).toBe(1);
  const fromPhone = patchOf(0);

  const strip = desktop("completed");
  strip.menuItem(translate("en", "pipelineStrip.close"));
  await settle();
  expect(patches.length).toBe(2);
  expect(fromPhone).toEqual(patchOf(1));
  expect(fromPhone.body).toEqual({ action: "close" });
});

test("a second held act sends the first rather than dropping it", () => {
  /* The screen disables its own row while an act is held, so the second act
     comes from somewhere else — another pipeline's screen, the same tab. */
  const sent: string[] = [];
  let due: (() => void) | null = null;
  const acts = createPendingPipelineActs(
    { set: (callback) => { due = callback; return 1; }, clear: () => { due = null; } },
    (act) => sent.push(`${act.pipelineId}:${act.action}`),
  );
  acts.begin({ pipelineId: "p2", action: "skip-stage" });
  expect(sent).toEqual([]);
  acts.begin({ pipelineId: "p7", action: "close" });
  expect(sent).toEqual(["p2:skip-stage"]);
  const run = due as (() => void) | null;
  run?.();
  expect(sent).toEqual(["p2:skip-stage", "p7:close"]);
  /* A cancelled act is never sent, and the store is empty afterwards. */
  acts.begin({ pipelineId: "p9", action: "close" });
  acts.cancel();
  expect(sent).toEqual(["p2:skip-stage", "p7:close"]);
  expect(acts.getState()).toBeNull();
});

test("while an act is held the action row takes no further taps", async () => {
  const screen = phone("needs_decision");
  screen.tap("skip");
  await settle();
  const retry = q(screen.host, '[data-mobile2-pipeline-action="retry"]') as unknown as HTMLButtonElement;
  expect(retry.disabled).toBe(true);
  click(retry);
  await settle();
  expect(patches).toEqual([]);
});
