import { expect, test } from "bun:test";

import { stickyPayload } from "./LimitsFooter";
import type { LimitsPayload } from "@/lib/types";

const live = { source: "live", reason: null, staleSince: null } as const;
const unavailable = { source: "unavailable", reason: "app-server unavailable", staleSince: "2026-07-10T00:00:00.000Z" } as const;

test("a Codex account switch clears A quota while preserving Claude freshness independently", () => {
  const a: LimitsPayload = {
    claude: { session: { usedPercent: 10, resetsAt: 1 }, weekly: null, plan: "max", capturedAt: null },
    codex: { session: { usedPercent: 37, resetsAt: 2 }, weekly: null, plan: "pro", capturedAt: 1 },
    codexAccountId: "account-a",
    provenance: { claude: live, codex: live },
  };
  const bFailure: LimitsPayload = {
    claude: null,
    codex: null,
    codexAccountId: "account-b",
    provenance: { claude: unavailable, codex: unavailable },
  };
  const visible = stickyPayload(a, bFailure);
  expect(visible.codex).toBeNull();
  expect(visible.codexAccountId).toBe("account-b");
  expect(visible.provenance.codex).toEqual(unavailable);
  expect(visible.claude).toEqual(a.claude);
  expect(visible.provenance.claude).toEqual(live);
});
