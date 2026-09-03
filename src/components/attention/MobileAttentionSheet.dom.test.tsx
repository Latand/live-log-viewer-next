import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { needsDecisionPipelineRows } from "@/components/mobile/mobileBoardModel";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { buildAttentionQueue } from "../attention";
import { buildMobileAttentionQueue } from "./attentionQueue";
import { MobileAttentionSheet } from "./MobileAttentionSheet";

/*
 * The Needs-you sheet (mobile v2 lane 8, #1439; README §4.1, §4.6): one list
 * of conversations and `needs_decision` pipelines, «Needs you · n» in the
 * header, «Next ›» beside it when there is more than one item — skipping the
 * item on screen and wrapping — rows that name the decision, and nothing at
 * zero but the empty line.
 */

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
  await new Promise((r) => setTimeout(r, 0));
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
});

let roots: Root[] = [];
beforeEach(() => { dom.document.body.replaceChildren(); dom.document.body.style.overflow = ""; roots = []; });
afterEach(() => { for (const root of roots) flushSync(() => root.unmount()); roots = []; });

function mount(node: React.ReactNode): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(node));
  roots.push(root);
  return host as unknown as HTMLElement;
}

const click = (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  el.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never);
};
const q = (host: HTMLElement, selector: string) => host.querySelector(selector) as unknown as HTMLElement | null;
const qa = (host: HTMLElement, selector: string) => Array.from(host.querySelectorAll(selector)) as unknown as HTMLElement[];

const NOW = 1_800_000_000;
const PROJECT = "atlas";

function conversation(path: string, title: string, since: number, over: Partial<FileEntry> = {}): FileEntry {
  return {
    root: "claude-projects", name: path, path, project: PROJECT, title, engine: "codex", kind: "session", fmt: "codex",
    parent: null, mtime: NOW - 60, size: 10, activity: "idle", proc: null, pid: null, model: "gpt-5.6", waitingInput: null,
    pendingQuestion: {
      kind: "question", toolUseId: `tool-${path}`, transcriptPath: path, pid: 4242, paneTarget: null, askedAt: new Date(since * 1000).toISOString(),
      questions: [{ header: "", question: "Which endpoint first?", multiSelect: false, options: [] }],
    },
    ...over,
  } as FileEntry;
}

function pipeline(id: string, task: string, state: Pipeline["state"], completedAt: number): Pipeline {
  return {
    id, task, taskIds: [], project: PROJECT, repoDir: "/repo", worktreeDir: "/repo-lane", branch: "lane/1", baseBranch: "main", baseRef: "main",
    lastPassedCommit: "", stages: [{ id: "design", kind: "run" }, { id: "implement", kind: "run", role: { roleId: "builder" } }, { id: "review", kind: "review-loop" }, { id: "merge", kind: "run" }, { id: "deploy", kind: "run" }],
    runs: [{ stageId: "review", attempts: [{ n: 2, state: "failed", verdict: { status: "fail", findings: ["remount drops the feed cache", "the switch is 640 ms"] }, completedAt: new Date(completedAt * 1000).toISOString() }] }],
    cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null },
    state, pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
    createdAt: new Date((NOW - 7_200) * 1000).toISOString(), closedAt: null,
  } as unknown as Pipeline;
}

const FILES = [
  conversation("/p/export.jsonl", "Implement the export endpoint", NOW - 540),
  conversation("/p/migrate.jsonl", "Migrate accounts to the new binding", NOW - 120, {
    engine: "claude", fmt: "claude", model: "opus",
    pendingQuestion: { kind: "plan", toolUseId: "tool-plan", transcriptPath: "/p/migrate.jsonl", pid: 1, paneTarget: null, askedAt: new Date((NOW - 120) * 1000).toISOString(), questions: [], plan: "1. read" },
  } as Partial<FileEntry>),
];
const PIPELINES = [pipeline("pipeline_atlas_p2", "Fast conversation switching", "needs_decision", NOW - 3_600), pipeline("pipeline_atlas_p1", "Board status projection", "running", NOW - 60)];
const entries = () => buildMobileAttentionQueue(buildAttentionQueue(FILES, NOW, PROJECT), needsDecisionPipelineRows(PIPELINES, PROJECT, NOW));

test("the sheet lists conversations and needs_decision pipelines as one list under «Needs you · n», rows naming the decision", () => {
  const host = mount(<MobileAttentionSheet entries={entries()} now={NOW} onOpenConversation={() => {}} onClose={() => {}} screen={{ kind: "board" }} />);
  const sheet = q(host, '[data-mobile2-sheet="attention"]')!;
  expect(sheet).not.toBeNull();
  expect(sheet.getAttribute("aria-label")).toBe("Needs you · 3");
  expect(q(host, "h2")!.textContent).toBe("Needs you · 3");

  const rows = qa(host, "[data-attention-row]");
  expect(rows.map((row) => row.getAttribute("data-mobile2-go"))).toEqual(["chat", "chat", null]);
  expect(rows[0]!.textContent).toContain("Implement the export endpoint");
  expect(rows[0]!.querySelector("[data-attention-decision]")!.textContent).toBe("a question");
  expect(rows[0]!.textContent).toContain("9m");
  expect(rows[0]!.textContent).toContain("gpt-5.6");
  expect(rows[0]!.querySelector('[data-mobile2-engine="codex"]')).not.toBeNull();
  expect(rows[1]!.querySelector("[data-attention-decision]")!.textContent).toBe("plan approval");
  /* The pipeline row: the board's words, prefixed with what it is. */
  expect(rows[2]!.getAttribute("data-mobile2-pipeline-row")).toBe("pipeline_atlas_p2");
  expect(rows[2]!.textContent).toContain("Fast conversation switching");
  expect(rows[2]!.querySelector("[data-attention-decision]")!.textContent).toBe("pipeline · stage 3/5 · review loop failed · 2 findings");
  expect(rows[2]!.textContent).toContain("1h");
  /* Every row is a 44 px target. */
  for (const row of rows) expect(row.className).toContain("min-h-11");
});

test("a conversation row opens through the host; a pipeline row is inert until the pipeline screen supplies an opener, then it is a door", () => {
  const opened: string[] = [];
  let host = mount(<MobileAttentionSheet entries={entries()} now={NOW} onOpenConversation={(item) => opened.push(item.file.path)} onClose={() => {}} screen={{ kind: "board" }} />);
  click(q(host, '[data-mobile2-conversation="/p/migrate.jsonl"]'));
  expect(opened).toEqual(["/p/migrate.jsonl"]);
  const inert = q(host, '[data-mobile2-pipeline-row="pipeline_atlas_p2"]')!;
  expect(inert.tagName).toBe("DIV");
  expect(inert.getAttribute("data-mobile2-go")).toBeNull();
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];

  const pipelines: string[] = [];
  host = mount(<MobileAttentionSheet entries={entries()} now={NOW} onOpenConversation={() => {}} onOpenPipeline={(row) => pipelines.push(row.id)} onClose={() => {}} screen={{ kind: "board" }} />);
  const door = q(host, '[data-mobile2-pipeline-row="pipeline_atlas_p2"]')!;
  expect(door.tagName).toBe("BUTTON");
  expect(door.getAttribute("data-mobile2-go")).toBe("pipeline");
  expect(door.getAttribute("aria-label")).toBe("Open the pipeline Fast conversation switching");
  click(door);
  expect(pipelines).toEqual(["pipeline_atlas_p2"]);
});

test("«Next ›» skips the item on screen and wraps, over both kinds once pipelines can be opened", () => {
  const opened: string[] = [];
  const props = { now: NOW, onOpenConversation: (item: { file: FileEntry }) => opened.push(item.file.path), onOpenPipeline: (row: { id: string }) => opened.push(row.id), onClose: () => {} };
  /* From the board: the head. */
  let host = mount(<MobileAttentionSheet entries={entries()} {...props} screen={{ kind: "board" }} />);
  const next = q(host, "[data-attention-next]")!;
  expect(next.className).toContain("min-h-11");
  expect(next.getAttribute("aria-label")).toBe("Open the next one that needs you");
  click(next);
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  /* From the first conversation: the second; from the second: the pipeline;
     from the pipeline: wraps to the first. */
  for (const screen of [{ kind: "chat" as const, id: "/p/export.jsonl" }, { kind: "chat" as const, id: "/p/migrate.jsonl" }, { kind: "pipeline" as const, id: "pipeline_atlas_p2" }]) {
    host = mount(<MobileAttentionSheet entries={entries()} {...props} screen={screen} />);
    click(q(host, "[data-attention-next]"));
    for (const root of roots) flushSync(() => root.unmount());
    roots = [];
  }
  expect(opened).toEqual(["/p/export.jsonl", "/p/migrate.jsonl", "pipeline_atlas_p2", "/p/export.jsonl"]);
});

test("without a pipeline opener «Next ›» walks the conversations only, and the row on screen is marked current", () => {
  const opened: string[] = [];
  const host = mount(<MobileAttentionSheet entries={entries()} now={NOW} onOpenConversation={(item) => opened.push(item.file.path)} onClose={() => {}} screen={{ kind: "chat", id: "/p/migrate.jsonl" }} />);
  expect(q(host, '[data-mobile2-conversation="/p/migrate.jsonl"]')!.getAttribute("aria-current")).toBe("true");
  expect(q(host, '[data-mobile2-conversation="/p/export.jsonl"]')!.getAttribute("aria-current")).toBeNull();
  /* After the last conversation the pipeline has no door yet, so Next wraps
     to the first conversation instead of stepping into nowhere. */
  click(q(host, "[data-attention-next]"));
  expect(opened).toEqual(["/p/export.jsonl"]);
});

test("one item shows no «Next ›», and zero items show the empty line under a bare «Needs you»", () => {
  const one = buildMobileAttentionQueue(buildAttentionQueue([FILES[0]!], NOW, PROJECT), []);
  let host = mount(<MobileAttentionSheet entries={one} now={NOW} onOpenConversation={() => {}} onClose={() => {}} screen={{ kind: "board" }} />);
  expect(q(host, "[data-attention-next]")).toBeNull();
  expect(q(host, "h2")!.textContent).toBe("Needs you · 1");
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];

  host = mount(<MobileAttentionSheet entries={[]} now={NOW} onOpenConversation={() => {}} onClose={() => {}} screen={{ kind: "board" }} />);
  expect(q(host, "h2")!.textContent).toBe("Needs you");
  expect(q(host, "[data-attention-next]")).toBeNull();
  expect(q(host, "[data-mobile2-attention-empty]")!.textContent).toBe("Nothing needs you.");
  expect(qa(host, "[data-attention-row]")).toHaveLength(0);
});

test("the × closes through the host", () => {
  let closed = 0;
  const host = mount(<MobileAttentionSheet entries={entries()} now={NOW} onOpenConversation={() => {}} onClose={() => { closed += 1; }} screen={{ kind: "board" }} />);
  click(q(host, "[data-mobile2-close]"));
  expect(closed).toBe(1);
});
