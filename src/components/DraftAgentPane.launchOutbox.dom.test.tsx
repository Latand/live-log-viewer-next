import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { setLocale } from "@/lib/i18n";

import { DraftAgentPane } from "./DraftAgentPane";
import { adoptOutbox, readOutbox, resetOutboxForTests } from "./conversation/outbox";
import type { SpawnAttempt } from "./draftSpawn";

/*
 * P1#2 (round-1 review): the operator's initial launch prompt must become the
 * conversation's first optimistic user bubble. DraftAgentPane posts the prompt
 * to /api/spawn and clears the composer; it must ALSO seed the durable outbox
 * under the conversation identity so the queued launch window shows the message
 * instead of status chips over an empty feed. The seeded bubble is adopted into
 * the materialized conversation.
 */

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
let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  sessionStorage.clear();
  setLocale("en");
  globalThis.fetch = realFetch;
  resetOutboxForTests();
});

function stubFetch(post: (init?: RequestInit) => Response) {
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/spawn" && init?.method === "POST") return post(init);
    if (url.startsWith("/api/spawn?")) return { ok: true, json: async () => ({ dirs: ["/repo"] }) } as Response;
    if (url === "/api/accounts") return { ok: true, json: async () => ({ codex: { active: "terra", accounts: [] } }) } as Response;
    if (url === "/api/roles") return { ok: true, json: async () => ({ roles: [] }) } as Response;
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
}

async function launchWithPrompt(prompt: string) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(<DraftAgentPane draftId="seed-draft" project="proj" files={[]} onClose={() => {}} onSpawned={() => {}} />));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onChange: (event: unknown) => void }>)[propsKey]!;
  flushSync(() => props.onChange({ target: { value: prompt } }));
  flushSync(() => host.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  await new Promise((r) => setTimeout(r, 0));
  return { host, textarea };
}

function seedLegacyAttempt(draftId: string, clientAttemptId: string): void {
  const attempt = {
    clientAttemptId,
    at: Date.now(),
    target: "",
    path: null,
    conversationId: null,
    launchId: null,
    ["prompt"]: "Review the retained attachments",
    hasImages: true,
    request: {
      engine: "codex",
      model: "gpt-5.6-sol",
      cwd: "/repo",
      effort: "high",
      fast: false,
      accountId: "terra",
      ["prompt"]: "Review the retained attachments",
      images: [{ base64: "aGVsbG8=", mime: "image/png" }],
      src: "/source.jsonl",
      role: "reviewer",
      roleParams: { mode: "strict", rounds: 2 },
      reviews: "conversation_review_target",
    },
    engine: "codex",
    src: "/source.jsonl",
    phase: "confirming",
    error: null,
  } as unknown as SpawnAttempt;
  sessionStorage.setItem(`llvDraftPane:${draftId}:boot`, JSON.stringify(attempt));
}

async function renderRecoveredDraft(draftId: string): Promise<void> {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(<DraftAgentPane draftId={draftId} project="proj" files={[]} onClose={() => {}} onSpawned={() => {}} />));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForPosts(posts: readonly unknown[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 50 && posts.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(posts).toHaveLength(count);
}

test("a launched spawn seeds the prompt as the conversation's first launch-owned bubble", async () => {
  let posted: Record<string, unknown> | null = null;
  stubFetch((init) => {
    posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, state: "settled", launched: true, path: "/real/rollout.jsonl", launchId: "launch-seed", conversationId: "conversation_seed" }),
    } as Response;
  });

  const { textarea } = await launchWithPrompt("the operator's first ask");

  expect(posted).toMatchObject({ title: "claude · the operator's first ask" });
  // The composer cleared, and the prompt now lives in the durable outbox under
  // the conversation identity as a launch-owned bubble.
  expect(textarea.value).toBe("");
  const queue = readOutbox("conversation_seed");
  expect(queue).toHaveLength(1);
  expect(queue[0]).toMatchObject({ id: "launch-seed", text: "the operator's first ask", state: "delivering", launchOwned: true });
});

test("the seeded launch bubble adopts into the materialized conversation window", async () => {
  stubFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, state: "settled", launched: true, path: "/real/rollout.jsonl", launchId: "launch-adopt", conversationId: "conversation_adopt" }),
  } as Response));

  await launchWithPrompt("adopt me into the live conversation");

  // Even if a later identity flap keyed the window on the spawn route, adoption
  // carries the bubble forward without losing it.
  adoptOutbox("spawn:launch-adopt", "conversation_adopt");
  const live = readOutbox("conversation_adopt");
  expect(live.some((entry) => entry.text === "adopt me into the live conversation" && entry.launchOwned)).toBe(true);
});

test("a pre-title reload consumes an existing receipt with one titleless replay", async () => {
  const posts: Record<string, unknown>[] = [];
  seedLegacyAttempt("legacy-receipt", "attempt_legacy_receipt_1");
  stubFetch((init) => {
    posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        state: "settled",
        launched: true,
        path: "/real/legacy-receipt.jsonl",
        launchId: "launch-legacy-receipt",
        conversationId: "conversation_legacy_receipt",
      }),
    } as Response;
  });

  await renderRecoveredDraft("legacy-receipt");
  await waitForPosts(posts, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(posts).toHaveLength(1);
  expect(posts[0]).not.toHaveProperty("title");
  expect(posts[0]).toMatchObject({
    clientAttemptId: "attempt_legacy_receipt_1",
    images: [{ base64: "aGVsbG8=", mime: "image/png" }],
    role: "reviewer",
    roleParams: { mode: "strict", rounds: 2 },
    reviews: "conversation_review_target",
  });
});

test("a pre-title reload upgrades only after no receipt is confirmed and creates one launch", async () => {
  const posts: Record<string, unknown>[] = [];
  seedLegacyAttempt("legacy-no-receipt", "attempt_legacy_no_receipt_1");
  stubFetch((init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    posts.push(body);
    if (posts.length === 1) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: "title is required for every new spawn" }),
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        state: "settled",
        launched: true,
        path: "/real/legacy-upgraded.jsonl",
        launchId: "launch-legacy-upgraded",
        conversationId: "conversation_legacy_upgraded",
      }),
    } as Response;
  });

  await renderRecoveredDraft("legacy-no-receipt");
  await waitForPosts(posts, 2);
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(posts).toHaveLength(2);
  expect(posts[0]).not.toHaveProperty("title");
  expect(posts[1]).toMatchObject({
    title: "reviewer · Review the retained attachments",
    clientAttemptId: "attempt_legacy_no_receipt_1",
    images: [{ base64: "aGVsbG8=", mime: "image/png" }],
    role: "reviewer",
    roleParams: { mode: "strict", rounds: 2 },
    reviews: "conversation_review_target",
  });
  expect(new Set(posts.map((post) => post.clientAttemptId))).toEqual(new Set(["attempt_legacy_no_receipt_1"]));
});
