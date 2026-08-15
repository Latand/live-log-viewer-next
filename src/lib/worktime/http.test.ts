import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";

import { createWorktimeExportHandler } from "./http";
import { emptyWorktimeState } from "./ledger";
import { storeDailyRollup } from "./service";

const NOW = Date.parse("2026-08-15T09:00:00.000Z");
const DAY = "2026-08-14";

afterEach(() => setCallerConversationResolverForTests(null));

describe("authenticated local worktime export", () => {
  test("returns the model-free rollup with separate lifecycle fields", async () => {
    const state = emptyWorktimeState(Date.parse("2026-08-14T09:00:00.000Z"));
    storeDailyRollup(state, DAY, { intervals: [], excludedSyntheticMs: 0 }, [], NOW);
    const response = await createWorktimeExportHandler({
      readState: () => state,
      now: () => NOW,
    })(new NextRequest(`http://localhost/api/worktime?day=${DAY}`, {
      headers: { host: "localhost", origin: "http://localhost", "sec-fetch-site": "same-origin" },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      rollup: { day: DAY, timezone: "Europe/Kyiv" },
      lifecycle: { destination: "private-draft", delivered_at: null, receipt_id: null },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("rejects cross-origin browsers and agent capabilities", async () => {
    const handler = createWorktimeExportHandler({
      readState: () => emptyWorktimeState(NOW),
      now: () => NOW,
    });
    const crossOrigin = await handler(new NextRequest("http://localhost/api/worktime", {
      headers: { host: "localhost", origin: "https://example.invalid" },
    }));
    expect(crossOrigin.status).toBe(403);

    setCallerConversationResolverForTests(() => "conversation_fixture");
    const agent = await handler(new NextRequest("http://localhost/api/worktime", {
      headers: {
        host: "localhost",
        origin: "http://localhost",
        "sec-fetch-site": "same-origin",
        [VIEWER_SPAWN_CAPABILITY_HEADER]: "a".repeat(43),
      },
    }));
    expect(agent.status).toBe(403);
  });
});
