import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";

import { setLocale } from "@/lib/i18n";
import type { RuntimeLiveTurnItem, RuntimeLiveTurnItemPhase } from "@/lib/runtime/liveTurn";
import { advanceMdStream, createMdStream, mdBlocks, type MdStreamState } from "@/components/feed/markdown";

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

test("only the line still being written is volatile: the boundary is its start", () => {
  /* Everything behind the boundary has been consumed into nodes, so a delta can
     never reach back into it — including inside an open construct. */
  const stream = createMdStream();
  for (let end = 1; end <= SAMPLE.length; end++) {
    const text = SAMPLE.slice(0, end);
    advanceMdStream(stream, text, true);
    expect(stream.stableChars).toBe(text.lastIndexOf("\n") + 1);
  }
});

/** The chars the next advance will have to look at. */
function pending(stream: MdStreamState, text: string): number {
  return text.length - stream.stableChars;
}

/** Streams `body` in `step`-sized deltas, returning the worst per-delta scan. */
function worstScan(stream: MdStreamState, body: string, step: number): number {
  let worst = 0;
  for (let end = 1; end <= body.length; end += step) {
    const text = body.slice(0, end);
    worst = Math.max(worst, pending(stream, text));
    advanceMdStream(stream, text, true);
  }
  return worst;
}

test("per-delta work stays proportional to the delta, not to the accumulated prose", () => {
  const body = Array.from(
    { length: 400 },
    (_, i) => `line ${i} with **bold** and a [link](https://example.com/${i}).`,
  ).join("\n");
  expect(body.length).toBeGreaterThan(20_000);

  const stream = createMdStream();
  const worst = worstScan(stream, body, 37);
  const tree = advanceMdStream(stream, body, false);
  /* One volatile line plus the delta that just arrived — never the 20k behind it. */
  expect(worst).toBeLessThan(256);
  expect(stream.stableLines).toBe(400);

  const { host, root } = mount();
  paint(root, <div className="whitespace-pre-wrap">{tree}</div>);
  expect((host.firstElementChild as HTMLElement).innerHTML).toBe(settledHtml(body));
});

test("a long OPEN code fence does not re-scan itself on every delta", () => {
  /* The case that matters most here: an agent streaming a patch. Freezing the
     boundary at the fence's opening line made every token re-read the whole
     block — 19 KB scanned per delta by the end. */
  const body = [
    "Patch:",
    "",
    "```ts",
    ...Array.from({ length: 900 }, (_, i) => `const line${i} = ${i};`),
    "```",
  ].join("\n");
  expect(body.length).toBeGreaterThan(18_000);

  const stream = createMdStream();
  const worst = worstScan(stream, body, 13);
  const tree = advanceMdStream(stream, body, false);
  expect(worst).toBeLessThan(64);
  expect(stream.stableLines).toBe(904);

  const { host, root } = mount();
  paint(root, <div className="whitespace-pre-wrap">{tree}</div>);
  expect((host.firstElementChild as HTMLElement).innerHTML).toBe(settledHtml(body));
});

test("a long OPEN table does not re-scan itself on every delta", () => {
  const body = [
    "| step | result |",
    "| --- | --- |",
    ...Array.from({ length: 300 }, (_, i) => `| step ${i} | ok ${i} |`),
  ].join("\n");

  const stream = createMdStream();
  const worst = worstScan(stream, body, 11);
  const tree = advanceMdStream(stream, body, false);
  expect(worst).toBeLessThan(64);
  expect(stream.stableLines).toBe(302);

  const { host, root } = mount();
  paint(root, <div className="whitespace-pre-wrap">{tree}</div>);
  expect((host.firstElementChild as HTMLElement).innerHTML).toBe(settledHtml(body));
});

test("a line consumed by an earlier delta is never consumed again", () => {
  const lines = Array.from({ length: 600 }, (_, i) => `line ${i} with **bold** text`);
  const body = lines.join("\n");
  const stream = createMdStream();
  for (let end = 1; end <= body.length; end += 3) advanceMdStream(stream, body.slice(0, end), true);
  advanceMdStream(stream, body, true);
  expect(stream.stableLines).toBe(lines.length - 1);
  /* The echo settles the last, still-volatile line — and nothing before it. */
  advanceMdStream(stream, body, false);
  expect(stream.stableLines).toBe(lines.length);
});

test("a block already on screen is not remounted when it settles", () => {
  const { host, root } = mount();
  const table = ["Here:", "", "| col | val |", "| --- | --- |", "| a | 1 |"];
  paint(root, <LiveTurnRows items={[item([...table, "| b"].join("\n"), "streaming")]} />);
  const painted = liveRow(host).querySelector("table");
  expect(painted).not.toBeNull();

  /* The run ends: the same table, in the same place, must survive the settling. */
  paint(root, <LiveTurnRows items={[item([...table, "| b | 2 |", "", "done"].join("\n"), "streaming")]} />);
  expect(liveRow(host).querySelector("table")).toBe(painted);
  paint(root, <LiveTurnRows items={[item([...table, "| b | 2 |", "", "done"].join("\n"), "awaiting-echo")]} />);
  expect(liveRow(host).querySelector("table")).toBe(painted);

  /* Same for a code block first shown when the message stopped on its fence. */
  const fence = ["Patch:", "", "```", "const x = 1;", "```"];
  paint(root, <LiveTurnRows items={[item(fence.join("\n"), "streaming")]} />);
  const pre = liveRow(host).querySelector("pre");
  expect(pre).not.toBeNull();
  paint(root, <LiveTurnRows items={[item([...fence, "", "done"].join("\n"), "awaiting-echo")]} />);
  expect(liveRow(host).querySelector("pre")).toBe(pre);
});

test("a boundary closer to the start than the anchor window still recognises the message", () => {
  /* A short opening line followed by a long paragraph: the boundary sits inside
     the window the cache compares, and a message must not be re-parsed from
     scratch just because it has not produced 128 chars of settled text yet. */
  const { host, root } = mount();
  const head = "Note **one**\n";
  paint(root, <LiveTurnRows items={[item(`${head}and then a much longer paragraph `, "streaming")]} />);
  const bold = liveRow(host).querySelector("b");
  expect(bold).not.toBeNull();
  let tail = "and then a much longer paragraph ";
  for (let delta = 0; delta < 12; delta++) {
    tail += "that keeps on going and going ";
    paint(root, <LiveTurnRows items={[item(head + tail, "streaming")]} />);
  }
  expect(head.length + tail.length).toBeGreaterThan(300);
  expect(liveRow(host).querySelector("b")).toBe(bold);
});

test("the consumed-line count stays exact across runs and a trim", () => {
  const lines = [
    ...Array.from({ length: 60 }, (_, i) => `line ${i} with **bold** text`),
    "| col | val |",
    "| --- | --- |",
    "| a | 1 |",
    "",
    "```ts",
    "const x = 1;",
    "```",
    ...Array.from({ length: 60 }, (_, i) => `tail ${i}`),
  ];
  const body = lines.join("\n");
  const stream = createMdStream();
  advanceMdStream(stream, body, true);
  expect(stream.stableLines).toBe(lines.length - 1);

  const trimmed = body.slice(700);
  advanceMdStream(stream, trimmed, true);
  expect(stream.stableLines).toBe(trimmed.split("\n").length - 1);
});

test("a head-trimmed projection keeps what it has already rendered", () => {
  /* Past its 64 KiB bound the projection drops chars off the front on every
     delta. Re-reading the whole window each time is what makes the longest
     answers crawl, so the shift is followed instead: what the trim did not
     reach stays exactly as it is, down to the DOM nodes on screen. */
  const full = Array.from({ length: 400 }, (_, i) => `line ${i} with **bold** text`).join("\n");
  const { host, root } = mount();
  paint(root, <LiveTurnRows items={[item(full, "streaming")]} />);
  const deep = liveRow(host).querySelectorAll("b")[350];
  expect(deep).toBeDefined();

  const trimmed = full.slice(600);
  paint(root, <LiveTurnRows items={[item(trimmed, "streaming")]} />);
  expect(liveRow(host).contains(deep)).toBe(true);

  paint(root, <LiveTurnRows items={[item(trimmed, "awaiting-echo")]} />);
  expect(liveRow(host).contains(deep)).toBe(true);
  expect(liveRow(host).innerHTML).toBe(settledHtml(trimmed));
});
