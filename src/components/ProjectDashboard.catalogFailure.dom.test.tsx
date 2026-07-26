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

/* The defect the review found was the WIRING, not the notice: the prop simply
   never reached the dashboard. Mounting the whole dashboard needs a harness far
   larger than the guarantee is worth, so this pins the wiring at the source —
   every surface that can render an unconfirmed catalog is fed the count. */
test("every catalog surface is fed the failure count", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dir, file), "utf8");

  const viewer = read("Viewer.tsx");
  /* The rail (x2), the overview board, and the project dashboard. */
  expect(viewer.match(/catalogFailures=\{catalogFailures\}/g)?.length).toBe(4);

  const dashboard = read("ProjectDashboard.tsx");
  /* Both skeleton sites — mobile focus view and desktop scheme board. */
  expect(dashboard.match(/catalogFailures > 0 \? <CatalogFailureNotice/g)?.length).toBe(2);
  /* …and the deck it owns. */
  expect(dashboard).toContain("<Switchboard files={files}");
  expect(dashboard).toMatch(/<Switchboard[^>]*catalogFailures=\{catalogFailures\}/);

  for (const file of ["ProjectRail.tsx", "Switchboard.tsx"]) {
    expect(read(file), `${file} must route through the shared notice`).toContain("<CatalogFailureNotice");
  }
});
