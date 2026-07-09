import { expect, test } from "bun:test";

import type { EngineLimits, LimitsPayload, LimitsProvenance } from "@/lib/types";

import { codexLimitsForActiveAccount, createLatestLimitsLoader, fmtStaleSince, stickyPayload } from "./LimitsFooter";

const live: LimitsProvenance = { source: "live", reason: null, staleSince: null };
const unavailable: LimitsProvenance = {
  source: "unavailable",
  reason: "app-server unavailable",
  staleSince: "2026-07-10T00:00:00.000Z",
};

const engine = (usedPercent: number): EngineLimits => ({
  session: { usedPercent, resetsAt: null },
  weekly: null,
  plan: "pro",
  capturedAt: null,
});

const payload = ({
  claude = null,
  codex = null,
  codexAccountId = "default",
  claudeProvenance = live,
  codexProvenance = live,
  staleSince = null,
}: {
  claude?: EngineLimits | null;
  codex?: EngineLimits | null;
  codexAccountId?: string | null;
  claudeProvenance?: LimitsProvenance;
  codexProvenance?: LimitsProvenance;
  staleSince?: string | null;
} = {}): LimitsPayload => ({
  claude,
  codex,
  codexAccountId,
  provenance: { claude: claudeProvenance, codex: codexProvenance },
  staleSince,
});

test("a Codex account switch clears A quota while preserving Claude data with current provenance", () => {
  const previous = payload({ claude: engine(10), codex: engine(37), codexAccountId: "account-a" });
  const failedRefresh = payload({
    codexAccountId: "account-b",
    claudeProvenance: unavailable,
    codexProvenance: unavailable,
  });
  const visible = stickyPayload(previous, failedRefresh);
  expect(visible.codex).toBeNull();
  expect(visible.codexAccountId).toBe("account-b");
  expect(visible.provenance.codex).toEqual(unavailable);
  expect(visible.claude).toEqual(previous.claude);
  expect(visible.provenance.claude).toEqual(unavailable);
});

test("a Codex account change drops the previous account numbers", () => {
  const previous = payload({ codex: engine(11), codexAccountId: "default" });
  const next = payload({ claude: engine(50), codexAccountId: "work" });
  const merged = stickyPayload(previous, next);
  expect(merged.codex).toBeNull();
  expect(merged.codexAccountId).toBe("work");
});

test("a same-account refresh with no fresh Codex numbers keeps the last snapshot", () => {
  const previous = payload({ codex: engine(11) });
  const next = payload({ claude: engine(50), codexProvenance: unavailable });
  const merged = stickyPayload(previous, next);
  expect(merged.codex).toEqual(engine(11));
  expect(merged.codexAccountId).toBe("default");
  expect(merged.provenance.codex).toEqual(unavailable);
});

test("an empty payload retains prior same-account data and exposes current freshness", () => {
  const previous = payload({ claude: engine(20), codex: engine(11) });
  const next = payload({
    claudeProvenance: unavailable,
    codexProvenance: unavailable,
    staleSince: "2026-07-10T00:00:00.000Z",
  });
  const merged = stickyPayload(previous, next);
  expect(merged.claude).toEqual(engine(20));
  expect(merged.codex).toEqual(engine(11));
  expect(merged.provenance).toEqual(next.provenance);
  expect(merged.staleSince).toBe("2026-07-10T00:00:00.000Z");
});

test("an id-less legacy payload keeps the current account snapshot", () => {
  const previous = payload({ codex: engine(11), codexAccountId: null });
  const next = payload({ claude: engine(50), codexAccountId: null });
  expect(stickyPayload(previous, next).codex).toEqual(engine(11));
});

test("Codex values stay masked until the current API payload names the active account", () => {
  const current = payload({ codex: engine(11), codexAccountId: "A" });
  expect(codexLimitsForActiveAccount(current, "B")).toBeNull();
  expect(codexLimitsForActiveAccount(current, "A")).toEqual(engine(11));
});

test("the limits channel keeps A to B to A ordering when the oldest A response arrives last", async () => {
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
  };
  const replies = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
  let request = 0;
  const applied: LimitsPayload[] = [];
  const loader = createLatestLimitsLoader(async () => replies[request++].promise, (value) => applied.push(value));
  const first = loader.load();
  const second = loader.load();
  const third = loader.load();
  replies[1].resolve(Response.json(payload({ codex: engine(20), codexAccountId: "B" })));
  replies[2].resolve(Response.json(payload({ codex: engine(30), codexAccountId: "A" })));
  await third;
  replies[0].resolve(Response.json(payload({ codex: engine(10), codexAccountId: "A" })));
  await Promise.all([first, second]);
  expect(applied).toEqual([payload({ codex: engine(30), codexAccountId: "A" })]);
});

test("fmtStaleSince yields a readable as-of hint for a valid timestamp", () => {
  const hint = fmtStaleSince("2026-07-10T08:30:00.000Z", "en");
  expect(hint).not.toBeNull();
  expect(hint).toContain("as of");
});

test("fmtStaleSince returns null when there is nothing to explain", () => {
  expect(fmtStaleSince(null, "en")).toBeNull();
  expect(fmtStaleSince(undefined, "en")).toBeNull();
  expect(fmtStaleSince("not-a-date", "en")).toBeNull();
});
