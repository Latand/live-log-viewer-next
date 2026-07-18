import { afterEach, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";

import { SwitchCard } from "./SwitchCard";

/*
 * Issue #270 — the narrow switch card. Its identity row is the meter's query
 * container: the small 220px card's row (≈196px inner) sits under the 240px
 * threshold, so the bars collapse there instead of colliding with the model
 * and project chips; the large 300px card keeps them. happy-dom does not
 * evaluate container queries, so the contract is asserted structurally: the
 * row declares `@container` and the meter carries the collapse variant.
 */

const dom = new HappyWindow({ width: 1280, height: 800 });
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
});

const roots = new Set<Root>();
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
});

function mount(node: React.ReactElement): HTMLElement {
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(node));
  return host;
}

function file(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/card.jsonl", root: "claude-projects", name: "card.jsonl", project: "project",
    title: "Card conversation", engine: "claude", kind: "session", fmt: "claude", parent: null,
    mtime: 1, size: 1, activity: "idle", proc: null, pid: null,
    model: "fable", effort: "medium", pendingQuestion: null, waitingInput: null,
    ...overrides,
  } as FileEntry;
}

function card(size: "large" | "small"): HTMLElement {
  return mount(
    <SwitchCard
      file={file()}
      title="Card conversation"
      project="project"
      currentProject="project"
      descendants={0}
      statusLine=""
      size={size}
      tone="quiet"
      onOpen={() => undefined}
      onArchive={() => undefined}
    />,
  );
}

test("the card identity row is the meter's query container and the meter sits in-flow beside the chips", () => {
  for (const size of ["large", "small"] as const) {
    const host = card(size);
    const slot = host.querySelector("[data-effort-slot]") as HTMLElement;
    expect(slot).toBeTruthy();
    /* In-flow contract: a shrink-0 flex item, no transform, no overlay. */
    expect(slot.className).toContain("shrink-0");
    expect(slot.className).not.toContain("absolute");
    expect(slot.getAttribute("style") ?? "").not.toContain("transform");
    /* The collapse pair: the row declares the container, the meter the
       narrow-width variant that hides it on the small card. */
    expect(slot.className).toContain("@max-[240px]:hidden");
    expect(slot.parentElement!.className).toContain("@container");
    /* DOM (= flex) order: the meter follows the model chip. */
    expect((slot.previousElementSibling as HTMLElement)?.textContent).toBe("fable");
  }
});
