import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fileTailHasNeedle } from "./needle";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-needle-test-"));

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("a same-size transcript rewrite replaces the cached UUID generation", () => {
  const pathname = path.join(SANDBOX, "rewritten.jsonl");
  const first = "11111111-2222-0333-0444-555555555555";
  const second = "aaaaaaaa-bbbb-0ccc-0ddd-eeeeeeeeeeee";
  fs.writeFileSync(pathname, `${JSON.stringify({ uuid: first })}\n`);

  expect(fileTailHasNeedle(first, pathname)).toBe(true);

  fs.writeFileSync(pathname, `${JSON.stringify({ uuid: second })}\n`);
  const future = new Date(Date.now() + 2_000);
  fs.utimesSync(pathname, future, future);

  expect(fileTailHasNeedle(first, pathname)).toBe(false);
  expect(fileTailHasNeedle(second, pathname)).toBe(true);
});
