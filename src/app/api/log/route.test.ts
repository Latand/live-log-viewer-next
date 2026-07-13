import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { ownerTranscriptMayExist, transcriptDeletionBlocker } from "@/lib/scanner/deleteSafety";

function entry(path: string, proc: FileEntry["proc"], activity: FileEntry["activity"]): FileEntry {
  return {
    path, root: "claude-projects", name: path, project: "project-a", title: "Session",
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1, size: 1,
    activity, proc, pid: null, model: null, pendingQuestion: null, waitingInput: null,
  };
}

test("deleting a Claude subagent is refused while its owning session is active", async () => {
  const child = "/projects/project-a/session-1/subagents/agent-child.jsonl";
  const owner = "/projects/project-a/session-1.jsonl";
  const blocker = await transcriptDeletionBlocker(child, {
    ownerPath: () => owner,
    ownerExists: async () => true,
    processMayBeRunning: () => false,
    list: async (pin) => pin === owner
      ? [entry(owner, "running", "live")]
      : [entry(child, null, "recent")],
  });

  expect(blocker).toBe("owning agent is still running — stop the process first");
});

test("deleting a live transcript is refused when PID attribution is absent", async () => {
  const target = "/projects/project-a/session-2.jsonl";
  const blocker = await transcriptDeletionBlocker(target, {
    ownerPath: () => null,
    ownerExists: async () => false,
    processMayBeRunning: () => false,
    list: async () => [entry(target, null, "live")],
  });

  expect(blocker).toBe("agent is still running — stop the process first");
});

test("deletion refuses an idle transcript with fresh process ownership evidence", async () => {
  const target = "/projects/project-a/session-3.jsonl";
  const blocker = await transcriptDeletionBlocker(target, {
    ownerPath: () => null,
    ownerExists: async () => false,
    processMayBeRunning: () => true,
    list: async () => [entry(target, null, "idle")],
  });

  expect(blocker).toBe("agent is still running — stop the process first");
});

test("owner lookup treats confirmed disappearance as absent and transient stat failures as present", async () => {
  const missing = async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); };
  const uncertain = async () => { throw Object.assign(new Error("busy"), { code: "EMFILE" }); };

  expect(await ownerTranscriptMayExist("/owner.jsonl", missing)).toBe(false);
  expect(await ownerTranscriptMayExist("/owner.jsonl", uncertain)).toBe(true);
});
