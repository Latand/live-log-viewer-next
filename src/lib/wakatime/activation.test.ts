import { expect, test } from "bun:test";

import { wakatimeIntegrationEnabled } from "./activation";

test("WakaTime activation requires the exact server opt-in", () => {
  expect(wakatimeIntegrationEnabled({})).toBe(false);
  expect(wakatimeIntegrationEnabled({ LLV_WAKATIME_ENABLED: "" })).toBe(false);
  expect(wakatimeIntegrationEnabled({ LLV_WAKATIME_ENABLED: "true" })).toBe(false);
  expect(wakatimeIntegrationEnabled({ LLV_WAKATIME_ENABLED: "0" })).toBe(false);
  expect(wakatimeIntegrationEnabled({ LLV_WAKATIME_ENABLED: "1" })).toBe(true);
});
