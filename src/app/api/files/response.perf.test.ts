import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import {
  AgentRegistry,
  setAgentRegistryForTests,
  type RegistryConversation,
} from "@/lib/agent/registry";
import {
  replaceConversationCatalog,
  type ConversationCatalogEntry,
} from "@/lib/scanner/conversationCatalog";
import type { FileEntry, ProjectCatalogEntry } from "@/lib/types";

import { buildFilesResponse } from "./response";

afterEach(() => {
  setAgentRegistryForTests(null);
  replaceConversationCatalog([]);
});

test("a production-shaped files request builds one reusable registry projection and stays byte-stable", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-files-response-production-"));
  try {
    const filename = path.join(directory, "agent-registry.json");
    const seedTranscript = "/fixtures/sessions/seed.jsonl";
    const seed = new AgentRegistry(filename);
    seed.reconcileConversations([{
      engine: "codex",
      path: seedTranscript,
      accountId: null,
      launchProfile: emptyLaunchProfile({
        cwd: "/fixtures/repo",
        project: "fixture-project",
        title: "Fixture session",
      }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-31T00:00:00.000Z",
    }]);
    const production = seed.snapshot();
    const template = Object.values(production.conversations)[0]!;
    production.conversations = {};
    const catalog: ConversationCatalogEntry[] = [];
    for (let index = 0; index < 4_631; index += 1) {
      const suffix = String(index).padStart(12, "0");
      const id = `conversation_fixture_${suffix}` as RegistryConversation["id"];
      const sessionId = `00000000-0000-4000-8000-${suffix}`;
      const transcript = `/fixtures/sessions/${sessionId}.jsonl`;
      const conversation = structuredClone(template);
      conversation.id = id;
      conversation.generations[0] = {
        ...conversation.generations[0]!,
        id: sessionId,
        path: transcript,
      };
      production.conversations[id] = conversation;
      catalog.push({
        path: transcript,
        root: "codex-sessions",
        name: `${sessionId}.jsonl`,
        project: "scanner-project",
        projectName: "Scanner project",
        title: `Fixture ${index}`,
        firstPrompt: "",
        engine: "codex",
        kind: "session",
        fmt: "codex",
        mtime: index + 1,
        size: 3,
      });
    }
    fs.writeFileSync(filename, JSON.stringify(production));
    replaceConversationCatalog(catalog);

    const registry = new AgentRegistry(filename);
    const readOnlySnapshot = registry.readOnlySnapshot.bind(registry);
    let snapshotReads = 0;
    registry.readOnlySnapshot = () => {
      snapshotReads += 1;
      return readOnlySnapshot();
    };
    setAgentRegistryForTests(registry);
    const files = catalog.slice(-433).map(fileFromCatalog);
    const dependencies = {
      listFilesWithProjectCatalog: async () => ({
        files: structuredClone(files),
        projectCatalog: [],
        complete: true,
      }),
    };

    const startedAt = performance.now();
    const first = await buildFilesResponse(new Request("http://127.0.0.1/api/files"), dependencies);
    const durationMs = performance.now() - startedAt;
    const firstBody = await first.text();
    const firstJson = JSON.parse(firstBody) as {
      projectCatalog: ProjectCatalogEntry[];
    };
    const etag = first.headers.get("etag");
    const second = await buildFilesResponse(new Request("http://127.0.0.1/api/files", {
      headers: { "if-none-match": etag! },
    }), dependencies);

    expect(snapshotReads).toBe(2);
    expect(durationMs).toBeLessThan(1_500);
    expect(firstJson.projectCatalog).toEqual([{
      project: "project_unresolved",
      displayName: "Unresolved project",
      repository: null,
      smt: 4_631,
      conversations: 4_631,
    }]);
    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
    expect(await second.text()).toBe("");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fileFromCatalog(entry: ConversationCatalogEntry): FileEntry {
  return {
    ...entry,
    parent: null,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}
