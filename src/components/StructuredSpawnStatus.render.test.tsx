import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { translate } from "@/lib/i18n";
import type { StructuredSpawnCardState } from "@/lib/types";

import { StructuredSpawnStatusView } from "./StructuredSpawnStatus";

const base: StructuredSpawnCardState = {
  launchId: "9173e9a2-2f14-4a70-818a-bd4052a1ad4a",
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
    for (const state of ["starting", "binding", "queued", "failed", "recovered"] as const) {
      const spawn = {
        ...base,
        state,
        initialMessage: state === "queued" ? "queued" as const : state === "recovered" ? "delivered" as const : state === "failed" ? "failed" as const : "pending" as const,
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
