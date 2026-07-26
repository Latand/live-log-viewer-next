import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { en } from "@/lib/i18n/en";

/*
 * Issue #696, review finding 1. `catalogFailures` reached the overview board and
 * the rail, but not `ProjectDashboard` — and the dashboard is the DEFAULT entry
 * path: a project restored from `localStorage` or a `#p=` hash lands straight
 * on it. With a dead server it rendered `SchemeSkeleton` indefinitely, and on a
 * phone the rail is behind a drawer, so nothing on screen named the failure at
 * all. These tests pin the truthful screen, and pin that a genuine first load
 * still gets the skeleton.
 */

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
});

const { CatalogFailureNotice } = await import("./CatalogFailureNotice");
const { SchemeSkeleton } = await import("./scheme/SchemeSkeleton");

afterEach(() => {
  document.body.replaceChildren();
});

/** The exact branch `ProjectDashboard` renders at both of its skeleton sites. */
function boardFallback(catalogFailures: number) {
  return catalogFailures > 0
    ? <CatalogFailureNotice failures={catalogFailures} className="mt-[12vh]" />
    : <SchemeSkeleton />;
}

function render(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  flushSync(() => { createRoot(host).render(node); });
  return host as unknown as HTMLElement;
}

test("a project screen behind a failing catalog names the failure and offers the retry", () => {
  const host = render(boardFallback(2));
  expect(host.querySelector('[data-catalog-error="true"]')).toBeTruthy();
  expect(host.textContent).toContain(en["catalog.errorTitle"]);
  expect(host.textContent).toContain(en["catalog.retry"]);
  expect(host.textContent).toContain("2 failed attempts");
  /* Not a skeleton pretending to still be loading. */
  expect(host.querySelector(".animate-pulse")).toBeNull();
});

test("a genuine first load still shows the skeleton", () => {
  const host = render(boardFallback(0));
  expect(host.querySelector('[data-catalog-error="true"]')).toBeNull();
  expect(host.textContent).not.toContain(en["catalog.errorTitle"]);
});

test("the failure notice is one wording and one recovery action everywhere", () => {
  /* The review's constraint: no surface may grow a second vocabulary for the
     same event. The inline (rail) form drops only the explanatory sentence. */
  const panel = render(<CatalogFailureNotice failures={1} />);
  const inline = render(<CatalogFailureNotice failures={1} size="inline" />);
  for (const host of [panel, inline]) {
    expect(host.textContent).toContain(en["catalog.errorTitle"]);
    expect(host.textContent).toContain(en["catalog.retry"]);
    expect(host.querySelector('[role="alert"]')).toBeTruthy();
  }
  expect(panel.textContent).toContain(en["catalog.errorBody"]);
  /* The retry is a real 44px target on both. */
  for (const host of [panel, inline]) {
    expect(host.querySelector("button")?.className).toContain("min-h-11");
  }
});

test("no failures renders nothing at all", () => {
  expect(render(<CatalogFailureNotice failures={0} />).textContent).toBe("");
});

/** Every JSX opening tag for `component`, brace-aware so a `=>` inside a prop
    value does not end the tag early. */
function openingTags(source: string, component: string): string[] {
  const tags: string[] = [];
  for (const match of source.matchAll(new RegExp(`<${component}(?![A-Za-z0-9])`, "g"))) {
    const start = match.index!;
    let depth = 0;
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      else if (ch === ">" && depth === 0) {
        tags.push(source.slice(start, i + 1));
        break;
      }
    }
  }
  return tags;
}

/* The defect the review found was the WIRING, not the notice: the prop simply
   never reached the dashboard. Mounting the whole dashboard needs a harness far
   larger than the guarantee is worth, so this pins the wiring at the source —
   every surface that can render an unconfirmed catalog is fed the count.

   Asserted per surface, never as a total. Counting the wiring sites (the rail
   twice, the board, the dashboard: "exactly 4") made the test fail the moment
   somebody wired a FIFTH surface correctly — punishing the next person for
   doing the right thing, and teaching them to edit the number rather than think
   about it. What matters is that no surface renders WITHOUT the count. */
test("every catalog surface is fed the failure count", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dir, file), "utf8");

  const viewer = read("Viewer.tsx");
  /* Each surface that can show an unconfirmed catalog, at every site it is
     rendered from — a new surface joins this list, it does not shift a count. */
  for (const surface of ["ProjectRail", "OverviewBoard", "ProjectDashboard"]) {
    const tags = openingTags(viewer, surface);
    expect(tags.length, `Viewer.tsx renders no <${surface}>`).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag, `a <${surface}> in Viewer.tsx renders without the catalog failure count`).toContain("catalogFailures={catalogFailures}");
    }
  }

  const dashboard = read("ProjectDashboard.tsx");
  /* Every skeleton site must yield to the notice. Comparing the two derived
     counts — not either against a literal — means a correctly guarded third
     site keeps passing and an unguarded one fails. */
  const skeletons = dashboard.match(/<SchemeSkeleton\b/g) ?? [];
  const guarded = dashboard.match(/catalogFailures > 0 \? <CatalogFailureNotice[^\n]*?\/> : <SchemeSkeleton\b/g) ?? [];
  expect(skeletons.length, "the dashboard renders no skeleton at all").toBeGreaterThan(0);
  expect(guarded.length, "a skeleton site does not yield to the catalog failure notice").toBe(skeletons.length);

  /* …and the deck it owns. */
  const decks = openingTags(dashboard, "Switchboard");
  expect(decks.length, "ProjectDashboard.tsx renders no <Switchboard>").toBeGreaterThan(0);
  for (const deck of decks) {
    expect(deck, "a <Switchboard> renders without the catalog failure count").toContain("catalogFailures={catalogFailures}");
  }

  for (const file of ["ProjectRail.tsx", "Switchboard.tsx"]) {
    expect(read(file), `${file} must route through the shared notice`).toContain("<CatalogFailureNotice");
  }
});
