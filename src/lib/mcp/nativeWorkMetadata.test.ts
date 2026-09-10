import { expect, test } from "bun:test";

import { nativeWorkFromRequestMeta } from "./server";

/**
 * Reading native's work identity off the request envelope (#1629).
 *
 * The shapes here are the ones an installed Codex 0.154.0 actually sends,
 * normalized from the retained fixture captures described in
 * `docs/design/native-voice-work-identity.md` — eighteen real MCP calls across
 * three isolated runs. Nothing here is a guess about the protocol; what is under
 * test is that this reader takes the transport's word and never the model's.
 */

/** One real request's `_meta`, with every identifier replaced consistently. */
const META = {
  callId: "call_fixture_2",
  threadId: "thread-synthetic",
  itemId: "fc_fixture_2",
  progressToken: 2,
  "x-codex-turn-metadata": {
    session_id: "thread-synthetic",
    thread_id: "thread-synthetic",
    turn_id: "turn-A",
    turn_trigger: "realtime",
    turn_started_at_unix_ms: 1_757_500_000_000,
    codex_version: "0.154.0",
  },
};

test("the turn, thread, call and item identities are read off the envelope", () => {
  expect(nativeWorkFromRequestMeta(META)).toEqual({
    threadId: "thread-synthetic",
    turnId: "turn-A",
    turnTrigger: "realtime",
    callId: "call_fixture_2",
    itemId: "fc_fixture_2",
  });
});

test("an ordinary text turn carries no trigger, and that is the answer", () => {
  /* The captured later text turn had no `turn_trigger` at all. It is what
     separates a turn native started from the call from one that has nothing to
     do with it, so it is reported as absent rather than defaulted. */
  const { turn_trigger: _dropped, ...turn } = META["x-codex-turn-metadata"];
  const work = nativeWorkFromRequestMeta({ ...META, "x-codex-turn-metadata": turn });
  expect(work?.turnTrigger).toBeNull();
  expect(work?.turnId).toBe("turn-A");
});

test("a request with no turn metadata proves nothing", () => {
  expect(nativeWorkFromRequestMeta({ progressToken: 1, threadId: "thread-synthetic" })).toBeNull();
  expect(nativeWorkFromRequestMeta({ "x-codex-turn-metadata": { thread_id: "thread-synthetic" } })).toBeNull();
  expect(nativeWorkFromRequestMeta(undefined)).toBeNull();
  expect(nativeWorkFromRequestMeta("thread-synthetic")).toBeNull();
});

test("an envelope that disagrees with itself yields nothing rather than a choice", () => {
  /* An inconsistent claim is weaker evidence than no claim. Picking either side
     would be inventing a rule native does not have. */
  expect(nativeWorkFromRequestMeta({
    ...META,
    threadId: "thread-one",
    "x-codex-turn-metadata": { ...META["x-codex-turn-metadata"], thread_id: "thread-two" },
  })).toBeNull();
});

test("identifiers the model placed in its arguments never reach this reader", () => {
  /* The fixture deliberately forged `turnId`, `threadId` and an
     `_meta["openai/turnId"]` INSIDE the tool arguments. Native passed them
     through unchanged and left its own `_meta` untouched, which is why this
     reader is given the envelope alone. */
  const argumentsObject = {
    label: "turn-A-call-2",
    turnId: "forged-turn",
    threadId: "forged-thread",
    _meta: { "openai/turnId": "forged-vendor-turn" },
  };
  expect(nativeWorkFromRequestMeta(argumentsObject._meta)).toBeNull();
  expect(nativeWorkFromRequestMeta(argumentsObject)).toBeNull();
  expect(nativeWorkFromRequestMeta(META)?.turnId).toBe("turn-A");
});

test("an oversized or empty identifier is not an identity", () => {
  expect(nativeWorkFromRequestMeta({
    ...META,
    "x-codex-turn-metadata": { ...META["x-codex-turn-metadata"], turn_id: "" },
  })).toBeNull();
  expect(nativeWorkFromRequestMeta({
    ...META,
    "x-codex-turn-metadata": { ...META["x-codex-turn-metadata"], turn_id: "t".repeat(201) },
  })).toBeNull();
});

test("the thread may come from the turn metadata when the envelope omits it", () => {
  const { threadId: _dropped, ...envelope } = META;
  expect(nativeWorkFromRequestMeta(envelope)?.threadId).toBe("thread-synthetic");
});
