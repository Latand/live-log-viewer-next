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

test("a code block's copy control is legible at rest, never dimmed onto the code", () => {
  const html = renderToStaticMarkup(<CodeBlock code={"const answer = 42;"} />);
  expect(html).not.toContain("opacity-0");
  expect(html).not.toContain("[@media(hover:none)]:opacity-60");
  expect(html).toContain("opacity-70");
});

/* The geometry half of this — that the code is padded clear of the control
   rather than under it — is asserted in `actionGeometry.dom.test.tsx`, not here.
   Two class assertions used to stand in for it: `toContain(ACTION_ANCHOR)` and
   `toContain(ACTION_GUTTER)`. Both are class lists compared against the very
   constants the markup interpolates, so reordering the classes inside a
   constant failed them without any behaviour changing, while cutting the gutter
   from 28px to 8px — the control overhanging the code by 20px, the whole defect
   #698 is about — moved the constant with the markup and passed untouched.
   The DOM test resolves the padding and the control's box to pixels under each
   media state instead, so that regression fails and a reordering does not. */

/* The same overlay pattern survived untouched in three feed cards. */
test("no feed component keeps a hover-only or text-overlaying action", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.join(import.meta.dir);
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() && /\.tsx$/.test(entry.name) && !entry.name.includes(".test.") ? [full] : [];
    });

  const offenders = walk(root).filter((file) => {
    const source = fs.readFileSync(file, "utf8");
    /* Class strings only — the words appear in explanatory comments. */
    return /className[^\n]*\bopacity-0\b/.test(source)
      || /\[@media\(hover:none\)\]:opacity-60/.test(source);
  });
  expect(offenders.map((file) => path.relative(root, file))).toEqual([]);
});
