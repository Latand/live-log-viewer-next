import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

import { buildKaraokeMap, createKaraoke, karaokeRoots } from "./ttsKaraoke";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  Text: dom.Text,
  HTMLElement: dom.HTMLElement,
  Range: dom.Range,
});

/** A stand-in for the CSS Custom Highlight API, which happy-dom does not ship. */
class FakeHighlight {
  ranges: Range[] = [];
  add(range: Range) { this.ranges.push(range); }
  clear() { this.ranges = []; }
}

const registry = new Map<string, FakeHighlight>();
Object.assign(globalThis, { Highlight: FakeHighlight, CSS: { highlights: registry } });

function render(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

afterEach(() => {
  document.body.replaceChildren();
  registry.clear();
});

describe("buildKaraokeMap (#1022)", () => {
  test("maps a spoken character range onto the rendered nodes it crosses", () => {
    const host = render("<p>Hello <strong>brave</strong> new world</p>");
    const spoken = "Hello brave new world";
    const map = buildKaraokeMap([host], spoken)!;

    const brave = map.rangeFor(spoken.indexOf("brave"), spoken.indexOf("brave") + 5)!;
    expect(brave.start[0].data).toBe("brave");
    expect(brave.start[1]).toBe(0);
    expect(brave.end[0].data).toBe("brave");
    expect(brave.end[1]).toBe(5);

    const world = map.rangeFor(spoken.indexOf("world"), spoken.length)!;
    expect(world.start[0].data).toBe(" new world");
    expect(world.start[0].data.slice(world.start[1], world.end[1])).toBe("world");
  });

  test("finds the spoken words around rendered text the voice never reads", () => {
    /* `spokenAnswerText` drops code and URLs, so the rendered body carries text
       the spoken string does not have. */
    const host = render("<p>Run <code>bun test</code> then open https://example.com/docs and read the report</p>");
    const spoken = "Run then open and read the report";
    const map = buildKaraokeMap([host], spoken)!;

    const report = map.rangeFor(spoken.indexOf("report"), spoken.length)!;
    expect(report.start[0].data).toContain("read the report");
    expect(report.start[0].data.slice(report.start[1], report.end[1])).toBe("report");
  });

  test("spans several rendered blocks of one answer", () => {
    const first = render("<p>First paragraph of the answer.</p>");
    const second = render("<p>Second paragraph closes it.</p>");
    const spoken = "First paragraph of the answer.\n\nSecond paragraph closes it.";
    const map = buildKaraokeMap([first, second], spoken)!;

    const closes = map.rangeFor(spoken.indexOf("closes"), spoken.indexOf("closes") + 6)!;
    expect(second.contains(closes.start[0] as unknown as Node)).toBe(true);
  });

  test("a repeated common word still tracks forward through the message", () => {
    const host = render("<p>the cat sat on the mat and the dog barked</p>");
    const spoken = "the cat sat on the mat and the dog barked";
    const map = buildKaraokeMap([host], spoken)!;
    const third = spoken.lastIndexOf("the");

    const range = map.rangeFor(third, third + 3)!;
    const text = range.start[0].data;
    expect(text.slice(range.start[1], range.end[1])).toBe("the");
    /* The third "the", not the first: the following word confirms it. */
    expect(text.slice(range.start[1], range.start[1] + 7)).toBe("the dog");
  });

  test("reads a rendered point back to the spoken character behind it", () => {
    const host = render("<p>Alpha beta gamma delta</p>");
    const spoken = "Alpha beta gamma delta";
    const map = buildKaraokeMap([host], spoken)!;
    const node = host.querySelector("p")!.firstChild as unknown as Text;

    expect(map.charAtDomPoint(node, spoken.indexOf("gamma") + 2)).toBe(spoken.indexOf("gamma"));
    expect(map.charAtDomPoint(node, 0)).toBe(0);
  });

  test("a click inside text the voice skips answers with the nearest spoken word", () => {
    const host = render("<p>Open <code>src/app/page.tsx</code> and edit the header</p>");
    const spoken = "Open and edit the header";
    const map = buildKaraokeMap([host], spoken)!;
    const code = host.querySelector("code")!.firstChild as unknown as Text;

    expect(map.charAtDomPoint(code, 3)).toBe(spoken.indexOf("and"));
  });

  test("gives up cleanly when the rendered body has nothing in common", () => {
    const host = render("<p>Совершенно другой текст</p>");
    expect(buildKaraokeMap([host], "Nothing here matches at all")).toBeNull();
    expect(buildKaraokeMap([render("<p></p>")], "spoken words")).toBeNull();
    expect(buildKaraokeMap([render("<p>text</p>")], "")).toBeNull();
  });
});

describe("createKaraoke (#1022)", () => {
  test("paints one range at a time and clears it on destroy", () => {
    const host = render("<p>Alpha beta gamma delta</p>");
    const spoken = "Alpha beta gamma delta";
    const karaoke = createKaraoke([host], spoken)!;

    karaoke.highlight(spoken.indexOf("beta"), spoken.indexOf("beta") + 4);
    const paint = registry.get("tts-karaoke")!;
    expect(paint.ranges).toHaveLength(1);
    expect(paint.ranges[0]!.toString()).toBe("beta");

    karaoke.highlight(spoken.indexOf("delta"), spoken.length);
    expect(paint.ranges).toHaveLength(1);
    expect(paint.ranges[0]!.toString()).toBe("delta");

    karaoke.destroy();
    expect(registry.has("tts-karaoke")).toBe(false);
  });

  test("turns a click point into a spoken character", () => {
    const host = render("<p>Alpha beta gamma delta</p>");
    const spoken = "Alpha beta gamma delta";
    const node = host.querySelector("p")!.firstChild as unknown as Node;
    const karaoke = createKaraoke([host], spoken)!;

    Object.assign(document, {
      caretPositionFromPoint: (x: number) => ({ offsetNode: node, offset: x }),
    });
    expect(karaoke.charAtPoint(spoken.indexOf("gamma") + 1, 0)).toBe(spoken.indexOf("gamma"));

    /* No caret API (or a click outside any text): no seek, no crash. */
    Object.assign(document, { caretPositionFromPoint: undefined, caretRangeFromPoint: undefined });
    expect(karaoke.charAtPoint(4, 4)).toBeNull();
    karaoke.destroy();
  });
});

describe("karaokeRoots (#1022)", () => {
  test("collects the follow-on blocks of the same answer and stops at the next one", () => {
    const feed = render(`
      <div data-feed-kind="prose"><div data-tts-message>
        <button data-tts-trigger></button><div data-tts-body id="a">First block.</div>
      </div></div>
      <div data-feed-kind="prose"><div data-tts-message>
        <div data-tts-body id="b">Same answer, second block.</div>
      </div></div>
      <div data-feed-kind="prose"><div data-tts-message>
        <button data-tts-trigger></button><div data-tts-body id="c">A different answer.</div>
      </div></div>
    `);
    const trigger = feed.querySelector("[data-tts-trigger]")!;

    expect(karaokeRoots(trigger).map((root) => root.id)).toEqual(["a", "b"]);
  });

  test("a control with no rendered body of its own maps nothing", () => {
    const feed = render(`<div data-feed-kind="prose"><div data-tts-message><button data-tts-trigger></button></div></div>`);
    expect(karaokeRoots(feed.querySelector("[data-tts-trigger]")!)).toEqual([]);
  });
});
