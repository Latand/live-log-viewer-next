import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { translate } from "@/lib/i18n";
import type { StructuredSpawnCardState } from "@/lib/types";

import { StructuredSpawnStatusView } from "./StructuredSpawnStatus";

const base: StructuredSpawnCardState = {
  launchId: "structured-state-fixture-533",
  clientAttemptId: "p0_282_spawn_visibility_20260716_a1",
  accountId: "terra",
  state: "starting",
  initialMessage: "pending",
  retrySafe: false,
  error: null,
};

test("structured spawn card renders every durable launch state in English and Ukrainian", () => {
  for (const locale of ["en", "uk"] as const) {
    const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate(locale, key, params);
    for (const state of ["starting", "binding", "queued", "reconciling", "recoverable-timeout", "live-late-success", "failed", "recovered"] as const) {
      const spawn = {
        ...base,
        state,
        initialMessage: ["queued", "reconciling", "recoverable-timeout"].includes(state)
          ? "queued" as const
          : state === "recovered" || state === "live-late-success"
            ? "delivered" as const
            : state === "failed" ? "failed" as const : "pending" as const,
        retrySafe: state === "failed",
        error: state === "failed" ? "structured host ownership is unavailable" : null,
      };
      const html = renderToStaticMarkup(<StructuredSpawnStatusView spawn={spawn} t={t} />);

      expect(html).toContain(`data-spawn-state="${state}"`);
      expect(html).toContain(t(`spawnCard.${state}`));
      expect(html).toContain(t(`spawnCard.initial.${spawn.initialMessage}`));
      expect(html).toContain(spawn.launchId.slice(0, 8));
      if (state === "failed") {
        expect(html).toContain("structured host ownership is unavailable");
        expect(html).toContain(t("spawnCard.retrySafe"));
      }
    }
  }
});

test("retry-safe terminal card exposes the fresh-attempt action when wired by the board", () => {
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("uk", key, params);
  const spawn: StructuredSpawnCardState = {
    ...base,
    state: "failed",
    initialMessage: "failed",
    retrySafe: true,
    error: "runtime host request timed out",
  };

  const passive = renderToStaticMarkup(<StructuredSpawnStatusView spawn={spawn} t={t} />);
  const actionable = renderToStaticMarkup(<StructuredSpawnStatusView spawn={spawn} t={t} onRetry={() => undefined} />);

  expect(passive).not.toContain(t("launchHistory.retryLabel"));
  expect(actionable).toContain("<button");
  expect(actionable).toContain(t("launchHistory.retryLabel"));
});
