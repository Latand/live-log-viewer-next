import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { FlowDialog } from "./FlowDialog";
import type { FileEntry } from "@/lib/types";

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement });
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; document.body.replaceChildren(); });

test.each(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-luna"])("manual flow role offers %s supported tiers", async (model) => {
  const role = { engine: "codex", model, effort: "max" };
  globalThis.fetch = (async () => ({ json: async () => ({ presets: [{ name: "saved", implementer: role, reviewer: role }] }) })) as unknown as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(<FlowDialog file={{ path: "/example.jsonl" } as FileEntry} onClose={() => {}} />));
    await Bun.sleep(10);
    const button = host.querySelector('button[aria-expanded]')!;
    flushSync(() => button.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
    const selects = host.querySelectorAll('select[aria-label^="Reasoning effort:"]');
    expect(selects.length).toBe(2);
    for (const select of selects) {
      expect((select as HTMLSelectElement).value).toBe("max");
      expect(Boolean(select.querySelector('option[value="ultra"]'))).toBe(model !== "gpt-5.6-luna");
    }
  } finally { flushSync(() => root.unmount()); }
});


test.each(["ultra", "max"])("manual role reconciles Astra/%s to Luna in the submitted payload", async (effort) => {
  const role = { engine: "codex", model: "gpt-6-astra", effort };
  const posts: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") posts.push(JSON.parse(String(init.body)));
    return { ok: true, json: async () => ({ presets: [{ name: "saved", implementer: role, reviewer: role }] }) };
  }) as unknown as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(<FlowDialog file={{ path: "/example.jsonl" } as FileEntry} onClose={() => {}} />));
    await Bun.sleep(10);
    flushSync(() => (host.querySelector('button[aria-expanded]') as HTMLButtonElement).click());
    const model = host.querySelector('input[list]') as HTMLInputElement;
    // happy-dom lacks React's text-input value tracker; use the input's handler.
    const propsKey = Object.keys(model).find((key) => key.startsWith("__reactProps$"))!;
    const props = (model as unknown as Record<string, { onChange: (event: unknown) => void }>)[propsKey]!;
    flushSync(() => props.onChange({ target: { value: "gpt-5.6-luna" } }));
    expect(model.value).toBe("gpt-5.6-luna");
    const expected = effort === "ultra" ? null : effort;
    expect((host.querySelector('select[aria-label^="Reasoning effort:"]') as HTMLSelectElement).value).toBe(expected ?? "");
    flushSync(() => [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Start"))!.click());
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ roles: { implementer: { model: "gpt-5.6-luna", effort: expected } } });
  } finally { flushSync(() => root.unmount()); }
});
