import { expect, test } from "bun:test";

import type { EngineLimits, LimitsPayload } from "@/lib/types";

import { codexLimitsForActiveAccount, createLatestLimitsLoader, fmtStaleSince, stickyPayload } from "./LimitsFooter";

const engine = (usedPercent: number): EngineLimits => ({
  session: { usedPercent, resetsAt: null },
  weekly: null,
  plan: "pro",
  capturedAt: null,
});

test("a Codex account change drops the previous account's numbers instead of carrying them", () => {
  const previous: LimitsPayload = { claude: null, codex: engine(11), codexAccountId: "default", staleSince: null };
  // The switched-to account has no transcripts yet, so its payload carries codex: null.
  const next: LimitsPayload = { claude: engine(50), codex: null, codexAccountId: "work", staleSince: null };
  const merged = stickyPayload(previous, next);
  expect(merged.codex).toBeNull();
  expect(merged.codexAccountId).toBe("work");
});

test("a same-account refresh with no fresh Codex numbers keeps the last good ones", () => {
  const previous: LimitsPayload = { claude: null, codex: engine(11), codexAccountId: "default", staleSince: null };
  const next: LimitsPayload = { claude: engine(50), codex: null, codexAccountId: "default", staleSince: null };
  const merged = stickyPayload(previous, next);
  expect(merged.codex).toEqual(engine(11));
  expect(merged.codexAccountId).toBe("default");
});

test("an empty payload still sticks to the previous snapshot for the same account", () => {
  const previous: LimitsPayload = { claude: engine(20), codex: engine(11), codexAccountId: "default", staleSince: null };
  const next: LimitsPayload = { claude: null, codex: null, codexAccountId: "default", staleSince: "2026-07-10T00:00:00.000Z" };
  const merged = stickyPayload(previous, next);
  expect(merged.claude).toEqual(engine(20));
  expect(merged.codex).toEqual(engine(11));
  expect(merged.staleSince).toBe("2026-07-10T00:00:00.000Z");
});

test("an id-less payload (legacy cache) never counts as an account change", () => {
  const previous = { claude: null, codex: engine(11), staleSince: null } as LimitsPayload;
  const next = { claude: engine(50), codex: null, staleSince: null } as LimitsPayload;
  const merged = stickyPayload(previous, next);
  expect(merged.codex).toEqual(engine(11));
});

test("Codex values stay masked until the current API payload names the active account", () => {
  const payload: LimitsPayload = { claude: null, codex: engine(11), codexAccountId: "A", staleSince: null };
  expect(codexLimitsForActiveAccount(payload, "B")).toBeNull();
  expect(codexLimitsForActiveAccount(payload, "A")).toEqual(engine(11));
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
  const loader = createLatestLimitsLoader(async () => replies[request++].promise, (payload) => applied.push(payload));
  const first = loader.load();
  const second = loader.load();
  const third = loader.load();
  replies[1].resolve(new Response(JSON.stringify({ claude: null, codex: engine(20), codexAccountId: "B", staleSince: null })));
  replies[2].resolve(new Response(JSON.stringify({ claude: null, codex: engine(30), codexAccountId: "A", staleSince: null })));
  await third;
  replies[0].resolve(new Response(JSON.stringify({ claude: null, codex: engine(10), codexAccountId: "A", staleSince: null })));
  await Promise.all([first, second]);
  expect(applied).toEqual([{ claude: null, codex: engine(30), codexAccountId: "A", staleSince: null }]);
});

// Finding 3: the Codex block dims when stale, so it must also carry a readable
// reason. fmtStaleSince is the text behind that dim.
test("fmtStaleSince yields a readable 'as of' hint for a valid timestamp", () => {
  const hint = fmtStaleSince("2026-07-10T08:30:00.000Z", "en");
  expect(hint).not.toBeNull();
  expect(hint).toContain("as of");
});

test("fmtStaleSince returns null when there is nothing to explain", () => {
  expect(fmtStaleSince(null, "en")).toBeNull();
  expect(fmtStaleSince(undefined, "en")).toBeNull();
  expect(fmtStaleSince("not-a-date", "en")).toBeNull();
});
