import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore, type ConnectionState } from "@/components/runtime/runtimeModel";
import { translate } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";

/*
 * The pipelines list on the phone (mobile v2 lane 7, #1439; README §4.7):
 * Needs you, Active, and a folded «n completed». A row is dot · task title ·
 * `stage k/n · <stage> · <state> · started` · the state badge, and it opens
 * its pipeline. Drafts never appear, and neither does a lane whose archive is
 * still inside its receipt's window — the operator has already been told it
 * went.
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

const { MobilePipelinesScreen, mobilePipelinesModel } = await import("./MobilePipelinesScreen");
const { createPendingPipelineActs } = await import("./MobilePipelineScreen");
const { createMobileNav, MobileNavContext } = await import("./mobileNav");
const { receipts } = await import("./MobileReceipt");

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement,
  Event: dom.Event, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
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
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; receipts.dismiss(); });
afterEach(() => { for (const root of roots) flushSync(() => root.unmount()); roots = []; receipts.dismiss(); });

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
const qa = (host: HTMLElement, selector: string) => Array.from(host.querySelectorAll(selector)) as unknown as HTMLElement[];
const click = (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  flushSync(() => el.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
};

const NOW = 1_800_000_000;
const at = (secondsAgo: number) => new Date((NOW - secondsAgo) * 1_000).toISOString();

function pipeline(over: Partial<Pipeline> & { id: string; task: string; state: Pipeline["state"] }): Pipeline {
  return {
    taskIds: [], project: "atlas", repoDir: "/repo", worktreeDir: "/repo-w", branch: "lane", baseBranch: "main", baseRef: "main",
    lastPassedCommit: "", stages: [
      { id: "implement", kind: "run", role: { roleId: "builder" }, prompt: "p", next: "review" },
      { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "p", next: null },
    ],
    runs: [],
    cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null },
    pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
    createdAt: at(7_200), closedAt: null,
    ...over,
  } as unknown as Pipeline;
}

const parked = pipeline({
  id: "p2", task: "Fast conversation switching", state: "needs_decision", createdAt: at(7_200),
  runs: [{ stageId: "review", attempts: [{ n: 3, state: "failed", verdict: { status: "fail", findings: ["one", "two"] }, startedAt: at(4_200), completedAt: at(3_600) }] }],
} as unknown as Partial<Pipeline> & { id: string; task: string; state: Pipeline["state"] });
const live = pipeline({ id: "p1", task: "Mobile redesign prototype", state: "running", createdAt: at(2_400) });
const finished = pipeline({ id: "p3", task: "Accounts dialog limits", state: "completed", createdAt: at(90_000), cursor: null } as unknown as Partial<Pipeline> & { id: string; task: string; state: Pipeline["state"] });
const draft = pipeline({ id: "p4", task: "Not started yet", state: "draft" });

test("the list is Needs you, Active and a folded «n completed»; drafts never appear", () => {
  const host = mount(<MobilePipelinesScreen pipelines={[live, parked, finished, draft]} now={NOW} onOpenPipeline={() => {}} />);
  expect(q(host, '[data-mobile2-screen="pipelines"]')).not.toBeNull();
  expect(q(host, "[data-mobile2-back]")).not.toBeNull();
  expect(q(host, "[data-mobile2-title-text]")!.textContent).toBe(translate("en", "mobile2.pipelines.title"));

  expect(qa(host, "[data-mobile2-section]").map((el) => el.getAttribute("data-mobile2-section"))).toEqual(["needs", "active", "completed"]);
  const rows = qa(host, "[data-mobile2-pipeline-row]");
  /* The parked lane first, the running one under Active, the completed one
     behind its toggle, and no draft anywhere. */
  expect(rows.map((row) => row.getAttribute("data-mobile2-pipeline-row"))).toEqual(["p2", "p1"]);
  expect(host.textContent).not.toContain("Not started yet");

  click(q(host, "[data-mobile2-completed-toggle]"));
  expect(qa(host, "[data-mobile2-pipeline-row]").map((row) => row.getAttribute("data-mobile2-pipeline-row"))).toEqual(["p2", "p1", "p3"]);
  expect(host.textContent).toContain(translate("en", "mobile2.pipelines.completed", { count: 1 }));
});

test("a row says the stage in the product's own words, badges the state and opens the pipeline", () => {
  const opened: string[] = [];
  const host = mount(<MobilePipelinesScreen pipelines={[live, parked]} now={NOW} onOpenPipeline={(pipe) => opened.push(pipe.id)} />);
  const row = q(host, '[data-mobile2-pipeline-row="p2"]')!;
  expect(row.tagName).toBe("BUTTON");
  expect(row.getAttribute("data-mobile2-go")).toBe("pipeline");
  expect(row.getAttribute("data-mobile2-state")).toBe("needs_decision");
  expect(row.textContent).toContain("Fast conversation switching");
  /* «stage 2/2 · Reviewer · failed» — the role's name from `stageChipLabel`
     and the chip state's own word, never a raw stage id. */
  expect(row.textContent).toContain(translate("en", "mobile2.pipelines.rowStage", {
    stage: 2, total: 2, name: translate("en", "roleCopy.reviewer.name"), state: translate("en", "pipelineChipState.failed"),
  }));
  expect(row.textContent).toContain(translate("en", "mobile2.pipelines.badgeDecision"));
  expect(row.textContent).toContain(translate("en", "mobile2.pipelines.rowStarted", { age: "2h" }));

  click(row);
  expect(opened).toEqual(["p2"]);

  const running = q(host, '[data-mobile2-pipeline-row="p1"]')!;
  expect(running.textContent).toContain(translate("en", "mobile2.pipelines.badgeRunning"));
  click(running);
  expect(opened).toEqual(["p2", "p1"]);
});

test("a lane whose archive is still inside its receipt's window is already gone from the list", () => {
  const acts = createPendingPipelineActs({ set: () => 1, clear: () => {} }, () => {});
  const host = mount(<MobilePipelinesScreen pipelines={[live, parked]} now={NOW} onOpenPipeline={() => {}} acts={acts} />);
  expect(qa(host, "[data-mobile2-pipeline-row]").length).toBe(2);
  flushSync(() => acts.begin({ pipelineId: "p1", action: "close" }));
  expect(qa(host, "[data-mobile2-pipeline-row]").map((row) => row.getAttribute("data-mobile2-pipeline-row"))).toEqual(["p2"]);
  /* A skip is not an archive: the lane stays on the list while it settles. */
  flushSync(() => acts.cancel());
  flushSync(() => acts.begin({ pipelineId: "p1", action: "skip-stage" }));
  expect(qa(host, "[data-mobile2-pipeline-row]").length).toBe(2);
});

test("the model groups by state and drops what the phone never lists", () => {
  const model = mobilePipelinesModel([live, parked, finished, draft, { ...finished, id: "p5", state: "closed" } as Pipeline]);
  expect(model.needs.map((p) => p.id)).toEqual(["p2"]);
  expect(model.active.map((p) => p.id)).toEqual(["p1"]);
  expect(model.completed.map((p) => p.id)).toEqual(["p3"]);
  /* A hidden lane is gone even when its state has not settled yet. */
  expect(mobilePipelinesModel([{ ...live, hiddenAt: at(60) } as Pipeline]).active).toEqual([]);
});

test("with nothing running the Active section says so rather than rendering an empty stack", () => {
  const host = mount(<MobilePipelinesScreen pipelines={[finished]} now={NOW} onOpenPipeline={() => {}} />);
  expect(host.textContent).toContain(translate("en", "mobile2.pipelines.none"));
  expect(qa(host, "[data-mobile2-pipeline-row]").length).toBe(0);
});
