import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CodeBlock } from "./markdown";
import { FeedItem } from "./FeedItem";
import type { Item } from "./parse";

/* Issue #698: message action buttons were `absolute right-0 top-0` over a body
   with no reserved gutter. On a coarse pointer that resolved to 44×44 controls
   sitting permanently at 60% opacity on the first lines of the message; on
   desktop the same controls were undiscoverable until hover. There was no width
   at which they were both findable and out of the way. */

function prose(): Item {
  return { kind: "prose", ts: 1_753_000_000, engine: "claude", text: "The first line of the answer." } as unknown as Item;
}

function user(): Item {
  return { kind: "user", ts: 1_753_000_000, text: "A short instruction." } as unknown as Item;
}

test("an assistant message keeps its actions out of the text flow", () => {
  const html = renderToStaticMarkup(<FeedItem item={prose()} />);
  /* No absolutely-positioned cluster over the body. */
  expect(html).not.toContain("absolute right-0 top-0");
  /* The body element itself is no longer a positioning context for actions. */
  expect(html).toContain('class="min-w-0 flex-1 whitespace-pre-wrap break-words"');
  /* The actions occupy a reserved row of their own above the text. */
  expect(html).toMatch(/mb-0\.5 flex min-h-6 items-center gap-1/);
});

test("message actions are visible without a hover and never dimmed onto text", () => {
  for (const item of [prose(), user()]) {
    const html = renderToStaticMarkup(<FeedItem item={item} />);
    /* The pair that produced both halves of the defect. */
    expect(html).not.toContain("opacity-0");
    expect(html).not.toContain("[@media(hover:none)]:opacity-60");
    expect(html).toContain("opacity-70");
  }
});

test("a code block reserves a gutter for its copy control", () => {
  const html = renderToStaticMarkup(<CodeBlock code={"const answer = 42;"} />);
  /* The control still sits top-right, but the code is padded clear of it. */
  expect(html).toContain("pr-10");
  expect(html).toContain("absolute right-1.5 top-1.5");
  expect(html).not.toContain("opacity-0");
  expect(html).not.toContain("[@media(hover:none)]:opacity-60");
});
