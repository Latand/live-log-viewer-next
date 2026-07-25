import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";

import { setLocale } from "@/lib/i18n";
import type { RuntimeLiveTurnItem, RuntimeLiveTurnItemPhase } from "@/lib/runtime/liveTurn";
import { advanceMdStream, createMdStream, mdBlocks, settledLineCount } from "@/components/feed/markdown";

import { LiveTurnRows } from "./LiveTurnRows";

/**
 * Issue #676: a live turn row must render markdown through the same grammar as
 * the transcript row that replaces it, so a message does not visibly change
 * appearance when the echo lands — and the still-unwritten tail must degrade to
 * readable text instead of guessing at a construct whose closer has not arrived.
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

const SAMPLE = [
  "Here is the **bold** answer.",
  "",
  "| col | val |",
  "| --- | --- |",
  "| a | 1 |",
  "| b | 2 |",
  "",
  "```ts",
  "const x = 1;",
  "```",
  "",
  "> quoted tail",
].join("\n");

function item(text: string, phase: RuntimeLiveTurnItemPhase, extra: Partial<RuntimeLiveTurnItem> = {}): RuntimeLiveTurnItem {
  return { itemId: "item-1", text, phase, startedAt: null, completedAt: null, ...extra };
}

function mount(): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.append(host);
  return { host, root: createRoot(host) };
}

function paint(root: Root, node: ReactNode): void {
  flushSync(() => { root.render(node); });
}

function liveRow(host: HTMLElement): HTMLElement {
  const row = host.querySelector("[data-live-turn]");
  if (!row) throw new Error("no live turn row rendered");
  return row as HTMLElement;
}

/** The settled counterpart: the transcript row's markdown body, same renderer. */
function settledHtml(text: string): string {
  const { host, root } = mount();
  paint(root, <div className="whitespace-pre-wrap">{mdBlocks(text)}</div>);
  return (host.firstElementChild as HTMLElement).innerHTML;
}

/** Feed a message in `step`-sized deltas, as the runtime projection does. */
function stream(root: Root, text: string, step: number): void {
  for (let end = step; end < text.length; end += step) {
    paint(root, <LiveTurnRows items={[item(text.slice(0, end), "streaming")]} />);
  }
  paint(root, <LiveTurnRows items={[item(text, "streaming")]} />);
}

afterEach(() => {
  document.body.replaceChildren();
});

test("a settled live row renders the same markdown as its transcript counterpart", () => {
  const { host, root } = mount();
  paint(root, <LiveTurnRows items={[item(SAMPLE, "awaiting-echo")]} />);
  expect(liveRow(host).innerHTML).toBe(settledHtml(SAMPLE));
  expect(liveRow(host).querySelector("b")?.textContent).toBe("bold");
  expect(liveRow(host).querySelectorAll("table")).toHaveLength(1);
  expect(liveRow(host).querySelector("pre")?.textContent).toBe("const x = 1;");
});

test("streaming a message delta by delta lands on exactly the settled rendering", () => {
  const { host, root } = mount();
  stream(root, SAMPLE, 7);
  paint(root, <LiveTurnRows items={[item(SAMPLE, "awaiting-echo")]} />);
  expect(liveRow(host).innerHTML).toBe(settledHtml(SAMPLE));
});

test("markdown already behind the writing frontier renders while the message streams", () => {
  const { host, root } = mount();
  paint(root, <LiveTurnRows items={[item("Here is the **bold** answer.\nstill writ", "streaming")]} />);
  const row = liveRow(host);
  expect(row.querySelector("b")?.textContent).toBe("bold");
  expect(row.textContent).toContain("still writ");
});

test("a table's first row waits for the separator that decides the header", () => {
  const { host, root } = mount();
  /* Rendering one row early would print it as a body row and then move it into
     the header when the separator lands — the flicker this must not do. */
  stream(root, "Here it is:\n\n| col | val |\n| ---", 9);
  const row = liveRow(host);
  expect(row.querySelector("table")).toBeNull();
  expect(row.textContent).toContain("| col | val |");
  expect(row.textContent).toContain("| ---");
});

test("a half-written table row stays readable text below the rows that closed", () => {
  const { host, root } = mount();
  const partial = "Here it is:\n\n| col | val |\n| --- | --- |\n| a | 1";
  stream(root, partial, 9);
  const row = liveRow(host);
  const streamingTable = row.querySelector("table");
  expect(streamingTable!.querySelector("th")?.textContent).toBe("col");
  expect(streamingTable!.querySelectorAll("tbody tr")).toHaveLength(0);
  expect(row.textContent).toContain("| a | 1");
  expect(row.textContent).not.toContain("| col | val |");

  paint(root, <LiveTurnRows items={[item(`${partial} |\n\ndone`, "streaming")]} />);
  const table = liveRow(host).querySelector("table");
  expect(table!.querySelector("th")?.textContent).toBe("col");
  expect(table!.querySelectorAll("tbody tr")).toHaveLength(1);
  expect(liveRow(host).textContent).not.toContain("| a | 1 |");
});

test("an unclosed code fence renders verbatim instead of swallowing the tail", () => {
  const { host, root } = mount();
  const partial = "Patch:\n\n```ts\nconst x = 1;";
  const closed = [partial, "```", "", "done"].join("\n");
  stream(root, partial, 6);
  const row = liveRow(host);
  expect(row.querySelector("pre")).toBeNull();
  expect(row.textContent).toContain("```ts");
  expect(row.textContent).toContain("const x = 1;");

  paint(root, <LiveTurnRows items={[item(closed, "streaming")]} />);
  expect(liveRow(host).querySelector("pre")?.textContent).toBe("const x = 1;");
  expect(liveRow(host).textContent).not.toContain("```");
});

test("a message that ends on its closing fence renders the block right away", () => {
  const { host, root } = mount();
  const ends = ["Patch:", "", "```ts", "const x = 1;", "```"].join("\n");
  stream(root, ends, 6);
  expect(liveRow(host).querySelector("pre")?.textContent).toBe("const x = 1;");
  expect(liveRow(host).textContent).not.toContain("```");

  /* Settling it changes nothing but the caret. */
  paint(root, <LiveTurnRows items={[item(ends, "awaiting-echo")]} />);
  expect(liveRow(host).innerHTML).toBe(settledHtml(ends));

  /* A fence that has NOT closed still degrades to readable text. */
  paint(root, <LiveTurnRows items={[item("Patch:\n\n```ts\nconst x = 1;", "streaming")]} />);
  expect(liveRow(host).querySelector("pre")).toBeNull();
  expect(liveRow(host).textContent).toContain("```ts");
});

test("a closing fence the next delta reopens goes back to text, separator intact", () => {
  const { host, root } = mount();
  const open = ["Patch:", "", "```ts", "const x = 1;"];
  paint(root, <LiveTurnRows items={[item([...open, "```"].join("\n"), "streaming")]} />);
  expect(liveRow(host).querySelector("pre")).not.toBeNull();

  /* That line was not a closing fence after all: the block goes back to text,
     and the separator it had shed has to come back with it. */
  const reopened = [...open, "```json"].join("\n");
  paint(root, <LiveTurnRows items={[item(reopened, "streaming")]} />);
  expect(liveRow(host).querySelector("pre")).toBeNull();
  expect(liveRow(host).textContent).toContain(reopened);
});

test("an unterminated bold run stays literal until its closer arrives", () => {
  const { host, root } = mount();
  paint(root, <LiveTurnRows items={[item("Result: **bol", "streaming")]} />);
  expect(liveRow(host).querySelector("b")).toBeNull();
  expect(liveRow(host).textContent).toContain("**bol");

  paint(root, <LiveTurnRows items={[item("Result: **bold** ok", "streaming")]} />);
  expect(liveRow(host).querySelector("b")?.textContent).toBe("bold");
});

test("the streaming caret and the omission notices survive the markdown pass", () => {
  const { host, root } = mount();
  paint(
    root,
    <LiveTurnRows
      items={[
        item("| col |\n| --- |\n| a |\n\nEarlier **items** folded.", "streaming", { omittedItems: 3, omittedChars: 40 }),
      ]}
    />,
  );
  const row = liveRow(host);
  expect(row.querySelector("[data-live-turn-omitted-items]")?.textContent).toContain("3");
  expect(row.querySelector(".animate-pulse")).not.toBeNull();
  expect(row.querySelector("table")).not.toBeNull();
  expect(row.querySelector("b")?.textContent).toBe("items");

  paint(root, <LiveTurnRows items={[item("Only chars dropped.", "streaming", { omittedChars: 12 })]} />);
  expect(liveRow(host).querySelector("[data-live-turn-omitted-chars]")?.textContent).toContain("12");
});

test("a completed item that rewrites its draft is re-rendered from scratch", () => {
  const { host, root } = mount();
  stream(root, "Draft **half** written\n| a | b |\n| - | - |", 5);
  /* The completion event may legitimately replace the observed stream. */
  const authoritative = "Final **answer**\n\n| x | y |\n| --- | --- |\n| 1 | 2 |";
  paint(root, <LiveTurnRows items={[item(authoritative, "awaiting-echo")]} />);
  expect(liveRow(host).innerHTML).toBe(settledHtml(authoritative));
});

test("settled lines are frozen once written: the boundary only moves forward", () => {
  const text = SAMPLE;
  let previous = 0;
  for (let end = 1; end <= text.length; end++) {
    const settled = settledLineCount(text.slice(0, end).split("\n"));
    expect(settled).toBeGreaterThanOrEqual(previous);
    previous = settled;
  }
  /* The volatile region is the open construct, never the whole document. */
  expect(settledLineCount("a\nb\nc".split("\n"))).toBe(2);
  expect(settledLineCount("a\n| x |\n| y".split("\n"))).toBe(1);
  expect(settledLineCount("a\n```ts\ncode".split("\n"))).toBe(1);
  expect(settledLineCount("a\n```ts\ncode\n```\ntail".split("\n"))).toBe(4);
});

test("per-delta work stays proportional to the delta, not to the accumulated message", () => {
  const body = Array.from(
    { length: 400 },
    (_, i) => `line ${i} with **bold** and a [link](https://example.com/${i}).`,
  ).join("\n");
  expect(body.length).toBeGreaterThan(20_000);

  const stream = createMdStream();
  let worst = 0;
  let scanned = 0;
  for (let end = 1; end <= body.length; end += 37) {
    advanceMdStream(stream, body.slice(0, end), true);
    worst = Math.max(worst, stream.scannedChars - scanned);
    scanned = stream.scannedChars;
  }
  const tree = advanceMdStream(stream, body, false);
  /* One volatile line plus the delta that just arrived — never the 20k+ behind it. */
  expect(worst).toBeLessThan(256);
  expect(stream.parsedLines).toBe(400);

  /* …and the rendering it arrived at is still the transcript pass, exactly. */
  const { host, root } = mount();
  paint(root, <div className="whitespace-pre-wrap">{tree}</div>);
  expect((host.firstElementChild as HTMLElement).innerHTML).toBe(settledHtml(body));
});

test("a long stream block-parses every line exactly once, never the whole message", () => {
  /* Re-parsing the accumulated text per delta would cost ~180k line parses for
     this message; the settled prefix is parsed once, so it costs 600. */
  const lines = Array.from({ length: 600 }, (_, i) => `line ${i} with **bold** text`);
  const body = lines.join("\n");
  const stream = createMdStream();
  for (let end = 1; end <= body.length; end += 3) {
    advanceMdStream(stream, body.slice(0, end), true);
  }
  advanceMdStream(stream, body, true);
  expect(stream.parsedLines).toBe(lines.length - 1);
  /* The echo settles the last, still-volatile line — and nothing before it. */
  advanceMdStream(stream, body, false);
  expect(stream.parsedLines).toBe(lines.length);
});

test("a fenced block that has closed is never re-parsed by later deltas", () => {
  const head = ["intro", "```ts", "const x = 1;", "```", ""].join("\n");
  const stream = createMdStream();
  advanceMdStream(stream, `${head}\n`, true);
  const afterFence = stream.parsedLines;
  expect(afterFence).toBeGreaterThan(0);
  for (const tail of ["t", "ta", "tai", "tail"]) {
    advanceMdStream(stream, `${head}\n${tail}`, true);
  }
  expect(stream.parsedLines).toBe(afterFence);
});
