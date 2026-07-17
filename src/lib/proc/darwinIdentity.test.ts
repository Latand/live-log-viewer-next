import { expect, test } from "bun:test";

import { assertDarwinStructuredRuntime, parseDarwinProcBsdInfoIdentity } from "./darwinIdentity";

test("Darwin process identity includes the kernel microsecond start token", () => {
  const buffer = Buffer.alloc(136);
  buffer.writeUInt32LE(4242, 12);
  buffer.writeBigUInt64LE(BigInt(1_721_234_567), 120);
  buffer.writeBigUInt64LE(BigInt(12_345), 128);

  expect(parseDarwinProcBsdInfoIdentity(4242, buffer, buffer.byteLength))
    .toBe("4242:1721234567:012345");
});

test("Darwin process identity rejects incomplete or mismatched kernel records", () => {
  const buffer = Buffer.alloc(136);
  buffer.writeUInt32LE(4243, 12);
  buffer.writeBigUInt64LE(BigInt(1_721_234_567), 120);

  expect(parseDarwinProcBsdInfoIdentity(4242, buffer, buffer.byteLength)).toBeNull();
  expect(parseDarwinProcBsdInfoIdentity(4243, buffer, 135)).toBeNull();
  buffer.writeBigUInt64LE(BigInt(1_000_000), 128);
  expect(parseDarwinProcBsdInfoIdentity(4243, buffer, buffer.byteLength)).toBeNull();
});

test("structured Darwin startup requires the Bun runtime used by the identity reader", () => {
  expect(() => assertDarwinStructuredRuntime("darwin", {})).toThrow("require the Viewer server to run with Bun");
  expect(() => assertDarwinStructuredRuntime("darwin", { bun: "1.3.3" })).not.toThrow();
  expect(() => assertDarwinStructuredRuntime("linux", {})).not.toThrow();
});
