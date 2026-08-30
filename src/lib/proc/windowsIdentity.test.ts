import { expect, test } from "bun:test";

import { parseWindowsCreationIdentity, windowsProcessIdentity } from "./windowsIdentity";

/** FILETIME of 2026-01-01T00:00:00Z — a plausible creation time. */
const PLAUSIBLE = BigInt("133776864000000000");

function filetime(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
}

test("the token is the pid and the kernel's creation FILETIME", () => {
  expect(parseWindowsCreationIdentity(4321, filetime(PLAUSIBLE), true)).toBe(`4321:${PLAUSIBLE}`);
});

test("a failed read is no identity, never a token built from a zeroed buffer", () => {
  /* This is the whole point of the token: a caller that cannot read the
     creation time must learn nothing rather than learn something reusable. A
     zeroed buffer would otherwise mint `pid:0`, which every process that fails
     the same way would share, and the fence would treat two different processes
     as the same owner. */
  expect(parseWindowsCreationIdentity(4321, filetime(PLAUSIBLE), false)).toBeNull();
  expect(parseWindowsCreationIdentity(4321, filetime(BigInt(0)), true)).toBeNull();
  expect(parseWindowsCreationIdentity(4321, Buffer.alloc(4), true)).toBeNull();
});

test("a creation time before 2000 is not a creation time", () => {
  expect(parseWindowsCreationIdentity(4321, filetime(BigInt("125911583999999999")), true)).toBeNull();
  expect(parseWindowsCreationIdentity(4321, filetime(BigInt("125911584000000000")), true))
    .toBe("4321:125911584000000000");
});

test("a pid that cannot be signalled cannot have an identity", () => {
  expect(parseWindowsCreationIdentity(0, filetime(PLAUSIBLE), true)).toBeNull();
  expect(parseWindowsCreationIdentity(-1, filetime(PLAUSIBLE), true)).toBeNull();
  expect(windowsProcessIdentity(0)).toBeNull();
  expect(windowsProcessIdentity(-7)).toBeNull();
});

test("the token carries the pid prefix the CLI's fence-owner check requires", () => {
  const token = parseWindowsCreationIdentity(908, filetime(PLAUSIBLE), true)!;
  expect(token.startsWith("908:")).toBe(true);
});

test.if(process.platform === "win32")("the kernel reader answers for this process, stably", () => {
  const mine = windowsProcessIdentity(process.pid);
  expect(mine).toBeString();
  expect(mine!.startsWith(`${process.pid}:`)).toBe(true);
  // Fixed for the life of the process: two reads cannot disagree.
  expect(windowsProcessIdentity(process.pid)).toBe(mine!);
});

test.if(process.platform !== "win32")("the reader is inert off Windows rather than throwing", () => {
  expect(windowsProcessIdentity(process.pid)).toBeNull();
});
