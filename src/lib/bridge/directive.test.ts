import { expect, test } from "bun:test";

import {
  bridgeDirectiveBody,
  bridgeDirectiveId,
  formatBridgeTrailer,
  parseBridgeTrailer,
} from "./directive";

test("directive ids derive from the root turn and utterance index, not from a clock", () => {
  expect(bridgeDirectiveId("turn_91", 0)).toBe("bridge_d_turn_91_0");
  expect(bridgeDirectiveId("turn_91", 0)).toBe(bridgeDirectiveId("turn_91", 0));
  expect(bridgeDirectiveId("turn_91", 1)).not.toBe(bridgeDirectiveId("turn_91", 0));
});

test("a directive id refuses input that would break its own parse", () => {
  expect(() => bridgeDirectiveId("", 0)).toThrow(/root turn/);
  expect(() => bridgeDirectiveId("turn 91", 0)).toThrow(/root turn/);
  expect(() => bridgeDirectiveId("turn_91", -1)).toThrow(/utterance/);
  expect(() => bridgeDirectiveId("turn_91", 1.5)).toThrow(/utterance/);
});

test("the trailer round-trips a correlation reference", () => {
  const trailer = formatBridgeTrailer({ ref: 42 });
  expect(trailer).toBe("[bridge ref=42]");
  expect(parseBridgeTrailer(trailer)).toEqual({ ref: 42 });
});

test("the trailer is read off the last line, so ordinary prose above it survives", () => {
  const body = bridgeDirectiveBody("Deploy it.", { ref: 7 });
  expect(body).toBe("Deploy it.\n\n[bridge ref=7]");
  expect(parseBridgeTrailer(body)).toEqual({ ref: 7 });
});

test("prose that merely mentions a bridge trailer earlier is not a trailer", () => {
  const body = "The manager said [bridge ref=1] earlier.\nPlease start a reviewer.";
  expect(parseBridgeTrailer(body)).toBeNull();
});

test("a directive without a trailer parses as no correlation", () => {
  expect(parseBridgeTrailer("Start a reviewer on the auth branch.")).toBeNull();
  expect(bridgeDirectiveBody("Start a reviewer.")).toBe("Start a reviewer.");
});

test("a malformed trailer is not read as a partial correlation", () => {
  expect(parseBridgeTrailer("[bridge ref=abc]")).toBeNull();
  expect(parseBridgeTrailer("[bridge ref=0]")).toBeNull();
  expect(parseBridgeTrailer("[bridge ref=7 sha=deadbeef]")).toBeNull();
  expect(() => formatBridgeTrailer({ ref: 0 })).toThrow(/report seq/);
});
