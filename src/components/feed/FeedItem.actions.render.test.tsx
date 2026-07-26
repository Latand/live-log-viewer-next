import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ACTION_GUTTER, ACTION_INSET_PX, ACTION_SIZE_COARSE_PX, ACTION_SIZE_FINE_PX } from "./actionStyles";
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
  expect(html).toContain(ACTION_GUTTER);
  expect(html).toContain("absolute right-[6px] top-[6px]");
  expect(html).not.toContain("opacity-0");
  expect(html).not.toContain("[@media(hover:none)]:opacity-60");
});

/* Review finding 2: `CopyButton` is `h-11 w-11` on a coarse pointer, and the
   old 40px `pr-10` gutter left the 44px button overhanging the content box by
   10px — it covered the right edge of the first lines of code inside message
   markdown. happy-dom has no layout engine, so the invariant is checked against
   the declared geometry the classes are generated from. */
test("the action gutter clears the control at both pointer sizes", () => {
  const px = (className: string, prefix: string): number => {
    const match = className.match(new RegExp(`${prefix}pr-\\[(\\d+)px\\]`));
    expect(match, `no ${prefix || "base"} gutter in ${className}`).toBeTruthy();
    return Number(match![1]);
  };
  const fine = px(ACTION_GUTTER, "(?<![:\\]])");
  const coarse = px(ACTION_GUTTER, "\\[@media\\(pointer:coarse\\)\\]:");

  /* The control's right edge must land inside the gutter, never on content. */
  expect(fine).toBeGreaterThanOrEqual(ACTION_INSET_PX + ACTION_SIZE_FINE_PX);
  expect(coarse).toBeGreaterThanOrEqual(ACTION_INSET_PX + ACTION_SIZE_COARSE_PX);
  /* The 44px tap target is the whole point of the coarse branch. */
  expect(ACTION_SIZE_COARSE_PX).toBeGreaterThanOrEqual(44);
});

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
