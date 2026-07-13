import { expect, test } from "bun:test";

import { sourceCwdStatus } from "./sourceCwd";

test("source cwd status preserves the recorded cwd when its checkout was deleted", () => {
  const reads: string[] = [];
  const sourcePath = "/sessions/source.jsonl";
  const recordedCwd = "/repos/project/.worktrees/deleted-branch";

  expect(sourceCwdStatus(sourcePath, {
    transcriptAllowed: () => true,
    readCwd: (pathname) => {
      reads.push(pathname);
      return recordedCwd;
    },
    isDirectory: () => false,
  })).toEqual({ cwd: recordedCwd, cwdExists: false });
  expect(reads).toEqual([sourcePath]);
});
