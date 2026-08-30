import { expect, test } from "bun:test";

import { parseWindowsProcessParametersCwd } from "./windowsCwd";

/*
 * The offsets into another process's `RTL_USER_PROCESS_PARAMETERS`, asserted
 * against a hand-built block. The live read is `windows.test.ts` on the
 * `windows-latest` leg; this file is what says which byte means what, on every
 * platform.
 */

/** x64: `CurrentDirectory.DosPath` is a UNICODE_STRING at 0x38 (Buffer at 0x40). */
const DOSPATH_AT = 0x38;
const HEAD_BYTES = 0x50;

function parametersBlock(path: string | null, address = BigInt("0x7ff000001000")): Buffer {
  const block = Buffer.alloc(HEAD_BYTES);
  const bytes = path === null ? 0 : Buffer.from(path, "utf16le").byteLength;
  block.writeUInt16LE(bytes, DOSPATH_AT);
  block.writeUInt16LE(bytes + 2, DOSPATH_AT + 2);
  block.writeBigUInt64LE(path === null ? BigInt(0) : address, DOSPATH_AT + 8);
  return block;
}

test("the DosPath is read from its own UNICODE_STRING, at the length it declares", () => {
  const cwd = "C:\\work\\project";
  const block = parametersBlock(cwd);
  const reads: Array<{ address: bigint; size: number }> = [];

  const resolved = parseWindowsProcessParametersCwd(block, (address, size) => {
    reads.push({ address, size });
    /* The path is not NUL-terminated in the target, and the buffer around it is
       arbitrary memory — reading past `Length` would append garbage. */
    return Buffer.concat([Buffer.from(cwd, "utf16le"), Buffer.from("\u0000junk", "utf16le")]).subarray(0, size);
  });

  expect(resolved).toBe(cwd);
  expect(reads).toEqual([{ address: BigInt("0x7ff000001000"), size: Buffer.from(cwd, "utf16le").byteLength }]);
});

test("a block that says nothing readable resolves to nothing", () => {
  const never = (): Buffer | null => {
    throw new Error("must not read the target's memory");
  };
  expect(parseWindowsProcessParametersCwd(parametersBlock(null), never)).toBeNull();
  expect(parseWindowsProcessParametersCwd(Buffer.alloc(8), never)).toBeNull();

  // A declared length that is not a whole number of UTF-16 units is a torn read.
  const odd = parametersBlock("C:\\x");
  odd.writeUInt16LE(7, DOSPATH_AT);
  expect(parseWindowsProcessParametersCwd(odd, never)).toBeNull();

  // So is one longer than a Windows path can be.
  const huge = parametersBlock("C:\\x");
  huge.writeUInt16LE(0xfffe, DOSPATH_AT);
  expect(parseWindowsProcessParametersCwd(huge, never)).toBeNull();
});

test("a refused or short memory read is not a partial path", () => {
  const cwd = "C:\\work";
  expect(parseWindowsProcessParametersCwd(parametersBlock(cwd), () => null)).toBeNull();
  expect(parseWindowsProcessParametersCwd(parametersBlock(cwd), () => Buffer.alloc(4))).toBeNull();
});
