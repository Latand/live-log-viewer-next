import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { writeSessionTitle } from "@/lib/session/titleStore";
import type { FileEntry } from "@/lib/types";

import { collectSnapshot } from "./collect";
import { resetPresenceForTest, upsertPresence } from "./presenceStore";
import type { PresencePayloadV1, SnapshotRequestV1, ViewerSnapshotV1 } from "./types";

const UUID = "aaaaaaaa-1111-4111-8111-111111111111";
const SESSION_PATH = `/home/u/.claude/projects/proj/${UUID}.jsonl`;

let stateDir = "";
let registryRoot = "";
const previousState = process.env.LLV_STATE_DIR;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-collect-"));
  registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llv-collect-reg-"));
  process.env.LLV_STATE_DIR = stateDir;
  setAgentRegistryForTests(new AgentRegistry(path.join(registryRoot, "registry.json")));
  resetPresenceForTest();
});

afterEach(() => {
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  setAgentRegistryForTests(null);
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(registryRoot, { recursive: true, force: true });
});

function file(pathname: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return { path: pathname, root: "claude-projects", name: path.basename(pathname), project: "viewer", title: pathname, engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1, size: 1, activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null, ...overrides };
}

function presence(overrides: Partial<PresencePayloadV1> = {}): PresencePayloadV1 {
  return { schemaVersion: 1, viewSessionId: "view-a", deviceId: "desktop", device: { kind: "desktop", browser: "chrome" }, visibility: "visible", sequence: 1, inputSequence: 1, project: "viewer", mode: "scheme", viewport: { width: 100, height: 100, dpr: 1 }, camera: null, focusedPath: SESSION_PATH, selectedPaths: [], visiblePaths: [SESSION_PATH], board: { renderedRevision: 1, durableRevision: 1, sync: "current" }, ...overrides };
}

// Siblings that echo each file's title, so we can assert the overlay ran before
// sibling resolution.
const echoingSiblings = async (_caller: SnapshotRequestV1["caller"], files: FileEntry[]): Promise<ViewerSnapshotV1["siblings"]> => ({
  selfResolution: "omitted",
  agents: files.map((entry) => ({ transcriptPath: entry.path, engine: "claude", project: entry.project, title: entry.title, activity: entry.activity, pid: 0, self: false })),
});

test("the agent snapshot shows the custom title on conversations and siblings", async () => {
  writeSessionTitle([`uuid:claude:${UUID}`], `uuid:claude:${UUID}`, "Renamed by user", undefined, "t1");
  const now = Date.now();
  upsertPresence(presence(), now);

  const snapshot = await collectSnapshot(
    { schemaVersion: 1 },
    {
      observeFiles: async () => [file(SESSION_PATH, { title: "derived from first prompt" })],
      resolveSiblings: echoingSiblings,
    },
  );

  const conversation = snapshot.conversations.find((card) => card.path === SESSION_PATH);
  expect(conversation?.title).toBe("Renamed by user");
  const sibling = snapshot.siblings.agents.find((agent) => agent.transcriptPath === SESSION_PATH);
  expect(sibling?.title).toBe("Renamed by user");
});
