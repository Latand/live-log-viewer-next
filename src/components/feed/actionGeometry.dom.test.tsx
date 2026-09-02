import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { translate } from "@/lib/i18n";

import { ACTION_GUTTER, ACTION_INSET_PX, ACTION_SIZE_COARSE_PX, ACTION_SIZE_FINE_PX } from "./actionStyles";
import { CodeBlock } from "./markdown";
import type { ToolEvent } from "./parse";
import { ToolBody } from "./cards/ToolCard";
import { OutputPreview } from "./cards/OutputPreview";
import { MOBILE_LAYOUT_QUERY } from "@/lib/attention/eligibility";

/*
 * Issue #698 — the resolved geometry of a feed action control, measured against
 * the gutter its body reserves, under each media state INDEPENDENTLY.
 *
 * The defect this file exists for: the control's size and the body's gutter were
 * gated by two different predicates. `CopyButton` sized its 44px tap target from
 * `useIsMobile()` — the shared VIEWPORT query (`MOBILE_LAYOUT_QUERY`) — while
 * `ACTION_GUTTER` reserves its wide gutter from the `(pointer: coarse)` POINTER
 * query. A fine pointer in a phone-sized window (a desktop window dragged narrow, a
 * split-screen pane, responsive-design mode without touch emulation) satisfied
 * one and not the other, so a 44px control stood in a 28px gutter and covered
 * 22px of the message body.
 *
 * The predecessor of this file compared `ACTION_GUTTER`'s two px literals
 * against constants declared beside them, which cannot disagree with itself and
 * so never saw any of that. Everything below is read off the elements the
 * components actually render, and the two media axes are driven separately —
 * moving them together is precisely what hid the bug.
 */

const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);

/* Tailwind's spacing step (0.25rem at the default 16px root) and the 1px
   `border` on the control — the two conversions from a class to a pixel. Every
   number derived with them is cross-checked against the shared constant it is
   supposed to equal, so a class change that outgrows a constant fails here. */
const SPACING_STEP_PX = 4;
const BORDER_PX = 1;

/* The two axes, independently switchable. */
let narrowViewport = false;
let coarsePointer = false;

const normalize = (query: string) => String(query).replace(/\s+/g, "");
const VIEWPORT_QUERY = normalize(MOBILE_LAYOUT_QUERY);
const POINTER_QUERY = normalize("(pointer: coarse)");

/** The single oracle for "does this query match right now" — consulted both by
    the components' hooks (through `matchMedia`) and by the CSS variant resolver
    below, so the two sides of the geometry are judged against one state. */
function mediaMatches(query: string): boolean {
  const q = normalize(query);
  if (q === VIEWPORT_QUERY) return narrowViewport;
  if (q === POINTER_QUERY) return coarsePointer;
  throw new Error(`unhandled media query "${query}" — add its axis to this mock rather than defaulting it to false`);
}

const dom = new Window({ url: "http://localhost/" });
const matchMediaStub = (query: string) => ({
  matches: mediaMatches(query),
  media: String(query),
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return false; },
});
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLDetailsElement: dom.HTMLDetailsElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  matchMedia: matchMediaStub,
});
/* The hooks read `window.matchMedia`, which resolves to the happy-dom window
   rather than the global override, so the stub has to live there too. */
(dom as unknown as { matchMedia: unknown }).matchMedia = matchMediaStub;

/** What the clipboard actually received, in order. */
let copied: string[] = [];
beforeEach(() => {
  narrowViewport = false;
  coarsePointer = false;
  copied = [];
  const writeText = mock(async (text: string) => { copied.push(text); });
  Object.defineProperty(dom.navigator, "clipboard", { configurable: true, value: { writeText } });
});

let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  dom.document.body.replaceChildren();
});

function mount(node: ReactElement): Element {
  const el = dom.document.createElement("div");
  dom.document.body.append(el);
  root = createRoot(el as unknown as HTMLElement);
  flushSync(() => root!.render(node));
  return el as unknown as Element;
}

function click(el: Element): void {
  flushSync(() => el.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
}

const classOf = (el: Element) => el.getAttribute("class") ?? "";

/**
 * Resolve a right-padding declaration the way a browser would under the current
 * media state: candidates are read in source order and the last one whose
 * variant matches wins. An unrecognised `pr-` token throws rather than being
 * quietly skipped — a gutter moved to a variant this resolver cannot evaluate
 * must fail loudly, not silently resolve to the base value.
 */
function resolveGutterPx(className: string): number {
  let px: number | null = null;
  for (const token of className.split(/\s+/).filter(Boolean)) {
    const match = token.match(/^(?:\[@media\((.*)\)\]:)?pr-\[(\d+)px\]$/);
    if (!match) {
      if (/(?:^|:)pr-/.test(token)) throw new Error(`unrecognised gutter token "${token}"`);
      continue;
    }
    if (match[1] === undefined || mediaMatches(`(${match[1]})`)) px = Number(match[2]);
  }
  if (px === null) throw new Error(`no gutter in "${className}"`);
  return px;
}

/** The rendered control's box, derived from the classes it actually carries. */
function resolveControlPx(button: Element): number {
  const cls = classOf(button);
  const boxed = cls.match(/(?:^|\s)h-(\d+)(?:\s|$)/);
  if (boxed) {
    const px = Number(boxed[1]) * SPACING_STEP_PX;
    expect(px, "an explicitly boxed control is the declared coarse tap target").toBe(ACTION_SIZE_COARSE_PX);
    return px;
  }
  const padded = cls.match(/(?:^|\s)p-(\d+)(?:\s|$)/);
  if (!padded) throw new Error(`control has neither a box nor a padding: "${cls}"`);
  const icon = button.querySelector("svg");
  const iconMatch = classOf(icon ?? button).match(/(?:^|\s)h-(\d+)(?:\s|$)/);
  if (!iconMatch) throw new Error(`padded control has no sized icon: "${classOf(icon ?? button)}"`);
  const px = Number(padded[1]) * SPACING_STEP_PX * 2 + Number(iconMatch[1]) * SPACING_STEP_PX + BORDER_PX * 2;
  expect(px, "a padded control is the declared fine-pointer size").toBe(ACTION_SIZE_FINE_PX);
  return px;
}

/** Every anchored action in a subtree, paired with the body reserving its
    gutter — the two halves whose predicates must agree. */
function anchoredActions(host: Element): { control: Element; body: Element }[] {
  const pairs: { control: Element; body: Element }[] = [];
  for (const control of Array.from(host.querySelectorAll("button"))) {
    if (!/(?:^|\s)absolute(?:\s|$)/.test(classOf(control))) continue;
    const container = control.parentElement;
    if (!container) throw new Error("an anchored action has no positioning container");
    const body = Array.from(container.children).find((child) => child !== control && /pr-\[/.test(classOf(child)));
    if (!body) throw new Error(`an anchored action has no gutter-bearing body: "${classOf(control)}"`);
    pairs.push({ control, body });
  }
  return pairs;
}

function toolEvent(over: Partial<ToolEvent> = {}): ToolEvent {
  return {
    kind: "tool",
    id: "call-1",
    ts: "2026-07-10T10:00:00Z",
    srcCall: 0,
    family: "shell",
    tool: "Bash",
    icon: "shell",
    summary: "ls -la",
    chips: [],
    status: "ok",
    statusLabel: "ok",
    outputPreview: "",
    outputTruncated: false,
    open: true,
    ...over,
  };
}

/* Each block that anchors an action over a body it pads: the fenced code block
   from message markdown, and the command + output blocks of a tool card. */
function blocks(): ReactElement[] {
  return [
    <CodeBlock key="code" code={"const answer = 42;"} />,
    <ToolBody key="tool" event={toolEvent({ command: "rg --files src", outputPreview: "src/index.ts\nsrc/app.ts" })} />,
  ];
}

const STATES: { name: string; narrow: boolean; coarse: boolean }[] = [
  { name: "a desktop window at full width with a mouse", narrow: false, coarse: false },
  /* The pinned regression: phone width, but the input is still a mouse. */
  { name: "a desktop window dragged below 768px, still a mouse", narrow: true, coarse: false },
  { name: "a phone: narrow and a finger", narrow: true, coarse: true },
  { name: "a wide touchscreen: full width and a finger", narrow: false, coarse: true },
];

for (const state of STATES) {
  test(`an action never overhangs the gutter its body reserves — ${state.name}`, () => {
    narrowViewport = state.narrow;
    coarsePointer = state.coarse;
    let checked = 0;
    for (const block of blocks()) {
      const host = mount(block);
      for (const { control, body } of anchoredActions(host)) {
        const insetMatch = classOf(control).match(/right-\[(\d+)px\]/);
        expect(insetMatch, `anchored action carries no inset: "${classOf(control)}"`).toBeTruthy();
        const inset = Number(insetMatch![1]);
        expect(inset, "the anchor's inset is the declared one").toBe(ACTION_INSET_PX);
        /* The whole invariant, in one line: the control's right edge lands
           inside the gutter, never on the content box. */
        expect(inset + resolveControlPx(control)).toBeLessThanOrEqual(resolveGutterPx(classOf(body)));
        checked += 1;
      }
      flushSync(() => root!.unmount());
      root = null;
      dom.document.body.replaceChildren();
    }
    /* A silent zero would make every assertion above vacuous. */
    expect(checked, "code block + command block + output block each anchor one action").toBe(3);
  });
}

test("the 44px tap target is spent exactly where the input is a finger", () => {
  const sizes = new Map<boolean, number>();
  for (const coarse of [false, true]) {
    /* The viewport is held at phone width for both, so the only thing that
       moves is the pointer — the axis the gutter is cut from. */
    narrowViewport = true;
    coarsePointer = coarse;
    const host = mount(<CodeBlock code={"const answer = 42;"} />);
    sizes.set(coarse, resolveControlPx(anchoredActions(host)[0]!.control));
    flushSync(() => root!.unmount());
    root = null;
    dom.document.body.replaceChildren();
  }
  expect(sizes.get(true)).toBe(ACTION_SIZE_COARSE_PX);
  expect(ACTION_SIZE_COARSE_PX).toBeGreaterThanOrEqual(44);
  /* And a mouse at the same width gets the compact control, not a 44px one in
     a 28px gutter. */
  expect(sizes.get(false)).toBe(ACTION_SIZE_FINE_PX);
});

test("the reserved gutter does not depend on whether the control is rendered", () => {
  /* `ACTION_GUTTER` is applied unconditionally by every body that anchors an
     action, so the text never reflows as the control appears or hides. */
  for (const coarse of [false, true]) {
    coarsePointer = coarse;
    expect(resolveGutterPx(ACTION_GUTTER)).toBeGreaterThan(0);
  }
});

/* Review finding 2: two copy controls stacked on the same anchor once a tool
   output was expanded with a `lang` hint. `OutputPreview` delegated the body to
   `CodeBlock`, which brings its own control at the same top-right spot, and
   then rendered a second one over it — the lower one unreachable, and
   permanently visible since `MESSAGE_ACTION` dropped `opacity-0`. */
const COPY_LABELS = new Set([en("feed.copyCode"), en("tools.copyOutput"), en("tools.copyStderr"), en("common.copy"), en("common.copied")]);

function copyControls(host: Element): Element[] {
  return Array.from(host.querySelectorAll("button")).filter((button) => COPY_LABELS.has(button.getAttribute("aria-label") ?? ""));
}

test("an expanded output with a lang hint keeps exactly one copy control, and it copies the full output", async () => {
  const output = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
  const host = mount(<OutputPreview output={output} truncated={false} lang="ts" copyLabel={en("tools.copyStderr")} />);
  expect(copyControls(host)).toHaveLength(1);

  const showAll = Array.from(host.querySelectorAll("button")).find((button) => (button.textContent ?? "").includes(en("tools.showOutput")));
  expect(showAll, "a 40-line output offers a reveal").toBeTruthy();
  click(showAll!);

  /* The expanded body is the delegated `CodeBlock`; the block owns the control. */
  const controls = copyControls(host);
  expect(controls).toHaveLength(1);
  /* A caller-supplied label survives the delegation instead of being replaced
     by the code block's generic one. */
  expect(controls[0]!.getAttribute("aria-label")).toBe(en("tools.copyStderr"));

  click(controls[0]!);
  await new Promise((resolve) => setTimeout(resolve, 0));
  /* The full output, never the preview slice the collapsed view showed. */
  expect(copied).toEqual([output]);
  expect(host.textContent).toContain("line 40");
});

test("the collapsed output keeps its own control, and it too copies the full output", async () => {
  const output = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
  const host = mount(<OutputPreview output={output} truncated={false} lang="ts" copyLabel={en("tools.copyStderr")} />);
  const controls = copyControls(host);
  expect(controls).toHaveLength(1);
  /* Collapsed, the preview is truncated on screen but the control still hands
     over everything. */
  expect(host.textContent).not.toContain("line 40");
  click(controls[0]!);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(copied).toEqual([output]);
});
