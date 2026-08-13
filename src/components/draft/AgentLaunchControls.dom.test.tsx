import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { setLocale } from "@/lib/i18n";

/*
 * The SHARED launch controls (PRD #976 slice A): one module owns engine, model,
 * effort, codex speed and the stored account for every «start an agent» surface,
 * so the orchestrator panel (#977), its rotate flow (#978) and the mobile create
 * sheet (#979) cannot drift apart. What is tested here is the contract those
 * slices depend on — the invariants that tie the fields together, and the
 * per-engine account catalog.
 */

const dom = new HappyWindow();
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
  localStorage: dom.localStorage,
});

const {
  AgentLaunchControls,
  launchAccountCatalogOf,
  resolveLaunchAccountId,
  useAgentLaunchDraft,
} = await import("./AgentLaunchControls");

const catalog = {
  claude: { active: "primary", accounts: [{ id: "primary", label: "primary", authPresent: true }, { id: "spare", label: "spare", authPresent: false }] },
  codex: { active: "codex-a", accounts: [{ id: "codex-a", label: "codex-a", authPresent: true }] },
};

const realFetch = globalThis.fetch;
const roots = new Set<Root>();
beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === "/api/accounts") return { ok: true, status: 200, json: async () => catalog } as Response;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as typeof fetch;
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  dom.sessionStorage.clear();
  setLocale("en");
  globalThis.fetch = realFetch;
});

/** A host that keeps the draft in one place, like a real surface does. */
const store = new Map<string, string>();
function Harness({ onDraft }: { onDraft: (draft: ReturnType<typeof useAgentLaunchDraft>) => void }) {
  const draft = useAgentLaunchDraft({
    storage: {
      read: (name) => store.get(name) ?? "",
      write: (name, value) => {
        if (value) store.set(name, value);
        else store.delete(name);
      },
    },
    initialEngine: "claude",
    initialModel: "opus",
    initialEffort: "low",
  });
  onDraft(draft);
  return <AgentLaunchControls draft={draft} stacked />;
}

function mount(): { host: HTMLElement; draft: () => ReturnType<typeof useAgentLaunchDraft> } {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  let latest: ReturnType<typeof useAgentLaunchDraft> | null = null;
  flushSync(() => root.render(<Harness onDraft={(draft) => { latest = draft; }} />));
  return { host: host as unknown as HTMLElement, draft: () => latest! };
}

const settle = async () => {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

test("a surface's canonical configuration is the opening state, and it persists through the host", async () => {
  store.clear();
  const { draft } = mount();
  await settle();
  expect(draft().engine).toBe("claude");
  expect(draft().model).toBe("opus");
  expect(draft().effort).toBe("low");

  flushSync(() => draft().setEffort("high"));
  expect(store.get("effort")).toBe("high");
});

test("switching engines re-defaults the model, drops the other engine's account, and drops a tier it doesn't have", async () => {
  store.clear();
  const { draft } = mount();
  await settle();
  flushSync(() => draft().setEffort("max"));
  flushSync(() => draft().setAccountId("spare"));
  expect(draft().accountId).toBe("spare");

  flushSync(() => draft().setEngine("codex"));
  await settle();

  expect(draft().engine).toBe("codex");
  expect(draft().model).not.toBe("opus");
  /* «max» is a claude tier; codex falls back to the CLI default. */
  expect(draft().effort).toBe("");
  expect(draft().accountId).toBe("");
  expect(draft().launchAccountId).toBe("codex-a");
});

test("the account offered is per engine, and the value shown is the value sent", async () => {
  store.clear();
  const { host, draft } = mount();
  await settle();
  flushSync(() => undefined);

  const claudeSelect = host.querySelector('select[aria-label*="Claude"]') as HTMLSelectElement;
  expect([...claudeSelect.options].map((option) => option.value)).toEqual(["primary", "spare"]);
  /* A signed-out profile stays listed for history, but cannot be picked. */
  expect([...claudeSelect.options].map((option) => option.disabled)).toEqual([false, true]);
  expect(draft().launchAccountId).toBe("primary");

  flushSync(() => draft().setEngine("codex"));
  await settle();
  flushSync(() => undefined);
  expect(host.querySelector('select[aria-label*="Claude"]')).toBeNull();
  expect(host.querySelector('select[aria-label*="Codex"]')).not.toBeNull();
});

test("both engines' chips are offered, and the speed picker is codex-only", async () => {
  store.clear();
  const { host, draft } = mount();
  await settle();
  flushSync(() => undefined);

  expect([...host.querySelectorAll('[role="radio"]')].map((node) => node.textContent)).toEqual(["Claude", "Codex"]);
  expect(host.querySelector('select[aria-label*="Speed"]')).toBeNull();

  flushSync(() => draft().setEngine("codex"));
  await settle();
  flushSync(() => undefined);
  expect(host.querySelector('select[aria-label*="peed"]')).not.toBeNull();
});

test("an account id nobody offers falls back to the engine's active one", () => {
  const parsed = launchAccountCatalogOf(catalog);
  expect(resolveLaunchAccountId(parsed, "claude", "removed")).toBe("primary");
  expect(resolveLaunchAccountId(parsed, "claude", "spare")).toBe("spare");
  expect(resolveLaunchAccountId(parsed, "codex", "primary")).toBe("codex-a");
  expect(resolveLaunchAccountId(null, "claude", "primary")).toBe("");
});

test("a malformed accounts body hides the selector rather than breaking the draft", () => {
  const parsed = launchAccountCatalogOf({ claude: { accounts: [{ id: 5 }] }, codex: null });
  expect(parsed.claude.accounts).toEqual([]);
  expect(parsed.codex.accounts).toEqual([]);
  expect(parsed.claude.active).toBe("");
});
