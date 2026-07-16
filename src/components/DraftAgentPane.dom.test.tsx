import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import { setLocale } from "@/lib/i18n";

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
  setLocale("en");
  globalThis.fetch = realFetch;
});

const imageCapability = (supported: boolean, overrides: Record<string, unknown> = {}) => ({
  supported,
  reason: supported ? null : "Unavailable",
  formats: ["image/png"],
  maxImages: 2,
  maxRawBytesPerImage: 3,
  maxEncodedBytesPerRequest: 8,
  ...overrides,
});

const imageNegotiation = (spawnTransport: "tmux" | "structured") => ({
  dirs: ["/repo"],
  cwd: "/repo",
  cwdExists: true,
  spawnTransport,
  imageInput: {
    claude: imageCapability(true),
    codex: imageCapability(true),
  },
});

function auxiliaryResponse(url: string): Response | null {
  if (url === "/api/accounts") return { ok: true, json: async () => ({ codex: { active: "terra", accounts: [] } }) } as Response;
  if (url === "/api/roles") return { ok: false, json: async () => ({}) } as Response;
  return null;
}

test("image capability failure renders localized recovery and retry restores tmux attachments", async () => {
  setLocale("uk");
  let requests = 0;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    const auxiliary = auxiliaryResponse(url);
    if (auxiliary) return auxiliary;
    if (url.startsWith("/api/spawn?")) {
      requests += 1;
      if (requests === 1) return { ok: false, json: async () => ({}) } as Response;
      return { ok: true, json: async () => imageNegotiation("tmux") } as Response;
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(<DraftAgentPane draftId="image-retry-tmux" project="proj" files={[]} onClose={() => {}} onSpawned={() => {}} />));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(host.textContent).toContain("Не вдалося завантажити дані про підтримку зображень.");
  const retry = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Повторити перевірку")) as HTMLButtonElement;
  expect(retry).toBeTruthy();
  expect((host.querySelector('button[aria-label="Додати картинки до промпта"]') as HTMLButtonElement).disabled).toBe(true);
  flushSync(() => retry.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(requests).toBe(2);
  expect((host.querySelector('button[aria-label="Додати картинки до промпта"]') as HTMLButtonElement).disabled).toBe(false);
});

test("malformed capability retry adopts structured image limits for Claude and Codex", async () => {
  let requests = 0;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    const auxiliary = auxiliaryResponse(url);
    if (auxiliary) return auxiliary;
    if (url.startsWith("/api/spawn?")) {
      requests += 1;
      if (requests === 1) return { ok: true, json: async () => ({ dirs: ["/repo"], spawnTransport: "structured", imageInput: { claude: { supported: true } } }) } as Response;
      return { ok: true, json: async () => imageNegotiation("structured") } as Response;
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(<DraftAgentPane draftId="image-retry-structured" project="proj" files={[]} onClose={() => {}} onSpawned={() => {}} />));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const retry = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Retry image check")) as HTMLButtonElement;
  expect(retry).toBeTruthy();
  flushSync(() => retry.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((host.querySelector('button[aria-label="Add images to the prompt"]') as HTMLButtonElement).disabled).toBe(false);

  const textarea = host.querySelector("textarea")!;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onPaste(event: unknown): void }>)[propsKey]!;
  flushSync(() => props.onPaste({
    clipboardData: { items: [{ type: "image/png", getAsFile: () => ({ name: "large.png", type: "image/png", size: 4 }) }] },
    preventDefault() {},
  }));
  expect(host.textContent).toContain("Image exceeds this host's");

  const codex = [...host.querySelectorAll('[role="radio"]')].find((button) => button.textContent === "Codex") as HTMLButtonElement;
  flushSync(() => codex.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const picker = host.querySelector('button[aria-label="Add images to the prompt"]') as HTMLButtonElement;
  expect(requests).toBe(2);
  expect(picker.disabled).toBe(false);
});

test("Reviewer role persists and submits the reviewed conversation", async () => {
  const posts: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/spawn" && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return {
        ok: true,
        status: 202,
        json: async () => ({ ok: true, state: "starting", launched: false, path: null, launchId: "launch-reviewer" }),
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
});
