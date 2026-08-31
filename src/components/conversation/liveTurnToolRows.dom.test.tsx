import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { setLocale } from "@/lib/i18n";
import type { RuntimeLiveTurnItem } from "@/lib/runtime/liveTurn";

import { LiveTurnRows } from "./LiveTurnRows";

/**
 * Issue #1100: tool calls projected from the structured host render as compact
 * rows inside the live turn, interleaved with prose in response order, in the
 * same quiet ToolLine grammar the canonical transcript row uses (glyph ·
 * summary · non-ok status · time) — so the row does not change appearance when
 * the transcript echo replaces it.
 */

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
});
setLocale("en");

const roots = new Set<Root>();
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  document.body.replaceChildren();
});

function mount(items: RuntimeLiveTurnItem[]): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => { root.render(<LiveTurnRows items={items} />); });
  return host;
}

const AT = "2026-08-23T08:30:01.000Z";

test("tool rows interleave with prose in response order and carry the call's status", () => {
  const host = mount([
    { itemId: "uuid-1", text: "Checking the tree first.", phase: "awaiting-echo", startedAt: AT, completedAt: AT },
    {
      itemId: "toolu_status", text: "", phase: "awaiting-echo", startedAt: AT, completedAt: null,
      tool: { name: "Bash", engine: "claude", status: "run", args: { command: "git status --short", description: "tree" } },
    },
    {
      itemId: "toolu_read", text: "", phase: "awaiting-echo", startedAt: AT, completedAt: AT,
      tool: { name: "Read", engine: "claude", status: "err", args: { file_path: "/repo/src/missing.ts" } },
    },
    {
      itemId: "call_ls", text: "", phase: "awaiting-echo", startedAt: AT, completedAt: "2026-08-23T08:30:01.750Z",
      tool: { name: "shell", engine: "codex", status: "ok", args: { cmd: "ls -la", workdir: "/repo" } },
    },
    { itemId: null, text: "Now the fix", phase: "streaming", startedAt: AT, completedAt: null },
  ]);
  const rows = [...host.querySelectorAll<HTMLElement>("[data-live-turn]")];
  expect(rows.map((row) => row.dataset.liveTool ?? "prose")).toEqual(["prose", "Bash", "Read", "shell", "prose"]);
  expect(rows.map((row) => row.dataset.liveTurnItemId)).toEqual(["uuid-1", "toolu_status", "toolu_read", "call_ls", undefined]);

  const running = rows[1]!;
  expect(running.dataset.liveToolStatus).toBe("run");
  expect(running.textContent).toContain("git status --short");
  expect(running.textContent).toContain("executing…");
  expect(running.className).not.toContain("border-danger");

  const failed = rows[2]!;
  expect(failed.dataset.liveToolStatus).toBe("err");
  expect(failed.textContent).toContain("missing.ts");
  expect(failed.textContent).toContain("error");
  expect(failed.className).toContain("border-danger");

  /* A settled call reads quietly: summary and time, no status label. */
  const settled = rows[3]!;
  expect(settled.dataset.liveToolStatus).toBe("ok");
  expect(settled.textContent).toContain("ls -la");
  expect(settled.textContent).not.toContain("executing");
  expect(settled.textContent).not.toContain("error");
  expect(settled.textContent).toContain("750ms");

  /* Prose still streams with its caret at the very end of the turn. */
  expect(rows[4]!.textContent).toContain("Now the fix");
  expect(rows[4]!.querySelector(".animate-pulse")).not.toBeNull();
  /* Tool rows sit at the feed's shared chrome indent, like the canonical ToolCard. */
  for (const row of rows.slice(1, 4)) expect(row.className).toContain("ml-9");
});

test("a Codex file change reads like its canonical apply_patch row: the touched files", () => {
  const host = mount([
    {
      itemId: "call_patch", text: "", phase: "awaiting-echo", startedAt: AT, completedAt: AT,
      tool: { name: "apply_patch", engine: "codex", status: "ok", args: { input: "*** Begin Patch\n*** Update File: src/lib/a.ts\n*** End Patch" } },
    },
  ]);
  const row = host.querySelector<HTMLElement>("[data-live-tool]")!;
  expect(row.textContent).toContain("a.ts");
});

test("a tool row whose arguments were bounded away still names the tool and says so", () => {
  const host = mount([
    {
      itemId: "toolu_old", text: "", phase: "awaiting-echo", startedAt: AT, completedAt: AT,
      tool: { name: "Grep", engine: "claude", status: "ok", args: {}, argsOmitted: true },
    },
  ]);
  const row = host.querySelector<HTMLElement>("[data-live-tool]")!;
  expect(row.dataset.liveTool).toBe("Grep");
  expect(row.textContent).toContain("arguments omitted");
});

test("a call whose result the journal's bound dropped reads as finished with its outcome omitted: no spinner, no check, no error styling", () => {
  const host = mount([
    {
      itemId: "toolu_dropped", text: "", phase: "awaiting-echo", startedAt: AT, completedAt: AT,
      tool: { name: "Bash", engine: "claude", status: "unknown", args: { command: "bun run build" } },
    },
  ]);
  const row = host.querySelector<HTMLElement>("[data-live-tool]")!;
  expect(row.dataset.liveToolStatus).toBe("unknown");
  expect(row.textContent).toContain("bun run build");
  expect(row.textContent).toContain("outcome omitted");
  expect(row.textContent).not.toContain("executing");
  expect(row.textContent).not.toContain("error");
  expect(row.querySelector(".animate-spin")).toBeNull();
  expect(row.className).not.toContain("border-danger");
});
