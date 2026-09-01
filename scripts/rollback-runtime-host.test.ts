import fs from "node:fs";
import { expect, test } from "bun:test";

import { parseRollbackArguments } from "./rollback-runtime-host";

const source = fs.readFileSync(new URL("./rollback-runtime-host.ts", import.meta.url), "utf8");

test("issue 1270: runtime-host rollback plans by default and needs explicit execution", () => {
  expect(parseRollbackArguments([])).toEqual({ execute: false });
  expect(parseRollbackArguments(["--execute"])).toEqual({ execute: true });
  expect(() => parseRollbackArguments(["--force"])).toThrow("unsupported option --force");
});

test("issue 1270: rollback starts from durable state without the failing listener", () => {
  expect(source).toContain("readRuntimeHostRollbackTarget");
  expect(source).toContain("runtimeHostRollbackTargetFromHandoff");
  expect(source).toContain("requestRuntimeHostRollback");
  expect(source).not.toContain("runtime-host.sock");
  expect(source).not.toContain("scripts/rebuild.sh");
  expect(source).not.toContain("fetch(");
  expect(source).not.toContain("curl");
});
