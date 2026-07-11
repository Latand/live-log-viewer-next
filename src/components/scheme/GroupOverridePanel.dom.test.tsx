import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { Flow } from "@/lib/flows/types";

import { GroupsLayer } from "./nodes";
import { GroupOverridePanel } from "./GroupOverridePanel";
import type { SchemeGroup } from "./layout";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
});

/* Capture every PATCH so the note/action a click submits can be asserted. */
const calls: Array<{ url: string; body: unknown }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: { body?: string }) => {
  calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
  return { ok: true, json: async () => ({}) };
}) as unknown as typeof fetch;

afterEach(() => {
  document.body.replaceChildren();
  calls.length = 0;
});
process.on("exit", () => { globalThis.fetch = realFetch; });

function mount(node: React.ReactElement): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(node));
  return { host, root };
}

const flowGroup: SchemeGroup = {
  key: "group::flow::f1", kind: "flow", id: "f1", hue: 210, members: ["/impl"],
  label: "Flow one", x: 100, y: 80, w: 900, h: 780,
  flow: {
    id: "f1",
    roles: { implementer: { engine: "codex", model: null, effort: null }, reviewer: { engine: "codex", model: null, effort: null } },
    roundLimit: 5,
    state: "waiting_ready",
    rounds: [],
  } as unknown as Flow,
};

test("the override panel opens in a foreground layer, not nested in a halo stacking context (issue #118 review F1)", () => {
  const { host, root } = mount(<GroupsLayer groups={[flowGroup]} interactive />);
  const chip = host.querySelector("[data-scheme-group] button") as HTMLButtonElement;
  expect(chip).toBeTruthy();
  flushSync(() => chip.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));

  const panel = host.querySelector("[data-group-override]") as HTMLElement;
  expect(panel).toBeTruthy();
  /* The panel must NOT live inside a [data-scheme-group] halo wrapper — that
     wrapper's positioning context would paint it beneath the scheme cards. */
  expect(panel.closest("[data-scheme-group]")).toBeNull();
  /* It sits in a high-z foreground container so it paints above the cards. */
  const foreground = panel.closest(".z-\\[45\\]") ?? panel.parentElement;
  expect(foreground?.className ?? "").toContain("z-[45]");

  flushSync(() => root.unmount());
  host.remove();
});

test("starting the next round from the panel submits the note via advance, not only retry (issue #118 review F2)", async () => {
  /* A waiting_ready flow: the pending action is `advance` (creates the next
     round), which is exactly the path the note must reach. The field is seeded
     from the last round's ready note, and the textarea is bound to the same
     state that the button sends. */
  const seeded: SchemeGroup = {
    ...flowGroup,
    flow: { ...flowGroup.flow!, state: "waiting_ready", rounds: [{ n: 1, readyNote: "check the retry path" }] } as unknown as Flow,
  };
  const { host, root } = mount(<GroupOverridePanel group={seeded} onClose={() => undefined} />);
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  expect(textarea.value).toBe("check the retry path");

  /* Click the pending action (waiting_ready → "Start review" → advance). */
  const start = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("Start review")) as HTMLButtonElement;
  expect(start).toBeTruthy();
  flushSync(() => start.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await Promise.resolve();

  const patch = calls.find((call) => call.url.includes("/api/flows/f1"));
  expect(patch?.body).toMatchObject({ action: "advance", note: "check the retry path" });

  flushSync(() => root.unmount());
  host.remove();
});
