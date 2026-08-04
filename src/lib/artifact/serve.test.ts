import { expect, test } from "bun:test";

import { artifactEtag, parseByteRange, sniffAgrees } from "./serve";

test("single byte ranges parse, clamp and reject correctly", () => {
  expect(parseByteRange(null, 1000)).toBeNull();
  expect(parseByteRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
  expect(parseByteRange("bytes=100-", 1000)).toEqual({ start: 100, end: 999 });
  expect(parseByteRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
  /* end beyond the file clamps to the last byte */
  expect(parseByteRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
  /* unsatisfiable → explicit rejection, not a silent full body */
  expect(parseByteRange("bytes=1000-", 1000)).toBe("unsatisfiable");
  expect(parseByteRange("bytes=-0", 1000)).toBe("unsatisfiable");
  /* multi-range and malformed forms fall back to a full response */
  expect(parseByteRange("bytes=0-1,5-9", 1000)).toBeNull();
  expect(parseByteRange("chars=0-99", 1000)).toBeNull();
  expect(parseByteRange("bytes=9-5", 1000)).toBe("unsatisfiable");
});

test("magic bytes must agree with the claimed type", () => {
  const pdf = Buffer.from("%PDF-1.7\n…");
  const png = Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG\r\n"), Buffer.from([0x1a, 0x0a])]);
  const html = Buffer.from("<!DOCTYPE html><script>alert(1)</script>");
  const text = Buffer.from("plain notes\nwith lines\n");
  const nulled = Buffer.from([0x68, 0x69, 0x00, 0x01, 0x02]);

  expect(sniffAgrees("application/pdf", pdf)).toBe(true);
  expect(sniffAgrees("application/pdf", html)).toBe(false);
  expect(sniffAgrees("image/png", png)).toBe(true);
  expect(sniffAgrees("image/png", html)).toBe(false);
  /* text admits anything without NUL bytes… */
  expect(sniffAgrees("text/plain; charset=utf-8", text)).toBe(true);
  expect(sniffAgrees("text/plain; charset=utf-8", html)).toBe(true);
  /* …but a binary blob renamed to .txt is refused */
  expect(sniffAgrees("text/plain; charset=utf-8", nulled)).toBe(false);
  /* svg needs to at least look like markup */
  expect(sniffAgrees("image/svg+xml", Buffer.from('<?xml version="1.0"?><svg xmlns="a"/>'))).toBe(true);
  expect(sniffAgrees("image/svg+xml", nulled)).toBe(false);
  /* an empty file can never agree with a binary signature */
  expect(sniffAgrees("image/png", Buffer.alloc(0))).toBe(false);
  expect(sniffAgrees("text/plain; charset=utf-8", Buffer.alloc(0))).toBe(true);
});

test("the etag pins device, inode, size and mtime", () => {
  const a = artifactEtag({ dev: 1, ino: 2, size: 3, mtimeMs: 4 });
  expect(a).toMatch(/^"[^"]+"$/);
  expect(artifactEtag({ dev: 1, ino: 2, size: 3, mtimeMs: 4 })).toBe(a);
  expect(artifactEtag({ dev: 1, ino: 9, size: 3, mtimeMs: 4 })).not.toBe(a);
  expect(artifactEtag({ dev: 1, ino: 2, size: 9, mtimeMs: 4 })).not.toBe(a);
  expect(artifactEtag({ dev: 1, ino: 2, size: 3, mtimeMs: 9 })).not.toBe(a);
});
