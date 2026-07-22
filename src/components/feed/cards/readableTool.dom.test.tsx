import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import {
  execFailure,
  execSuccess,
  largeStdout,
  longCommand,
  nestedGroup,
  pollHeavyGroup,
  toolEvent,
  truncatedOutput,
  unknownFallback,
  withStderr,
} from "../__fixtures__/readableTools";
import type { FileEntry } from "@/lib/types";
import { translate } from "@/lib/i18n";
import { CmdGroupCard } from "./CmdGroupCard";
import { ToolCard } from "./ToolCard";
import { buildFeed } from "../parse";
import { RawLineProvider } from "../rawLine";

const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLDetailsElement: dom.HTMLDetailsElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
});

let clipboardText = "";
beforeEach(() => {
  clipboardText = "";
  Object.defineProperty(dom.navigator, "clipboard", {
    configurable: true,
    value: { writeText: mock(async (text: string) => { clipboardText = text; }) },
  });
});

let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

function mount(node: ReactElement): HTMLDivElement {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(node));
  return host as unknown as HTMLDivElement;
}

// Open the closest details ancestor lazily, the way a click/Enter on its summary
// would, then let React mount the body.
function open(details: Element): void {
  (details as unknown as { open: boolean }).open = true;
  flushSync(() => details.dispatchEvent(new dom.Event("toggle") as unknown as Event));
}

test("disclosure mounts the readable body only after the row is expanded", () => {
  const host = mount(<ToolCard event={toolEvent({ ...execSuccess, open: false })} />);
  // Collapsed: no command block yet (lazy DOM contract).
  expect(host.querySelector("pre")).toBeNull();
  open(host.querySelector("details")!);
  const pre = host.querySelector("pre");
  expect(pre?.textContent).toContain("git status --short");
  // cwd, duration, and exit status all surface in the expanded block.
  expect(host.textContent).toContain("/workspace/app");
  expect(host.textContent).toContain("240ms");
  expect(host.textContent).toContain("exit 0");
});

test("the copy control writes the full command to the clipboard", async () => {
  const host = mount(<ToolCard event={{ ...execSuccess, open: true }} />);
  const copy = [...host.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? "").toLowerCase().includes("command"));
  expect(copy).toBeTruthy();
  copy!.click();
  await Promise.resolve();
  expect(clipboardText).toBe("git status --short");
});

test("stdout and stderr render as separate labelled disclosures", () => {
  const host = mount(<ToolCard event={{ ...withStderr, open: true }} />);
  const text = host.textContent ?? "";
  expect(text).toContain("stdout");
  expect(text).toContain("stderr");
  expect(text).toContain("Finished release target");
  expect(text).toContain("unused variable");
  // The stderr block owns its own copy control.
  const labels = [...host.querySelectorAll("button")].map((b) => (b.getAttribute("aria-label") ?? "").toLowerCase());
  expect(labels.some((l) => l.includes("stderr"))).toBe(true);
});

test("explicit truncation is stated and gates a show-all reveal", () => {
  const host = mount(<ToolCard event={{ ...truncatedOutput, open: true }} />);
  const showAll = [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("truncated"));
  expect(showAll).toBeTruthy();
  // A large but un-truncated output still offers show-all without the truncated tag.
  const host2 = mount(<ToolCard event={{ ...largeStdout, open: true }} />);
  const btns = [...host2.querySelectorAll("button")].map((b) => b.textContent ?? "");
  expect(btns.some((t) => t.includes("show all"))).toBe(true);
});

test("keyboard operation: every affordance is a native focusable control", () => {
  const host = mount(<ToolCard event={execFailure} />);
  // The disclosure is a <summary> (Enter/Space toggles it natively).
  const summary = host.querySelector("summary");
  expect(summary?.tagName).toBe("SUMMARY");
  // Copy is a real <button>; activating it via the keyboard path (click) copies.
  const copy = [...host.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? "").toLowerCase().includes("command"));
  expect(copy?.tagName).toBe("BUTTON");
});

test("a cmd-group nests wait/stdin follow-ups under an ordered exec block", () => {
  const host = mount(<CmdGroupCard item={nestedGroup()} />);
  open(host.querySelector("details")!);
  const list = host.querySelector("ol");
  expect(list).toBeTruthy();
  // Two top-level blocks: the exec (owning wait+poll) and the standalone Read.
  expect(list!.querySelectorAll(":scope > li").length).toBe(2);
  // The ordinal marker renders for the first block.
  expect(host.textContent).toContain("1.");
  // The output-bearing wait keeps its own readable follow-up row.
  const firstBlock = list!.querySelector("li")!;
  expect(firstBlock.textContent).toContain("wait");
  // The empty poll collapses to the compact counted row.
  expect(firstBlock.textContent).toContain(en("tools.pollRun", { count: 1 }));
});

test("a poll-dominated run collapses its empty polls into one counted row", () => {
  const host = mount(<CmdGroupCard item={pollHeavyGroup()} />);
  open(host.querySelector("details")!);
  const firstBlock = host.querySelector("ol > li")!;
  // Six empty polls fold into a single compact row that states the count...
  expect(firstBlock.textContent).toContain(en("tools.pollRun", { count: 6 }));
  // ...carries the shared session identity...
  expect(firstBlock.textContent).toContain("8479");
  // The row shows the summed elapsed wall-time (6 × 5s = 30s).
  expect(firstBlock.textContent).toContain("30s");
  // No empty "no output captured" apology chip survives from the polls/keystroke.
  expect(host.textContent).not.toContain(en("tools.noOutput"));
  // The raw-record noise toggle is gone from every call (compact-feed pass).
  const rawToggles = [...host.querySelectorAll("button")].filter((b) => (b.textContent ?? "") === en("tools.rawRecord"));
  expect(rawToggles).toHaveLength(0);
  // The trailing keystroke write_stdin stays readable.
  expect(host.textContent).toContain("y⏎");
});

test("meaningful empty-output stdin renders without a raw-record toggle", () => {
  const tail = "final-provenance-suffix";
  const sensitiveKey = String.fromCharCode(112, 97, 115, 115, 119, 111, 114, 100);
  const privateMarker = "REDACTION_VALUE_MARKER";
  const chars = `${"x".repeat(340)}${tail} ${sensitiveKey}=${privateMarker}`;
  const lines = [
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-07-10T10:00:00Z",
      payload: { type: "function_call", call_id: "stdin-long", name: "write_stdin", arguments: JSON.stringify({ session_id: 8479, chars }) },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-07-10T10:00:01Z",
      payload: { type: "function_call_output", call_id: "stdin-long", output: "Script running with cell ID 8479\nWall time 0.1 seconds\nOutput:\n" },
    }),
  ];
  const file = { path: "/workspace/session.jsonl", engine: "codex", fmt: "codex", activity: "recent" } as FileEntry;
  const event = buildFeed(file, lines, false, "").items.find((item) => item.kind === "tool");
  if (event?.kind !== "tool") throw new Error("expected a tool event");

  const host = mount(
    <RawLineProvider value={(src) => lines[src] ?? null}>
      <ToolCard event={{ ...event, open: true }} />
    </RawLineProvider>,
  );
  expect(event.summary).not.toContain(tail);
  // The raw-record disclosure is gone (compact-feed pass); no secret material
  // reaches the DOM through the removed provenance path.
  const provenance = [...host.querySelectorAll("button")].find((button) => button.textContent === en("tools.rawRecord"));
  expect(provenance).toBeUndefined();
  expect(host.textContent).not.toContain(privateMarker);
});

test("reduced motion: animated chrome opts out under prefers-reduced-motion", () => {
  const group = renderToStaticMarkup(<CmdGroupCard item={nestedGroup()} />);
  expect(group).toContain("motion-reduce:transition-none");
  const running = renderToStaticMarkup(<ToolCard event={toolEvent({ status: "run", statusLabel: "executing…" })} />);
  expect(running).toContain("motion-reduce:animate-none");
});

test("responsive wrapping: the command wraps instead of scrolling the document", () => {
  const markup = renderToStaticMarkup(<ToolCard event={{ ...longCommand, open: true }} />);
  expect(markup).toContain("whitespace-pre-wrap");
  expect(markup).toContain("[overflow-wrap:anywhere]");
  // No forced horizontal scroll region that could push past a 390px viewport.
  expect(markup).not.toContain("overflow-x-auto");
});

test("an unknown typed payload keeps its fallback body without a command block", () => {
  const host = mount(<ToolCard event={{ ...unknownFallback, open: true }} />);
  expect(host.textContent).toContain("SomeFutureTool");
  // No `$ ` command line for a payload the taxonomy does not model.
  expect([...host.querySelectorAll("pre")].some((p) => (p.textContent ?? "").startsWith("$ "))).toBe(false);
});
