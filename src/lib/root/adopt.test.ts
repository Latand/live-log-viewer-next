import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { adoptLiveRootSession, liveRootSession, type RootSessionSource } from "./adopt";
import { readRootLineage, rootIdentity } from "./store";

/*
 * #688 D5. The lineage arithmetic was already built and tested; what was
 * missing was anything that told it which session the operator is talking to,
 * so the file carried a minted rootId over an empty session list — a stable
 * identity with no chain to survive a rollover with.
 */

let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-root-adopt-"));
  process.env.LLV_STATE_DIR = sandbox;
});
afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function source(
  conversations: { id: string; agentRole: string | null; path: string | null; updatedAt: string }[],
  configuredRootId: string | null = null,
): RootSessionSource {
  return {
    conversations: conversations.map((conversation) => ({
      id: conversation.id,
      agentRole: conversation.agentRole,
      generations: conversation.path ? [{ path: conversation.path }] : [],
      updatedAt: conversation.updatedAt,
    })),
    configuredRootId,
  };
}

const worker = { id: "conversation_worker", agentRole: "builder", path: "/tmp/worker.jsonl", updatedAt: "2026-07-01T09:00:00.000Z" };
const root = { id: "conversation_root", agentRole: "root", path: "/tmp/root.jsonl", updatedAt: "2026-07-01T10:00:00.000Z" };

test("the live root session is recorded, so the identity has a chain instead of an empty list", () => {
  const before = rootIdentity();
  expect(readRootLineage()!.sessions).toEqual([]);

  const adoption = adoptLiveRootSession(source([worker, root]));

  expect(adoption!.outcome).toBe("created");
  /* The identity itself is untouched: it is what in-flight requests were
     written against, so minting a replacement would orphan every one of them. */
  expect(readRootLineage()!.rootId).toBe(before);
  expect(readRootLineage()!.sessions).toEqual([{
    conversationId: "conversation_root",
    path: "/tmp/root.jsonl",
    startedAt: expect.any(String) as unknown as string,
  }]);
});

test("a rollover appends a linked successor and keeps the same stable identity", () => {
  adoptLiveRootSession(source([root]));
  const identity = readRootLineage()!.rootId;

  const successor = { id: "conversation_root_2", agentRole: "root", path: "/tmp/root-2.jsonl", updatedAt: "2026-07-01T11:00:00.000Z" };
  const adoption = adoptLiveRootSession(source([root, successor]));

  expect(adoption!.outcome).toBe("rolled-over");
  expect(readRootLineage()!.rootId).toBe(identity);
  const sessions = readRootLineage()!.sessions;
  expect(sessions.map((session) => session.conversationId)).toEqual(["conversation_root", "conversation_root_2"]);
  expect(sessions[0]!.endedAt).toEqual(expect.any(String));
  /* The successor records what it continues from — that link is the whole
     point: a request raised before the rollover still resolves after it. */
  expect(sessions[1]!.seededFrom).toBe("conversation_root");
});

test("re-reporting the same session writes nothing, so a raise is not a serialized write", () => {
  adoptLiveRootSession(source([root]));
  const revision = readRootLineage()!.revision;

  expect(adoptLiveRootSession(source([root]))).toBeNull();
  expect(readRootLineage()!.revision).toBe(revision);
});

test("only the root is ever adopted, and a board with none adopts nothing", () => {
  expect(liveRootSession(source([worker]))).toBeNull();
  expect(adoptLiveRootSession(source([worker]))).toBeNull();
  expect(readRootLineage()).toBeNull();

  /* The operator's configured id wins over the role, which is how a rollover is
     followed the moment they re-point it. */
  expect(liveRootSession(source([worker, root], "conversation_worker"))).toEqual({
    conversationId: "conversation_worker",
    path: "/tmp/worker.jsonl",
  });
});

test("a root session whose transcript has not landed yet is adopted path-pending", () => {
  const pathless = { id: "conversation_root", agentRole: "root", path: null, updatedAt: "2026-07-01T10:00:00.000Z" };

  adoptLiveRootSession(source([pathless]));
  expect(readRootLineage()!.sessions[0]!.path).toBeNull();

  /* And the path settling later is a change worth recording, not a new session. */
  const adoption = adoptLiveRootSession(source([root]));
  expect(adoption!.outcome).toBe("settled");
  expect(readRootLineage()!.sessions).toHaveLength(1);
  expect(readRootLineage()!.sessions[0]!.path).toBe("/tmp/root.jsonl");
});
