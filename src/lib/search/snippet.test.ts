import { expect, test } from "bun:test";

import { SNIPPET_MATCH_CLOSE, SNIPPET_MATCH_OPEN, snippetSegments } from "./snippet";

test("splits a delimited snippet into plain and matched segments", () => {
  const snippet = `report the ${SNIPPET_MATCH_OPEN}heliotrope${SNIPPET_MATCH_CLOSE} totals`;

  expect(snippetSegments(snippet)).toEqual([
    { text: "report the ", match: false },
    { text: "heliotrope", match: true },
    { text: " totals", match: false },
  ]);
});

test("brackets typed inside a message body are never mistaken for a match", () => {
  const snippet = `const rows = items[0] and ${SNIPPET_MATCH_OPEN}cobalt${SNIPPET_MATCH_CLOSE}`;

  expect(snippetSegments(snippet)).toEqual([
    { text: "const rows = items[0] and ", match: false },
    { text: "cobalt", match: true },
  ]);
});

test("an undelimited snippet renders as one plain segment", () => {
  expect(snippetSegments("nothing marked here")).toEqual([{ text: "nothing marked here", match: false }]);
  expect(snippetSegments("")).toEqual([]);
});

test("an unbalanced marker is consumed rather than leaked into the rendered text", () => {
  const dangling = `tail only${SNIPPET_MATCH_CLOSE}`;
  const unterminated = `${SNIPPET_MATCH_OPEN}open forever`;

  for (const segments of [snippetSegments(dangling), snippetSegments(unterminated)]) {
    for (const segment of segments) {
      expect(segment.text).not.toContain(SNIPPET_MATCH_OPEN);
      expect(segment.text).not.toContain(SNIPPET_MATCH_CLOSE);
    }
  }
  expect(snippetSegments(unterminated)).toEqual([{ text: "open forever", match: true }]);
});
