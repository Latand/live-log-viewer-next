import { afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";

import {
  bridgeAcknowledgementFor,
  forgetBridgeAcknowledgement,
  pendingBridgeAcknowledgements,
  rememberBridgeAcknowledgement,
  resetBridgeAcknowledgementsForTests,
} from "./pendingAcknowledgements";

/**
 * A token must outlive the thing that is waiting on it.
 *
 * Both losing paths held tokens somewhere shorter-lived than the confirmation they
 * were waiting for: a component ref that died with the card, and an effect closure
 * torn down by a call-phase change. Either way the confirmation arrived with nothing
 * left to spend, and the reports repeated.
 */

const dom = new Window({ url: "http://localhost/" });

beforeAll(() => {
  (globalThis as Record<string, unknown>).window = dom;
});

afterEach(() => {
  resetBridgeAcknowledgementsForTests();
});

test("a parked token is found again after the holder is gone", () => {
  rememberBridgeAcknowledgement("voice:batch-1", "ack_1");
  expect(bridgeAcknowledgementFor("voice:batch-1")).toBe("ack_1");
});

test("reading does NOT spend it — only an accepted acknowledgement does", () => {
  /* Dropping on the way out was the defect: a refused POST then left the cursor
     parked with nothing able to settle it. */
  rememberBridgeAcknowledgement("voice:batch-1", "ack_1");
  bridgeAcknowledgementFor("voice:batch-1");
  bridgeAcknowledgementFor("voice:batch-1");
  expect(bridgeAcknowledgementFor("voice:batch-1")).toBe("ack_1");

  forgetBridgeAcknowledgement("voice:batch-1");
  expect(bridgeAcknowledgementFor("voice:batch-1")).toBeNull();
});

test("tokens survive a reload, because the confirmation may not", () => {
  rememberBridgeAcknowledgement("voice:batch-1", "ack_1");
  rememberBridgeAcknowledgement("composer-key-2", "ack_2");

  /* Mirrored to storage — that is the survival mechanism, so assert the mirror. */
  const stored = dom.sessionStorage.getItem("llv.bridge.pendingAcks");
  expect(stored).toContain("ack_1");
  expect(stored).toContain("ack_2");

  /* Now the module forgets everything in memory, exactly as a page reload leaves it,
     and the tokens must still be reachable from storage alone. */
  resetInMemoryOnly();
  expect(bridgeAcknowledgementFor("voice:batch-1")).toBe("ack_1");
  expect(pendingBridgeAcknowledgements()).toHaveLength(2);
});

/** Clears the module's in-memory copy WITHOUT touching storage, which is what a page
    reload does — the reset helper wipes both and would hide the regression. */
function resetInMemoryOnly(): void {
  const survived = dom.sessionStorage.getItem("llv.bridge.pendingAcks");
  resetBridgeAcknowledgementsForTests();
  if (survived) dom.sessionStorage.setItem("llv.bridge.pendingAcks", survived);
}

test("the replay set carries everything still unspent", () => {
  rememberBridgeAcknowledgement("voice:batch-1", "ack_1");
  rememberBridgeAcknowledgement("composer-key-2", "ack_2");
  expect(pendingBridgeAcknowledgements()).toEqual([
    { waitingOn: "voice:batch-1", ackToken: "ack_1" },
    { waitingOn: "composer-key-2", ackToken: "ack_2" },
  ]);

  forgetBridgeAcknowledgement("voice:batch-1");
  expect(pendingBridgeAcknowledgements()).toEqual([{ waitingOn: "composer-key-2", ackToken: "ack_2" }]);
});

test("re-parking the same subject replaces its token rather than duplicating it", () => {
  rememberBridgeAcknowledgement("voice:batch-1", "ack_old");
  rememberBridgeAcknowledgement("voice:batch-1", "ack_new");
  expect(pendingBridgeAcknowledgements()).toEqual([{ waitingOn: "voice:batch-1", ackToken: "ack_new" }]);
});

test("the parked set is bounded, so an unspendable token cannot accumulate forever", () => {
  for (let index = 0; index < 40; index += 1) {
    rememberBridgeAcknowledgement(`voice:batch-${index}`, `ack_${index}`);
  }
  const parked = pendingBridgeAcknowledgements();
  expect(parked.length).toBeLessThanOrEqual(32);
  /* The oldest fall off: a dropped token costs a repeated report, never a lost one. */
  expect(parked.at(-1)).toEqual({ waitingOn: "voice:batch-39", ackToken: "ack_39" });
  expect(bridgeAcknowledgementFor("voice:batch-0")).toBeNull();
});

test("empty subjects and tokens are ignored rather than parked", () => {
  rememberBridgeAcknowledgement("", "ack_1");
  rememberBridgeAcknowledgement("voice:batch-1", "");
  expect(pendingBridgeAcknowledgements()).toEqual([]);
});
