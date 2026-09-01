import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import type { FileEntry } from "@/lib/types";
import { attentionExpiries, attentionId } from "@/components/attention";
import { decisionLine } from "@/components/attention/decision";
import { translate } from "@/lib/i18n";

import { buildFilesResponse } from "./response";

const FIXTURE_MTIME_SECONDS = Date.parse("2026-09-01T09:50:00.000Z") / 1000;

afterEach(() => setAgentRegistryForTests(null));

function scannedFile(pathname: string): FileEntry {
  return {
    path: pathname,
    root: "codex-sessions",
    name: path.basename(pathname),
    project: "delivery-fixture",
    title: "Delivery fixture",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: FIXTURE_MTIME_SECONDS,
    size: 1,
    activity: "live",
    proc: "running",
    pid: 1,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

test("a retried message that parks again keeps its attention entry and clock (#1226)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-delivery-attention-"));
  const transcriptPath = path.join(directory, "recipient.jsonl");
  fs.writeFileSync(transcriptPath, "\n");
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(directory, "state");
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), () => false);
  setAgentRegistryForTests(registry);
  try {
    const conversation = registry.ensureConversation("codex", transcriptPath, "default");
    const operationId = "operation-attention-retry";
    const held = registry.holdDelivery(
      conversation.id,
      "keep this delivery visible",
      "message-attention-retry",
      "text",
      [],
      null,
      { operationId, kind: "send", policy: "queue" },
    );
    const admittedSeconds = Date.parse(held.createdAt) / 1000;
    expect(registry.beginDeliveryAttempt(held.id, held.generationId!)?.state).toBe("delivery-uncertain");
    expect(registry.retryUncertainDeliveryForOperation(operationId)).toMatchObject({
      id: held.id,
      state: "assigned",
      command: { operationId },
    });
    expect(registry.beginDeliveryAttempt(held.id, held.generationId!)).toMatchObject({
      state: "delivery-uncertain",
      attempts: 2,
      createdAt: held.createdAt,
    });

    const response = await buildFilesResponse(new Request("http://127.0.0.1/api/files"), {
      listFilesWithProjectCatalog: async () => ({
        files: [scannedFile(transcriptPath)],
        projectCatalog: [],
        complete: true,
      }),
    });
    expect(response.status).toBe(200);
    const file = (await response.json() as { files: FileEntry[] }).files[0]!;
    expect(file.stuckDelivery).toEqual({
      since: held.createdAt,
      attempts: 2,
      state: "delivery-uncertain",
    });
    expect(attentionId(file, admittedSeconds + 10 * 60)).toBe(`${transcriptPath}:delivery:${Math.floor(admittedSeconds)}`);
    expect(attentionExpiries([file])).toContain(admittedSeconds + 5 * 60);
    expect(decisionLine(
      (key, params) => translate("en", key, params),
      "en",
      file,
      admittedSeconds + 10 * 60,
    )).toBe("message delivery");
  } finally {
    setAgentRegistryForTests(null);
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
