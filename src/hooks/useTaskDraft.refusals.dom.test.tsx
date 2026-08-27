import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { TaskComposer } from "@/components/tasks/TaskComposer";
import { useTaskDraft } from "@/hooks/useTaskDraft";
import { MAX_INBOX_IMAGE_BYTES } from "@/lib/imagePolicy";

/*
 * Issue #1224 round-3 finding 2: the task composer re-lost what the pane
 * composer had already learned. `ComposerBar` hands EVERY file to
 * `onAttachFiles`, and the task path wrote one `setStatus` per refused file into
 * a slot that holds exactly one message — so every refusal but the last
 * vanished unnamed, which is the silent discard this issue exists to remove.
 *
 * The fix is not a second copy of the pane composer's accumulator: both
 * composers now consume ONE refusal contract (`@/lib/attachmentIntake`), and
 * these cases pin that from the outside — through the real composer, the real
 * drop handler and the real draft. Fixtures are invented names and bytes.
 */

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const DomFile = (dom as unknown as { File: typeof File }).File;

const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  File: DomFile,
  FormData: (dom as unknown as { FormData: typeof FormData }).FormData,
  Blob: (dom as unknown as { Blob: typeof Blob }).Blob,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  matchMedia: (q: string) => ({ matches: false, media: String(q), onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }),
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
const tick = async () => { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

/** An invented file of a declared size — the bytes never matter here, only
    whether the screen admits it and what the operator is told when it does not. */
function fileOf(name: string, type: string, size = 12): File {
  const file = new DomFile(["invented bytes"], name, { type });
  Object.defineProperty(file, "size", { value: size, configurable: true });
  return file;
}

function Harness() {
  const draft = useTaskDraft("orbit-api", () => {});
  return <TaskComposer draft={draft} placeholder="What needs doing?" createLabel="Create" />;
}

let roots: Root[] = [];
let uploadAttempts = 0;

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
  (dom as unknown as { matchMedia: unknown }).matchMedia = OVERRIDES.matchMedia;
});
afterAll(async () => {
  await tick();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
});
beforeEach(() => {
  dom.document.body.replaceChildren();
  roots = [];
  uploadAttempts = 0;
  dom.localStorage.clear();
});
afterEach(async () => { for (const r of roots) flushSync(() => r.unmount()); roots = []; await tick(); });

function mount(): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(<Harness />));
  roots.push(root);
  return host as unknown as HTMLElement;
}

/** Drop files on the composer's own textarea handler — the path a real drag
    takes, including the `onAttachFiles` hand-off the task composer supplies. */
function drop(host: HTMLElement, files: File[]): void {
  const textarea = host.querySelector("textarea")!;
  const key = Object.keys(textarea).find((k) => k.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onDrop(event: unknown): void }>)[key]!;
  flushSync(() => props.onDrop({ dataTransfer: { files }, preventDefault() {}, stopPropagation() {} }));
}

const statusText = (host: HTMLElement) =>
  Array.from(host.querySelectorAll('[role="status"]')).map((node) => node.textContent ?? "").join("\n");

test("round-3 finding 2: every file the task composer refuses is named, not only the last one", async () => {
  const host = mount();
  drop(host, [
    fileOf("budget.xlsx", "application/vnd.ms-excel"),
    fileOf("architecture.svg", "image/svg+xml"),
    fileOf("wallpaper.png", "image/png", MAX_INBOX_IMAGE_BYTES + 1),
  ]);
  await tick();

  /* Three refusals, one status slot. Written one at a time, only the last file
     would have a name on screen and the other two would disappear. */
  const status = statusText(host);
  expect(status).toContain("budget.xlsx");
  expect(status).toContain("architecture.svg");
  expect(status).toContain("wallpaper.png");
  /* This composer has no by-path road for a document, so it says so — the two
     files refused for the same reason are named together, once. */
  expect(status).toContain("images only");
  expect(status).toContain("too large");
});

test("round-3 finding 2: a failed upload joins the same message instead of erasing the refusals before it", async () => {
  const host = mount();
  G.fetch = async () => {
    uploadAttempts += 1;
    return {
      ok: false,
      status: 503,
      json: async () => ({ error: "the attachment store is unavailable" }),
    } as unknown as Response;
  };
  try {
    drop(host, [fileOf("notes.pdf", "application/pdf"), fileOf("diagram.png", "image/png")]);
    await tick();
    await tick();
  } finally {
    delete G.fetch;
  }

  /* The upload is the one refusal that happens after the screen, and it used to
     overwrite everything the screen had already said. Both files are named. */
  expect(uploadAttempts).toBe(1);
  const status = statusText(host);
  expect(status).toContain("notes.pdf");
  expect(status).toContain("diagram.png");
  expect(status).toContain("the attachment store is unavailable");
});

test("an accepted image still stages as a durable ref and says nothing about refusals", async () => {
  const host = mount();
  G.fetch = async () => {
    uploadAttempts += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ attachment: { id: "att-invented", name: "diagram.png", mime: "image/png", bytes: 12, sha256: "a".repeat(64) } }),
    } as unknown as Response;
  };
  try {
    drop(host, [fileOf("diagram.png", "image/png")]);
    await tick();
    await tick();
  } finally {
    delete G.fetch;
  }

  expect(uploadAttempts).toBe(1);
  expect(statusText(host)).toBe("");
  expect(host.querySelectorAll("img")).toHaveLength(1);
});
