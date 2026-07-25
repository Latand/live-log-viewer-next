import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";
import { buildBranchGroups } from "@/components/projectModel";

import { SchemeBoard } from "./SchemeBoard";

/*
 * The full-window overlay is the surface a stage conversation is actually READ
 * in, so it carries the same imposed identity as the board card (#658). Without
 * it, expanding the live stage put the operator back in front of the shared
 * safety preamble the scanner titled the transcript with — visibly and in the
 * dialog's accessible name — one click from the surface that fixed it.
 */

const dom = new Window();
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(dom as unknown as { matchMedia: (q: string) => unknown }).matchMedia = () => ({
  matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
});
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLDivElement: dom.HTMLDivElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver,
  IntersectionObserver: undefined,
});

const roots = new Set<Root>();
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  document.body.replaceChildren();
  dom.sessionStorage.clear();
  dom.localStorage.clear();
});

/* The transcript title the scanner derives: the stage prompt's first line, which
   is the same shared preamble on every stage of every pipeline. */
const preamble = "Work alone and launch no helpers, workflows, teams or subagents.";

function entry(over: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects", name: over.path, project: "demo", title: preamble,
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1000,
    size: 10, activity: "live", proc: "running", pid: 7, model: null,
    pendingQuestion: null, waitingInput: null, ...over,
  };
}

const stageRole = { roleId: null, engine: "codex" as const, model: null, effort: null, access: "read-write" as const, promptScaffold: null };
const integrate = entry({ path: "/integrate", conversationId: "c-integrate", renamable: true });

const pipeline = {
  id: "p658", task: "V3 voice", project: "demo", repoDir: "/r", worktreeDir: "/w", branch: "b",
  baseBranch: "main", baseRef: "a", lastPassedCommit: "a",
  stages: [
    { id: "plan_v3_voice", kind: "run", role: { roleId: "architect" }, prompt: "", next: "integrate_v3_voice", effectiveRole: stageRole },
    { id: "integrate_v3_voice", kind: "run", role: { roleId: "builder" }, prompt: "", next: null, effectiveRole: stageRole },
  ],
  runs: [{ stageId: "integrate_v3_voice", attempts: [{ n: 1, state: "running", agentPath: "/integrate", flowId: null }] }],
  cursor: { stageId: "integrate_v3_voice", state: "running", input: null, activatedBy: null },
  state: "running", pausedState: null, stateDetail: null,
  srcPath: null, srcConversationId: null, createdAt: new Date(0).toISOString(), closedAt: null,
} as unknown as Pipeline;

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => undefined);
};

function mountBoard(files: FileEntry[], pipelines: Pipeline[], focus: string | null = null): HTMLElement {
  const groups = buildBranchGroups(files, "demo");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(
    <SchemeBoard
      project="demo"
      groups={groups}
      manual={[]}
      files={files}
      flows={[]}
      pipelines={pipelines}
      surfacePipelines={pipelines}
      tasks={[]}
      drafts={[]}
      focus={focus}
      onSelect={() => {}}
      onClose={() => {}}
      onDraftClose={() => {}}
      onDraftSpawned={() => {}}
    />,
  ));
  return host;
}

function expandBoardPane(host: HTMLElement, path: string): void {
  const pane = host.querySelector(`[data-scheme-node="${path}"]`)!;
  const expand = [...pane.querySelectorAll("button")].find((button) =>
    (button.getAttribute("aria-label") ?? "").startsWith("Expand conversation"),
  ) as HTMLButtonElement;
  expect(expand).toBeTruthy();
  flushSync(() => expand.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
}

test("expanding a live stage pane keeps the role-first identity, in the header and in the dialog's accessible name", async () => {
  const host = mountBoard([integrate], [pipeline]);
  await settle();
  /* The board card is already named by its stage. */
  expect(host.querySelector("[data-pane-title-override]")?.textContent).toBe("Builder · integrate_v3_voice · stage 2/2");

  expandBoardPane(host, "/integrate");
  await settle();

  const dialog = host.querySelector('[role="dialog"]') as HTMLElement;
  expect(dialog).toBeTruthy();
  expect(dialog.getAttribute("aria-label")).toBe("Builder · integrate_v3_voice · stage 2/2");
  expect(dialog.getAttribute("aria-label")).not.toContain("Work alone");
  const title = dialog.querySelector("[data-pane-title-override]") as HTMLElement;
  expect(title.textContent).toBe("Builder · integrate_v3_voice · stage 2/2");
  /* Reachable, not lost: the transcript's own title rides the header tooltip. */
  expect(title.getAttribute("title")).toContain(preamble);
});

test("F2 on the selected stage node opens a working rename editor in the overlay", async () => {
  /* Renaming works by expanding the node and replaying a token into the
     overlay's SessionTitle; the imposed identity steps aside while that token is
     live, so imposing it never removes the last rename path stage transcripts
     have. */
  /* A focus jump selects its node, which is what F2 acts on. */
  const host = mountBoard([integrate], [pipeline], "/integrate");
  await settle();
  flushSync(() => window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "F2", bubbles: true }) as unknown as Event));
  await settle();

  const dialog = host.querySelector('[role="dialog"]') as HTMLElement;
  expect(dialog).toBeTruthy();
  /* The editor is mounted (the override yielded), so the operator can type. */
  expect(dialog.querySelector("input")).toBeTruthy();
  expect(dialog.querySelector("[data-pane-title-override]")).toBeNull();
});

test("a conversation that is not a pipeline stage keeps its own title in the overlay", async () => {
  const plain = entry({ path: "/plain", conversationId: "c-plain", title: "Plain conversation" });
  const host = mountBoard([plain], []);
  await settle();
  expandBoardPane(host, "/plain");
  await settle();

  const dialog = host.querySelector('[role="dialog"]') as HTMLElement;
  expect(dialog.getAttribute("aria-label")).toBe("Plain conversation");
  expect(dialog.querySelector("[data-pane-title-override]")).toBeNull();
});
