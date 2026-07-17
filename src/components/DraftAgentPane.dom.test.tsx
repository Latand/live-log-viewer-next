import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import { FILES_CHANGED_EVENT } from "@/lib/filesEvents";

import { DraftAgentPane } from "./DraftAgentPane";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLSelectElement: dom.HTMLSelectElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
});

const realFetch = globalThis.fetch;
const implementer = {
  path: "/sessions/implementer.jsonl",
  root: "codex-sessions",
  name: "implementer.jsonl",
  project: "proj",
  title: "Implement durable membership",
  engine: "codex",
  kind: "session",
  fmt: "codex",
  parent: null,
  mtime: 1,
  size: 1,
  activity: "idle",
  proc: null,
  pid: null,
  model: null,
  pendingQuestion: null,
  waitingInput: null,
  conversationId: "conversation_019f4906-3f67-7b72-9fbc-9ec3b5ad1325",
} satisfies FileEntry;
const childImplementer = {
  ...implementer,
  path: "/sessions/child-implementer.jsonl",
  name: "child-implementer.jsonl",
  title: "Implement child task",
  parent: implementer.path,
  conversationId: "conversation_019f4906-3f67-7b72-9fbc-9ec3b5ad1326",
} satisfies FileEntry;

let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  sessionStorage.clear();
  globalThis.fetch = realFetch;
});

test("Reviewer role persists and submits the reviewed conversation", async () => {
  const posts: Record<string, unknown>[] = [];
  let filesRefreshes = 0;
  const onFilesChanged = () => { filesRefreshes += 1; };
  window.addEventListener(FILES_CHANGED_EVENT, onFilesChanged);
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/spawn" && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return {
        ok: true,
        status: 202,
        json: async () => ({ ok: true, state: "starting", launched: false, path: null, launchId: "launch-reviewer", conversationId: "conversation_reviewer" }),
      } as Response;
    }
    if (url.startsWith("/api/spawn?")) return { ok: true, json: async () => ({ dirs: ["/repo"] }) } as Response;
    if (url === "/api/accounts") return { ok: true, json: async () => ({ codex: { active: "terra", accounts: [] } }) } as Response;
    if (url === "/api/roles") return {
      ok: true,
      json: async () => ({
        roles: [{
          id: "reviewer",
          name: "Reviewer",
          description: "Review an implementer",
          config: { engine: "codex", model: "gpt-5.6-sol", effort: "high" },
          parameters: [],
          promptPreview: "Review",
          safetyFences: [],
        }],
      }),
    } as Response;
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(
    <DraftAgentPane draftId="review-draft" project="proj" files={[implementer, childImplementer]} onClose={() => {}} onSpawned={() => {}} />,
  ));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const role = host.querySelector('select[aria-label="Agent role preset"]') as HTMLSelectElement;
  role.value = "reviewer";
  flushSync(() => role.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event));

  const reviews = host.querySelector('select[aria-label="Reviewed conversation"]') as HTMLSelectElement;
  expect(reviews).toBeTruthy();
  expect([...reviews.options].some((option) => option.value === implementer.conversationId)).toBe(true);
  expect([...reviews.options].some((option) => option.value === childImplementer.conversationId)).toBe(true);
  reviews.value = implementer.conversationId;
  flushSync(() => reviews.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event));
  expect(sessionStorage.getItem("llvDraftPane:review-draft:reviews")).toBe(implementer.conversationId);

  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onChange: (event: unknown) => void }>)[propsKey]!;
  flushSync(() => props.onChange({ target: { value: "Review the durable membership work" } }));
  flushSync(() => host.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({
    role: "reviewer",
    reviews: implementer.conversationId,
    prompt: "Review the durable membership work",
  });
  expect(filesRefreshes).toBe(1);
  window.removeEventListener(FILES_CHANGED_EVENT, onFilesChanged);
});

test("an admitted structured spawn adopts its provisional card in the same mount", async () => {
  const posts: Record<string, unknown>[] = [];
  const spawned: FileEntry[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/spawn" && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return {
        ok: true,
        status: 202,
        json: async () => ({
          ok: true,
          state: "starting",
          launched: false,
          path: null,
          launchId: "launch-fast",
          conversationId: "conversation_fast",
          initialMessage: "pending",
        }),
      } as Response;
    }
    if (url.startsWith("/api/spawn?")) return { ok: true, json: async () => ({ dirs: ["/repo"] }) } as Response;
    if (url === "/api/accounts") return { ok: true, json: async () => ({ codex: { active: "terra", accounts: [] } }) } as Response;
    if (url === "/api/roles") return { ok: true, json: async () => ({ roles: [] }) } as Response;
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const render = (files: FileEntry[]) => flushSync(() => root!.render(
    <DraftAgentPane
      draftId="fast-draft"
      project="proj"
      files={files}
      onClose={() => {}}
      onSpawned={(file) => spawned.push(file)}
    />,
  ));
  render([]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onChange: (event: unknown) => void }>)[propsKey]!;
  flushSync(() => props.onChange({ target: { value: "Start immediately" } }));
  flushSync(() => host.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(posts).toHaveLength(1);
  const provisional = {
    ...implementer,
    path: "spawn:launch-fast",
    name: "spawn:launch-fast",
    title: "Codex",
    conversationId: "conversation_fast",
    spawn: {
      launchId: "launch-fast",
      clientAttemptId: null,
      accountId: "terra",
      state: "starting",
      initialMessage: "pending",
      retrySafe: false,
      error: null,
    },
  } satisfies FileEntry;
  render([provisional]);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(spawned).toEqual([provisional]);
  expect(posts).toHaveLength(1);
});
