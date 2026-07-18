import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { translate } from "@/lib/i18n";

import { SupersededBannerView } from "./SupersededBanner";

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);

test("the superseded banner names the retirement, links the live round, and offers the explicit fork", () => {
  const html = renderToStaticMarkup(
    <SupersededBannerView t={t} sinceLabel="12 min" onOpenSuccessor={() => {}} onResumeHere={() => {}} />,
  );
  expect(html).toContain('role="status"');
  expect(html).toContain("data-superseded-banner");
  expect(html).toContain(translate("en", "superseded.title", { since: "12 min" }));
  expect(html).toContain(translate("en", "superseded.open"));
  expect(html).toContain(translate("en", "superseded.resumeHere"));
  // Quiet history tone, not the danger tone — this is a resolved state, not an
  // incident (issue #383 vs the #247 dead-host banner).
  expect(html).not.toContain("border-danger/45");
  // 390px acceptance: every action keeps the 44px touch target.
  expect(html.split("min-h-11").length - 1).toBe(2);
});

test("resume-here shows a spinner while busy and surfaces a failed fork", () => {
  const busy = renderToStaticMarkup(
    <SupersededBannerView t={t} sinceLabel="1 min" onOpenSuccessor={() => {}} onResumeHere={() => {}} resumeBusy />,
  );
  expect(busy).toContain("animate-spin");
  expect(busy).toContain("disabled");

  const failed = renderToStaticMarkup(
    <SupersededBannerView t={t} sinceLabel="1 min" onOpenSuccessor={() => {}} onResumeHere={() => {}} resumeError="edge is busy" />,
  );
  expect(failed).toContain('role="alert"');
  expect(failed).toContain("edge is busy");
});

test("uk and en localizations both render coherent banner copy", () => {
  for (const locale of ["en", "uk"] as const) {
    const tLoc: typeof t = (key, params) => translate(locale, key, params);
    const html = renderToStaticMarkup(
      <SupersededBannerView t={tLoc} sinceLabel="12" onOpenSuccessor={() => {}} onResumeHere={() => {}} />,
    );
    expect(html).toContain(translate(locale, "superseded.open"));
    expect(html).toContain(translate(locale, "superseded.resumeHere"));
  }
});
