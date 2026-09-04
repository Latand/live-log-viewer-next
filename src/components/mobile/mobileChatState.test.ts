import { expect, test } from "bun:test";

import type { Pipeline } from "@/lib/pipelines/types";
import { translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { CHAT_STATE_PRECEDENCE, chatState, chatStateBits, stagePosition, type ChatStateKey } from "./mobileChatState";

/*
 * One state, one phrase, one precedence (docs/design/mobile-v2/README.md §2
 * rule 10, §4.2; issue #1439 lane 3).
 *
 * The 2026-08 audit's finding 3 is that a conversation BLOCKED on the operator
 * renders in the success tone with the word "working", because each surface
 * asked its own question in its own order. So the order lives in one module and
 * this file pins it end to end:
 *
 *   offline > killed > stalled > limit > held > waiting > working > returned > done
 *
 * The shape of the test is the shape of the claim: for every pair of states,
 * a conversation carrying BOTH signals is called the higher one. That is what
 * "precedence" means, and it is what a single example per state cannot show.
 */

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

function base(): FileEntry {
  return {
    path: "/home/user/.claude/projects/demo/lane.jsonl",
    root: "claude-projects",
    name: "lane.jsonl",
    project: "demo",
    title: "Rebuild the board status projection",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: NOW_S - 120,
    size: 10,
    activity: "idle",
    proc: null,
    pid: null,
    model: "Opus",
    effort: "high",
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
}

/** Each state's own signal, applied to a conversation that carries none. */
const SIGNAL: Record<Exclude<ChatStateKey, "offline">, (file: FileEntry) => FileEntry> = {
  /* A killed conversation is a host that died with its turn OPEN (#1487): the
     transcript's last turn never closed. */
  killed: (file) => ({ ...file, proc: "killed", lastTurn: { startedAt: NOW_MS - 60_000, endedAt: null } }),
  /* A stalled conversation is one the attention queue still holds: a live
     process whose transcript stopped growing, inside the queue's own TTL. */
  stalled: (file) => ({ ...file, activity: "stalled", proc: "running", mtime: NOW_S - 60 }),
  limit: (file) => ({ ...file, rateLimit: { accountId: "Main", resetAt: NOW_S + 3_600 } as FileEntry["rateLimit"] }),
  held: (file) => ({
    ...file,
    migration: { intentId: "i1", trigger: "manual", phase: "successor-starting", targetAccountId: "second", heldDeliveries: 2, failure: null },
  }),
  waiting: (file) => ({ ...file, pendingQuestion: { toolUseId: "q1" } as FileEntry["pendingQuestion"] }),
  working: (file) => ({ ...file, activity: "live" }),
  returned: (file) => ({ ...file, parent: "/root.jsonl", activity: "recent", proc: null }),
  done: (file) => file,
};

const KEYS = CHAT_STATE_PRECEDENCE.filter((key) => key !== "offline");

test("each signal on its own resolves to its own state", () => {
  for (const key of KEYS) {
    expect(chatState(SIGNAL[key](base()), { nowMs: NOW_MS })).toBe(key);
  }
});

test("for every pair, the conversation carrying both signals is called the higher one", () => {
  for (let i = 0; i < KEYS.length; i += 1) {
    for (let j = i + 1; j < KEYS.length; j += 1) {
      const higher = KEYS[i]!;
      const lower = KEYS[j]!;
      /* The lower signal first, so the higher one wins any field they share —
         which is the outcome under test, not a way of arranging it. */
      const both = SIGNAL[higher](SIGNAL[lower](base()));
      expect({ higher, lower, state: chatState(both, { nowMs: NOW_MS }) }).toEqual({ higher, lower, state: higher });
    }
  }
});

test("offline is screen-level and outranks every signal a conversation can carry", () => {
  for (const key of KEYS) {
    expect(chatState(SIGNAL[key](base()), { offline: true, nowMs: NOW_MS })).toBe("offline");
  }
});

/** The dictionary is not loaded in a unit test; the key IS the phrase. */
const t = ((key: string, vars?: Record<string, unknown>) =>
  vars ? `${key}(${Object.entries(vars).map(([name, value]) => `${name}=${value}`).join(",")})` : key) as never;

test("a blocked conversation never reads in the running tone or the running word", () => {
  for (const key of ["killed", "stalled", "limit", "held", "waiting"] as const) {
    const bits = chatStateBits(t, SIGNAL[key](base()), { nowMs: NOW_MS });
    expect(bits.key).toBe(key);
    expect(bits.tone).not.toBe("success");
    expect(bits.phrase).not.toContain("stateWorking");
  }
  const working = chatStateBits(t, SIGNAL.working(base()), { nowMs: NOW_MS });
  expect(working.tone).toBe("success");
});

test("the queue's own words ride the states that need the operator, and only those", () => {
  const badged = KEYS.filter((key) => chatStateBits(t, SIGNAL[key](base()), { nowMs: NOW_MS }).badge !== null);
  expect(badged).toEqual(["stalled", "limit", "waiting"]);
});

test("the limit phrase names the account and its reset, and falls back when the engine reported none", () => {
  const withReset = chatStateBits(t, SIGNAL.limit(base()), { nowMs: NOW_MS });
  expect(withReset.phrase).toContain("account=Main");
  const noReset = chatStateBits(t, { ...base(), rateLimit: { accountId: null, resetAt: null } as FileEntry["rateLimit"] }, { nowMs: NOW_MS });
  expect(noReset.phrase).toBe("mobile2.chat.stateLimit");
});

/* ── `stage k/n` on the CURRENT stage (§4.2, §3.2) ───────────────────────── */

function pipeline(over: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "p1",
    task: "Fast conversation switching",
    project: "demo",
    stages: [
      { id: "design", kind: "run", prompt: "", next: "implement" },
      { id: "implement", kind: "run", prompt: "", next: "review" },
      { id: "review", kind: "review-loop", prompt: "", next: null },
    ],
    runs: [
      { stageId: "design", attempts: [{ n: 1, state: "passed", agentPath: "/design.jsonl", flowId: null }] },
      { stageId: "implement", attempts: [{ n: 1, state: "running", agentPath: "/implement.jsonl", flowId: null }] },
    ],
    cursor: { stageId: "implement", state: "running", input: null, activatedBy: null },
    state: "running",
    ...over,
  } as unknown as Pipeline;
}

test("a stage conversation knows its position, and only the pipeline's current stage is `current`", () => {
  const current = stagePosition([pipeline()], "/implement.jsonl");
  expect(current).not.toBeNull();
  expect({ k: current!.k, n: current!.n, current: current!.current }).toEqual({ k: 2, n: 3, current: true });

  /* A stage that already ran keeps its position and loses the `k/n` badge —
     the bar says where the pipeline IS, not where this conversation was. */
  const earlier = stagePosition([pipeline()], "/design.jsonl");
  expect({ k: earlier!.k, n: earlier!.n, current: earlier!.current }).toEqual({ k: 1, n: 3, current: false });

  /* A completed pipeline is nobody's current stage. */
  const done = stagePosition([pipeline({ state: "completed" } as Partial<Pipeline>)], "/implement.jsonl");
  expect(done!.current).toBe(false);

  /* A closed pipeline is not consulted at all, and a conversation outside every
     pipeline has no position. */
  expect(stagePosition([pipeline({ state: "closed" } as Partial<Pipeline>)], "/implement.jsonl")).toBeNull();
  expect(stagePosition([pipeline()], "/elsewhere.jsonl")).toBeNull();
});

test("a review-loop stage matches by flow id, since the board folds its reviewer transcript into the deck", () => {
  const withFlow = pipeline({
    runs: [{ stageId: "review", attempts: [{ n: 1, state: "reviewing", agentPath: "/reviewer.jsonl", flowId: "flow-9" }] }],
    cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null },
  } as unknown as Partial<Pipeline>);
  const position = stagePosition([withFlow], null, "flow-9");
  expect(position).not.toBeNull();
  expect({ k: position!.k, n: position!.n, current: position!.current }).toEqual({ k: 3, n: 3, current: true });
});

test("a host stopped after its turn settled is the finished conversation it is, not a killed one (#1487)", () => {
  const settled = { ...base(), proc: "killed", lastTurn: { startedAt: NOW_MS - 600_000, endedAt: NOW_MS - 120_000 } } as FileEntry;
  expect(chatState(settled, { nowMs: NOW_MS })).toBe("done");
  const bits = chatStateBits(t, settled, { nowMs: NOW_MS });
  expect(bits.tone).toBe("neutral");
  expect(bits.phrase).toContain("stateDone");
  /* A child that returned to its parent keeps the accent reading. */
  expect(chatState({ ...settled, parent: "/root.jsonl", activity: "recent" } as FileEntry, { nowMs: NOW_MS })).toBe("returned");
  /* No evidence of an open turn reads settled: the alarming word is earned. */
  expect(chatState({ ...base(), proc: "killed" } as FileEntry, { nowMs: NOW_MS })).toBe("done");
  /* A dead host over a fresh transcript is not working. */
  expect(chatState({ ...settled, activity: "live", lastTurn: undefined } as FileEntry, { nowMs: NOW_MS })).toBe("done");
  /* The killed phrase carries the age and says nothing about a queue. */
  const dead = chatStateBits(t, SIGNAL.killed(base()), { nowMs: NOW_MS });
  expect(dead.key).toBe("killed");
  expect(dead.tone).toBe("danger");
  expect(dead.phrase).toMatch(/^mobile2\.chat\.stateKilledAge\(age=/);
  expect(translate("en", "mobile2.chat.stateKilledAge", { age: "14m ago" })).toBe("killed · 14m ago");
  expect(translate("en", "mobile2.chat.stateKilledAge", { age: "14m ago" })).not.toMatch(/queue/);
});

test("the held phrase counts its messages with the right plural at 1 and at n, in both locales (#1487)", () => {
  const one = SIGNAL.held(base());
  one.migration = { ...one.migration!, heldDeliveries: 1 };
  expect(chatStateBits(t, one, { nowMs: NOW_MS }).phrase).toBe("mobile2.chat.stateHeldQueued(count=1)");
  expect(chatStateBits(t, SIGNAL.held(base()), { nowMs: NOW_MS }).phrase).toBe("mobile2.chat.stateHeldQueued(count=2)");
  expect(translate("en", "mobile2.chat.stateHeldQueued", { count: 1 })).toBe("held · 1 message queued");
  expect(translate("en", "mobile2.chat.stateHeldQueued", { count: 4 })).toBe("held · 4 messages queued");
  expect(translate("uk", "mobile2.chat.stateHeldQueued", { count: 1 })).toBe("утримано · 1 повідомлення в черзі");
  expect(translate("uk", "mobile2.chat.stateHeldQueued", { count: 5 })).toBe("утримано · 5 повідомлень у черзі");
});

test("held covers both authorities: the account-switch fence and a stuck delivery", () => {
  /* The fence, with the registry's unsettled count. */
  const fenced = chatStateBits(t, SIGNAL.held(base()), { nowMs: NOW_MS });
  expect(fenced.key).toBe("held");
  expect(fenced.phrase).toContain("count=2");

  /* And a delivery the outbox is still holding past the queue's wait: one
     reservation, one message, and — the point — not "working". */
  const stuck = {
    ...base(),
    activity: "live",
    stuckDelivery: { since: new Date(NOW_MS - 10 * 60_000).toISOString(), attempts: 2, state: "held" },
  } as FileEntry;
  expect(chatState({ ...base(), activity: "live" } as FileEntry, { nowMs: NOW_MS })).toBe("working");
  const bits = chatStateBits(t, stuck, { nowMs: NOW_MS });
  expect(bits.key).toBe("held");
  expect(bits.tone).toBe("warning");
  expect(bits.phrase).toContain("count=1");

  /* A delivery that has only just been admitted is not yet a hold. */
  const fresh = { ...stuck, stuckDelivery: { since: new Date(NOW_MS).toISOString(), attempts: 1, state: "held" } } as FileEntry;
  expect(chatState(fresh, { nowMs: NOW_MS })).toBe("working");
});
