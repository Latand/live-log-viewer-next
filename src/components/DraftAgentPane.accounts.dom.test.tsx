import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

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
let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  sessionStorage.clear();
  setLocale("en");
  globalThis.fetch = realFetch;
});

const imageCapability = { supported: true, reason: null, formats: ["image/png"], maxImages: 2, maxRawBytesPerImage: 3, maxEncodedBytesPerRequest: 8 };

/** Stored-profile catalog for both engines (issue #40): Claude has an active
    account, a second signed-in profile, and a signed-out historical one. */
const catalog = {
  claude: {
    active: "anna",
    accounts: [
      { id: "anna", label: "anna", authPresent: true },
      { id: "bob", label: "bob", authPresent: true },
      { id: "carol", label: "carol", authPresent: false },
    ],
  },
  codex: { active: "terra", accounts: [{ id: "terra", label: "terra", authPresent: true }] },
};

function installFetch(posts: Record<string, unknown>[]): void {
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/spawn" && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return {
        ok: true,
        status: 202,
        json: async () => ({ ok: true, state: "starting", launched: false, path: null, launchId: `launch-${posts.length}`, conversationId: `conversation-${posts.length}`, initialMessage: "pending" }),
      } as Response;
    }
    if (url.startsWith("/api/spawn?")) {
      return { ok: true, json: async () => ({ dirs: ["/repo"], cwd: "/repo", cwdExists: true, spawnTransport: "structured", imageInput: { claude: imageCapability, codex: imageCapability } }) } as Response;
    }
    if (url === "/api/accounts") return { ok: true, json: async () => catalog } as Response;
    if (url === "/api/roles") return { ok: false, json: async () => ({}) } as Response;
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
}

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function mount(draftId: string): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(<DraftAgentPane draftId={draftId} project="proj" files={[]} onClose={() => {}} onSpawned={() => {}} />));
  return host as unknown as HTMLElement;
}

function accountSelect(host: HTMLElement, engine: "Claude" | "Codex"): HTMLSelectElement {
  const select = host.querySelector(`select[aria-label="${engine} account for this launch"]`) as HTMLSelectElement | null;
  expect(select).toBeTruthy();
  return select!;
}

function reactProps<T>(element: Element): T {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, T>)[key]!;
}

function chooseAccount(select: HTMLSelectElement, id: string): void {
  select.value = id;
  flushSync(() => select.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event));
}

async function launch(host: HTMLElement, prompt: string): Promise<void> {
  const textarea = host.querySelector("textarea")!;
  const props = reactProps<{ onChange: (event: unknown) => void }>(textarea);
  flushSync(() => props.onChange({ target: { value: prompt } }));
  flushSync(() => host.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  await settle();
}

test("a Claude draft lists stored profiles, marks the active default, disables signed-out ones, and launches on the chosen account", async () => {
  const posts: Record<string, unknown>[] = [];
  installFetch(posts);
  const host = mount("claude-account-draft");
  await settle();

  const select = accountSelect(host, "Claude");
  expect(select.value).toBe("anna");
  const options = [...select.querySelectorAll("option")];
  expect(options.map((option) => option.textContent)).toEqual(["anna · active", "bob", "carol · needs sign-in"]);
  expect(options.map((option) => option.disabled)).toEqual([false, false, true]);

  chooseAccount(select, "bob");
  await launch(host, "Run on the second profile");

  expect(posts).toHaveLength(1);
  expect(posts[0]!.engine).toBe("claude");
  expect(posts[0]!.accountId).toBe("bob");
});

test("flipping the engine re-defaults the launch account to the target engine's active profile", async () => {
  const posts: Record<string, unknown>[] = [];
  installFetch(posts);
  const host = mount("engine-flip-draft");
  await settle();

  chooseAccount(accountSelect(host, "Claude"), "bob");
  const codexRadio = [...host.querySelectorAll('[role="radio"]')].find((button) => button.textContent === "Codex") as HTMLButtonElement;
  flushSync(() => codexRadio.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await settle();

  const select = accountSelect(host, "Codex");
  expect(select.value).toBe("terra");
  expect([...select.querySelectorAll("option")].map((option) => option.textContent)).toEqual(["terra · active"]);

  await launch(host, "Codex launch after the flip");
  expect(posts).toHaveLength(1);
  expect(posts[0]!.engine).toBe("codex");
  expect(posts[0]!.accountId).toBe("terra");
});

test("the ukrainian locale localizes the default and sign-in markers", async () => {
  setLocale("uk");
  const posts: Record<string, unknown>[] = [];
  installFetch(posts);
  const host = mount("uk-account-draft");
  await settle();

  const select = host.querySelector('select[aria-label="Обліковий запис Claude для цього запуску"]') as HTMLSelectElement | null;
  expect(select).toBeTruthy();
  const texts = [...select!.querySelectorAll("option")].map((option) => option.textContent);
  expect(texts).toContain("anna · активний");
  expect(texts).toContain("carol · потрібен вхід");
});
