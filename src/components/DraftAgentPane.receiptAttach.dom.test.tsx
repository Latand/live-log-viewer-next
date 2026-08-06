import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import { setLocale } from "@/lib/i18n";
import { STREAM_RECONNECTED_EVENT } from "@/hooks/runtimeBus";
import { resetFilesClientCacheForTests } from "@/hooks/useFiles";

import { DraftAgentPane } from "./DraftAgentPane";
import type { SpawnAttempt } from "./draftSpawn";

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
  resetFilesClientCacheForTests();
});

const structuredNegotiation = {
  dirs: ["/repo"],
  cwd: "/repo",
  spawnTransport: "structured",
  imageInput: {
    claude: { supported: true, reason: null, formats: ["image/png"], maxImages: 2, maxRawBytesPerImage: 3, maxEncodedBytesPerRequest: 8 },
    codex: { supported: true, reason: null, formats: ["image/png"], maxImages: 2, maxRawBytesPerImage: 3, maxEncodedBytesPerRequest: 8 },
  },
};

function auxiliaryResponse(url: string): Response | null {
  if (url === "/api/accounts") return { ok: true, json: async () => ({ claude: { active: "main", accounts: [] } }) } as Response;
  if (url === "/api/roles") return { ok: false, json: async () => ({}) } as Response;
  return null;
}

function mount(draftId: string, files: FileEntry[], onSpawned: (file: FileEntry) => void) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(
    <DraftAgentPane draftId={draftId} project="proj" files={files} onClose={() => {}} onSpawned={onSpawned} />,
  ));
  return host;
}

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/** A persisted confirming attempt whose convergence window already elapsed. */
function staleAttempt(overrides: Partial<SpawnAttempt>): SpawnAttempt {
  return {
    clientAttemptId: "attempt-stale-919",
    at: Date.now() - 10 * 60_000,
    target: "",
    path: null,
    conversationId: null,
    launchId: null,
    ["prompt"]: "Fix the flaky attach",
    hasImages: false,
    request: null,
    engine: "claude",
    src: "",
    phase: "confirming",
    error: null,
    ...overrides,
  };
}

/* Regression 1 (issue #919): the attach is keyed on the spawn receipt's durable
   conversation id and happens IMMEDIATELY on the structured receipt — with a
   files feed that never delivers anything (`files` stays empty forever), the
   panel still hands the launch over to the live conversation window. */
test("a structured spawn receipt attaches instantly with a dead files feed", async () => {
  const spawned: FileEntry[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const auxiliary = auxiliaryResponse(url);
    if (auxiliary) return auxiliary;
    if (url === "/api/spawn" && init?.method === "POST") {
      return {
        ok: true,
        status: 202,
        json: async () => ({
          ok: true,
          state: "path-pending",
          transport: "structured",
          launched: true,
          path: null,
          launchId: "launch-919",
          conversationId: "conversation_919",
          initialMessage: "queued",
          target: null,
        }),
      } as Response;
    }
    if (url.startsWith("/api/spawn?")) return { ok: true, json: async () => structuredNegotiation } as Response;
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const host = mount("receipt-draft", [], (file) => spawned.push(file));
  await settle();

  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onChange: (event: unknown) => void }>)[propsKey]!;
  flushSync(() => props.onChange({ target: { value: "Ship the fix" } }));
  flushSync(() => host.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  await settle();

  expect(spawned).toHaveLength(1);
  expect(spawned[0]!.path).toBe("spawn:launch-919");
  expect(spawned[0]!.conversationId).toBe("conversation_919");
  expect(spawned[0]!.spawn?.launchId).toBe("launch-919");
  expect(spawned[0]!.spawn?.initialMessage).toBe("queued");
});

/* Regression 4 (the issue-body shape, pinned): an ADMITTED launch — the receipt
   named its durable conversation — whose window elapsed must never flip to the
   false «Агент, можливо, вже працює — не запускай його ще раз» attention state.
   It admits it is slow and keeps watching. */
test("an admitted spawn past its window shows the slow-launch state, never attention", async () => {
  setLocale("uk");
  globalThis.fetch = (async (input) => {
    const url = String(input);
    const auxiliary = auxiliaryResponse(url);
    if (auxiliary) return auxiliary;
    if (url.startsWith("/api/spawn?")) return { ok: true, json: async () => structuredNegotiation } as Response;
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  sessionStorage.setItem(
    "llvDraftPane:stale-draft:boot",
    JSON.stringify(staleAttempt({ conversationId: "conversation_919", launchId: "launch-919" })),
  );

  const host = mount("stale-draft", [], () => {});
  await settle();

  expect(host.textContent).not.toContain("Агент, можливо, вже працює");
  expect(host.textContent).toContain("Запускається повільно");
});

/* Attention copy stays reserved for genuinely unproven launches: an attempt
   that never learned a receipt (transport loss) still escalates. */
test("an unproven launch (no receipt) still escalates to attention", async () => {
  setLocale("uk");
  globalThis.fetch = (async (input) => {
    const url = String(input);
    const auxiliary = auxiliaryResponse(url);
    if (auxiliary) return auxiliary;
    if (url.startsWith("/api/spawn?")) return { ok: true, json: async () => structuredNegotiation } as Response;
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  sessionStorage.setItem("llvDraftPane:unproven-draft:boot", JSON.stringify(staleAttempt({})));

  const host = mount("unproven-draft", [], () => {});
  await settle();

  expect(host.textContent).toContain("Агент, можливо, вже працює");
});

/* Regression 3: a stream re-subscribe during the watch resets the window — the
   slow admission clears back to the plain confirming state, and the watch keeps
   going without ever giving up into attention. */
test("a stream reconnect during the watch resets the window", async () => {
  setLocale("uk");
  globalThis.fetch = (async (input) => {
    const url = String(input);
    const auxiliary = auxiliaryResponse(url);
    if (auxiliary) return auxiliary;
    if (url.startsWith("/api/spawn?")) return { ok: true, json: async () => structuredNegotiation } as Response;
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  sessionStorage.setItem(
    "llvDraftPane:reconnect-draft:boot",
    JSON.stringify(staleAttempt({ conversationId: "conversation_919", launchId: "launch-919" })),
  );

  const host = mount("reconnect-draft", [], () => {});
  await settle();
  expect(host.textContent).toContain("Запускається повільно");

  flushSync(() => {
    window.dispatchEvent(new dom.Event(STREAM_RECONNECTED_EVENT) as unknown as Event);
  });
  await settle();

  expect(host.textContent).not.toContain("Запускається повільно");
  expect(host.textContent).not.toContain("Агент, можливо, вже працює");
  expect(host.textContent).toContain("Запущено — підтверджую агента");
});
