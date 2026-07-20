import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { setLocale } from "@/lib/i18n";

import { DraftAgentPane } from "./DraftAgentPane";

/* Issue #266: the draft composer grounds its launch copy in the spawn host
   capability it already negotiates (`spawnTransport`). A structured (pane-less)
   spawn drops the tmux wording from the hint, placeholder, window title, and the
   frozen post-launch card; a legacy tmux spawn keeps it. */

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
});

const imageCapability = {
  supported: true,
  reason: null,
  formats: ["image/png"],
  maxImages: 2,
  maxRawBytesPerImage: 3,
  maxEncodedBytesPerRequest: 8,
};

const negotiation = (transport: "tmux" | "structured") => ({
  dirs: ["/repo"],
  cwd: "/repo",
  cwdExists: true,
  spawnTransport: transport,
  imageInput: { claude: imageCapability, codex: imageCapability },
});

function auxiliaryResponse(url: string): Response | null {
  if (url === "/api/accounts") return { ok: true, json: async () => ({ codex: { active: "terra", accounts: [] } }) } as Response;
  if (url === "/api/roles") return { ok: false, json: async () => ({}) } as Response;
  return null;
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("a structured spawn drops the tmux wording from the composer hint, placeholder, and frozen card (#266)", async () => {
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/spawn" && init?.method === "POST") {
      return {
        ok: true,
        status: 202,
        json: async () => ({ ok: true, state: "starting", launched: false, path: null, launchId: "launch-structured", conversationId: "conversation_structured" }),
      } as Response;
    }
    const auxiliary = auxiliaryResponse(url);
    if (auxiliary) return auxiliary;
    if (url.startsWith("/api/spawn?")) return { ok: true, json: async () => negotiation("structured") } as Response;
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(<DraftAgentPane draftId="structured-copy" project="proj" files={[]} onClose={() => {}} onSpawned={() => {}} />));
  await settle();

  /* Unlaunched composer copy follows the negotiated structured host. */
  expect(host.textContent).toContain("the agent will start, and the conversation");
  expect(host.textContent).not.toContain("tmux");
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  expect(textarea.placeholder).toBe("first prompt — the agent will start…");
  expect(host.innerHTML).toContain('title="new structured session with a fresh agent"');
  expect(host.innerHTML).not.toContain("tmux");

  /* The frozen card after launch stays tmux-free too. */
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onChange: (event: unknown) => void }>)[propsKey]!;
  flushSync(() => props.onChange({ target: { value: "Start the structured agent" } }));
  flushSync(() => host.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  await settle();

  const status = host.querySelector('[role="status"]') as HTMLElement;
  expect(status.textContent).toContain("confirming the agent");
  expect(host.textContent).not.toContain("tmux");
});

test("a legacy tmux spawn keeps the pane, window, and target wording (#266)", async () => {
  globalThis.fetch = (async (input) => {
    const url = String(input);
    const auxiliary = auxiliaryResponse(url);
    if (auxiliary) return auxiliary;
    if (url.startsWith("/api/spawn?")) return { ok: true, json: async () => negotiation("tmux") } as Response;
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(<DraftAgentPane draftId="legacy-copy" project="proj" files={[]} onClose={() => {}} onSpawned={() => {}} />));
  await settle();

  expect(host.textContent).toContain("the agent will start in tmux");
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  expect(textarea.placeholder).toBe("first prompt — the agent will start in tmux…");
  expect(host.innerHTML).toContain('title="new tmux window with a fresh agent"');
});
