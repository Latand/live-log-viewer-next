import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { CtxUsage } from "@/lib/types";
import { CtxChip } from "./PlanChip";

const observedAt = "2026-07-12T10:00:00.000Z";

test("known registry context shows its denominator and registry provenance", () => {
  const ctx: CtxUsage = {
    usedTokens: 176_000, windowTokens: 200_000, pct: 88, source: "registry",
    confidence: "approximate", registryVersion: "2026-07-10", observedAt,
  };
  const html = renderToStaticMarkup(<CtxChip ctx={ctx} />);
  expect(html).toContain("ctx 176K");
  expect(html).toContain("200K");
  expect(html).toContain("bundled model registry (2026-07-10) — approximate");
});

test("unknown context renders raw tokens with no denominator", () => {
  const ctx: CtxUsage = {
    usedTokens: 176_000, windowTokens: null, pct: null, source: "unknown",
    confidence: "unknown", observedAt,
  };
  const html = renderToStaticMarkup(<CtxChip ctx={ctx} />);
  expect(html).toContain(">ctx 176K<");
  expect(html).not.toContain("176K<!-- -->/<");
  expect(html).toContain("percentage withheld");
});
