import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { FileEntry } from "@/lib/types";
import type { TaskWorkflowProjection, WorkReference } from "./taskWorkflowModel";
import { TaskWorkflowPanel } from "./TaskWorkflowPanel";

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
  Node: dom.Node, Event: dom.Event, localStorage: dom.localStorage, sessionStorage: dom.sessionStorage });
let root: Root | null = null;
afterEach(() => { if (root) flushSync(() => root!.unmount()); root = null; dom.document.body.replaceChildren(); });

function render(count: number) {
  const references: WorkReference[] = Array.from({ length: count }, (_, i) => ({
    key: `worker-${i}`, kind: "assignment", role: "worker", state: "running", file: { path: `fixtures/worker-${i}.jsonl`, title: `Worker ${i}`, conversationId: `conversation_fixture_${i}` } as FileEntry,
    path: null, conversationId: null, launchId: null, reviewedSha: null, verdict: null, findings: [], findingsCount: null, error: null,
  }));
  const model: TaskWorkflowProjection = { tasks: [], unlinkedPipelines: [], unlinkedFlows: [], unlinkedWorkers: references.map(r => r.file!), unlinkedReferences: references };
  const opened: FileEntry[] = [];
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  flushSync(() => root!.render(<TaskWorkflowPanel model={model} onOpen={file => opened.push(file)} onClose={() => {}} />));
  return { host, model, opened };
}

test("only thirty history rows mount and the last of one thousand workers opens", () => {
  const { host, opened } = render(1000);
  expect(host.querySelectorAll("[data-work-reference]").length).toBe(30);
  const next = () => [...host.querySelectorAll("button")].find(b => b.textContent === "Next")!;
  for (let i = 0; i < 33; i++) flushSync(() => next().click());
  expect(host.querySelectorAll("[data-work-reference]").length).toBe(10);
  flushSync(() => host.querySelector<HTMLButtonElement>('[data-work-reference="worker-999"] button')!.click());
  expect(opened.map(f => f.path)).toEqual(["fixtures/worker-999.jsonl"]);
  expect(next().disabled).toBe(true);
});

test("pathless attempts retain findings and have no invented open action", () => {
  const { host, model } = render(1);
  model.unlinkedReferences = [{ ...model.unlinkedReferences[0], kind: "attempt", file: null, role: "reviewer", state: "needs_decision",
    error: "Provider limit interrupted verification", findings: ["Hidden wrappers still execute"], reviewedSha: null }];
  flushSync(() => root!.render(<TaskWorkflowPanel model={{ ...model }} onOpen={() => { throw Error("unresolved launch opened"); }} onClose={() => {}} />));
  expect(host.textContent).toContain("Launch unresolved");
  expect(host.textContent).toContain("Reviewed revision unrecorded");
  expect(host.textContent).toContain("Hidden wrappers still execute");
  expect(host.querySelector("[data-work-reference] button")).toBeNull();
});
