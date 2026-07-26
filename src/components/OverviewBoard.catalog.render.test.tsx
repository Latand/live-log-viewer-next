import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { en } from "@/lib/i18n/en";

import { OverviewBoard } from "./OverviewBoard";

/* Issue #696: a catalog fetch that failed must not render as an idle, empty
   installation. Issue #701: at 320px the header used to overflow and the
   subtitle overprinted both the title and the Orchestrator button. */

/** Static markup with HTML-escaped apostrophes folded back, so assertions can
    quote the dictionary entries verbatim. */
function board(catalogFailures: number) {
  return renderToStaticMarkup(
    <OverviewBoard
      files={[]}
      projectCatalog={[]}
      pipelines={[]}
      workflows={[]}
      archivedProjects={new Set()}
      now={2_000}
      catalogFailures={catalogFailures}
      onSelectProject={() => {}}
      onSelectFile={() => {}}
    />,
  ).replaceAll("&#x27;", "'");
}

test("a failed catalog fetch renders an error with a retry, never the idle empty state", () => {
  const html = board(3);
  expect(html).toContain(en["catalog.errorTitle"]);
  expect(html).toContain(en["catalog.errorBody"]);
  expect(html).toContain(en["catalog.retry"]);
  expect(html).toContain("3 failed attempts");
  expect(html).toContain('role="alert"');
  /* The two affirmative idle statements the board used to make while nothing
     had actually loaded. */
  expect(html).not.toContain(en["overview.empty"]);
  expect(html).not.toContain(en["common.nothingRunning"]);
});

test("a genuinely empty installation still reads as empty, with no error", () => {
  const html = board(0);
  expect(html).toContain(en["overview.empty"]);
  expect(html).toContain(en["common.nothingRunning"]);
  expect(html).not.toContain(en["catalog.errorTitle"]);
  expect(html).not.toContain(en["catalog.retry"]);
});

test("the header title truncates and the subtitle is withheld below 360px", () => {
  const html = board(0);
  const header = html.slice(0, html.indexOf("grid flex-1"));
  /* The fixed-height bar clips rather than reflows … */
  expect(header).toContain("h-10 shrink-0 items-center gap-2.5 overflow-hidden");
  /* … the title shrinks and truncates instead of pushing the row wider … */
  expect(header).toMatch(/<h1 class="[^"]*min-w-0 shrink truncate/);
  /* … and the secondary line only exists from 360px up, so at 320px it can
     neither overprint the title nor wrap under the Orchestrator button. */
  expect(header).toMatch(/class="hidden min-w-0 shrink truncate[^"]*min-\[360px\]:block/);
});
