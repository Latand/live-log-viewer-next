import { expect, test } from "bun:test";
import fs from "node:fs";

import {
  captureProcessIdentity,
  processIdentityProvenDead,
  processIdentityStatus,
  systemBootEpoch,
  type ProcessIdentityProbe,
} from "./processIdentity";

function probe(overrides: Partial<ProcessIdentityProbe> = {}): ProcessIdentityProbe {
  return {
    pidAlive: () => true,
    processIdentity: (pid) => `${pid}:start`,
    bootEpoch: () => "boot-current",
    ...overrides,
  };
}

test("a matching pid and start token from an earlier boot is provably dead", () => {
  expect(processIdentityStatus({
    pid: 42,
    startIdentity: "42:start",
    bootEpoch: "boot-earlier",
  }, probe())).toBe("dead");
});

test("a recycled pid with a different start token is provably dead", () => {
  expect(processIdentityStatus({
    pid: 42,
    startIdentity: "42:earlier",
    bootEpoch: "boot-current",
  }, probe())).toBe("dead");
});

test("a complete matching identity is verified alive", () => {
  expect(processIdentityStatus({
    pid: 42,
    startIdentity: "42:start",
    bootEpoch: "boot-current",
  }, probe())).toBe("alive");
});

test("a legacy identity with no boot epoch stays unverified while its pid matches", () => {
  expect(processIdentityStatus({ pid: 42, startIdentity: "42:start" }, probe())).toBe("unverified");
});

test("an unreadable live pid stays outside proven-dead authority", () => {
  const identity = { pid: 42, startIdentity: "42:start", bootEpoch: "boot-current" };
  expect(processIdentityProvenDead(identity, probe({ processIdentity: () => null }))).toBeFalse();
});

test("an absent pid is proven dead", () => {
  const identity = { pid: 42, startIdentity: "42:start", bootEpoch: "boot-current" };
  expect(processIdentityProvenDead(identity, probe({ pidAlive: () => false }))).toBeTrue();
});

test("capture records pid, start token, and boot epoch together", () => {
  expect(captureProcessIdentity(42, probe())).toEqual({
    pid: 42,
    startIdentity: "42:start",
    bootEpoch: "boot-current",
  });
});

test.skipIf(process.platform !== "linux")("the Linux boot epoch binds the current pid namespace", () => {
  const namespace = fs.readlinkSync("/proc/self/ns/pid");
  expect(systemBootEpoch()).toContain(`pidns:${namespace}`);
});
