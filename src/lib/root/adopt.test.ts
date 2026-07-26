import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile, type NativeGeneration } from "@/lib/accounts/migration/contracts";
import type { RegistryConversation } from "@/lib/agent/registry";

import { adoptLiveRootSession, liveRootSession, type RootSessionSource } from "./adopt";
import { readRootLineage, rootIdentity } from "./store";

/*
 * #688 D5. The lineage arithmetic was already built and tested; what was
 * missing was anything that told it which session the operator is talking to,
 * so the file carried a minted rootId over an empty session list — a stable
 * identity with no chain to survive a rollover with.
 *
 * The fixtures below are real `RegistryConversation` values with real
 * `LaunchProfile`s, not a hand-written slice: the whole defect this closes was
 * reading a field the registry never writes `root` into, and a fixture that
 * invents the field it reads would pass against exactly that bug.
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

function generation(id: string, transcript: string, role: "root" | "worker"): NativeGeneration {
  return {
    id,
    path: transcript,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: "/repo", role }),
    historyHash: null,
    host: null,
    createdAt: "2026-07-01T09:00:00.000Z",
    archivedAt: null,
  };
}

/** A registry conversation exactly as the registry holds one. Typed as the real
    thing, so a change to that shape breaks this rather than passing silently. */
function conversation(input: {
  id: string;
  role: "root" | "worker";
  /** Role-preset id. The operator's root has NONE — that is what defines it. */
  agentRole?: string | null;
  /** One entry per generation. Empty means the transcript has not landed yet. */
  paths?: string[];
  updatedAt: string;
}): RegistryConversation {
  const paths = input.paths ?? [];
  return {
    id: input.id as RegistryConversation["id"],
    engine: "claude",
    generations: paths.map((transcript, index) => generation(`${input.id}_g${index}`, transcript, input.role)),
    continuityPaths: [],
    abandonedContinuityPaths: [],
    projectOwnership: null,
    migration: null,
    migrationOptOut: null,
    supersededBy: null,
    agentRole: input.agentRole ?? null,
    delegationDepth: null,
    turn: { state: "idle", source: "empty", terminalAt: null, observedAt: null },
    createdAt: "2026-07-01T09:00:00.000Z",
    updatedAt: input.updatedAt,
  };
}

function source(conversations: RegistryConversation[], configuredRootId: string | null = null): RootSessionSource {
  /* Handed over the way `rootSessionSource()` in the MCP bindings hands it
     over: the registry's own values, with no field mapping in between. */
  return { conversations, configuredRootId };
}

const worker = conversation({
  id: "conversation_worker",
  role: "worker",
  agentRole: "builder",
  paths: ["/tmp/worker.jsonl"],
  updatedAt: "2026-07-01T09:00:00.000Z",
});
const root = conversation({
  id: "conversation_root",
  role: "root",
  paths: ["/tmp/root.jsonl"],
  updatedAt: "2026-07-01T10:00:00.000Z",
});

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

test("the root is the launch-profile role, which is the only place the registry writes it", () => {
  /* `agentRole` is the role-PRESET id and has no `root` member: the operator's
     own session is the one with no preset at all. A conversation carrying that
     string as a preset is still a worker, and the durable profile is what says
     so — this is the exact confusion that left the lineage empty in production. */
  const impostor = conversation({
    id: "conversation_impostor",
    role: "worker",
    agentRole: "root",
    paths: ["/tmp/impostor.jsonl"],
    updatedAt: "2026-07-01T11:00:00.000Z",
  });

  expect(liveRootSession(source([impostor]))).toBeNull();
  expect(liveRootSession(source([impostor, root]))).toEqual({
    conversationId: "conversation_root",
    path: "/tmp/root.jsonl",
  });
});

test("a rollover appends a linked successor and keeps the same stable identity", () => {
  adoptLiveRootSession(source([root]));
  const identity = readRootLineage()!.rootId;

  const successor = conversation({
    id: "conversation_root_2",
    role: "root",
    paths: ["/tmp/root-2.jsonl"],
    updatedAt: "2026-07-01T11:00:00.000Z",
  });
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

test("a resume in place carries the role forward and the newest generation names the transcript", () => {
  /* A resume writes a second generation on the SAME conversation with the role
     copied onto it. Reading the role off the oldest generation, or off none,
     would drop the root the first time the operator resumes it. */
  const resumed = conversation({
    id: "conversation_root",
    role: "root",
    paths: ["/tmp/root.jsonl", "/tmp/root-resumed.jsonl"],
    updatedAt: "2026-07-01T12:00:00.000Z",
  });

  adoptLiveRootSession(source([root]));
  const adoption = adoptLiveRootSession(source([resumed]));

  /* Same conversation, so the head settles onto the new transcript rather than
     rolling over — the stable identity never moved. */
  expect(adoption!.outcome).toBe("settled");
  expect(readRootLineage()!.sessions).toHaveLength(1);
  expect(readRootLineage()!.sessions[0]!.path).toBe("/tmp/root-resumed.jsonl");
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
  /* Before the engine writes a transcript the conversation has no generation at
     all — and therefore no launch profile to read a role from, so the operator's
     configured id is the only thing that can name it this early. */
  const pathless = conversation({ id: "conversation_root", role: "root", updatedAt: "2026-07-01T10:00:00.000Z" });

  adoptLiveRootSession(source([pathless], "conversation_root"));
  expect(readRootLineage()!.sessions[0]!.path).toBeNull();

  /* And the path settling later is a change worth recording, not a new session. */
  const adoption = adoptLiveRootSession(source([root]));
  expect(adoption!.outcome).toBe("settled");
  expect(readRootLineage()!.sessions).toHaveLength(1);
  expect(readRootLineage()!.sessions[0]!.path).toBe("/tmp/root.jsonl");
});
