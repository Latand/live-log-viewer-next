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
