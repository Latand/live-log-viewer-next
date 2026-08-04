import { expect, test } from "bun:test";

import { splitHighlightedLines } from "./highlightLines";

test("plain lines pass through untouched", () => {
  expect(splitHighlightedLines("one\ntwo")).toEqual(["one", "two"]);
});

test("a span crossing a newline is closed and re-opened per line", () => {
  const html = '<span class="hljs-comment">/* a\nb */</span> tail';
  expect(splitHighlightedLines(html)).toEqual([
    '<span class="hljs-comment">/* a</span>',
    '<span class="hljs-comment">b */</span> tail',
  ]);
});

test("nested spans re-open in order", () => {
  const html = '<span class="a">x<span class="b">y\nz</span>w</span>';
  expect(splitHighlightedLines(html)).toEqual([
    '<span class="a">x<span class="b">y</span></span>',
    '<span class="a"><span class="b">z</span>w</span>',
  ]);
});
