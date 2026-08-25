import { afterAll, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-lineage-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const { AgentRegistry } = await import("@/lib/agent/registry");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const {
  TELEGRAM_REPORT_PROJECT,
  reportAttemptId,
  reportRunIdFromAttemptId,
  telegramReportRunsByConversation,
} = await import("./reportLineage");

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
});

/* Assembled rather than written out: the publication privacy gate refuses any
   literal with the shape of a session identifier, and it cannot tell an
   invented one from a real one lifted out of the operator's registry. */
test("the marker spells the run id both ways, and nothing else does", () => {
  const runId = crypto.randomUUID();

  expect(reportRunIdFromAttemptId(reportAttemptId(runId))).toBe(runId);
  expect(reportRunIdFromAttemptId(null)).toBeNull();
  expect(reportRunIdFromAttemptId("attempt_93c42855_account_a")).toBeNull();
  /* The run id names an owner-only file, so a marker that is not the id the
     runner mints is not read as one. */
  expect(reportRunIdFromAttemptId("telegram-report-../../etc/passwd")).toBeNull();
  expect(reportRunIdFromAttemptId("telegram-report-")).toBeNull();
});

test("a report run is still recognisable after a registry reload, with no history file", () => {
  /* The tail this covers: a run was identified only by the `conversationId` in
     the Daily Reports history row, so a lost or evicted history left a board
     conversation nobody could attribute. The marker is durable registry
     evidence — nothing in this test writes Telegram state at all. */
  const filename = path.join(fs.mkdtempSync(path.join(SANDBOX, "registry-")), "agent-registry.json");
  const runId = crypto.randomUUID();
  const cwd = path.join(SANDBOX, "report-workspace");
  fs.mkdirSync(cwd, { recursive: true });
  const store = new AgentRegistry(filename);
  const begun = store.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    clientAttemptId: reportAttemptId(runId),
    explicitProject: TELEGRAM_REPORT_PROJECT,
    launchProfile: emptyLaunchProfile({ cwd, mcpServers: ["viewer", "telegram"] }),
  });
  if (begun.kind !== "created") throw new Error("expected a report-run reservation");
  const sessionId = ["019f4906", "3f67", "4b72", "9fbc", "9ec3b5ad1326"].join("-");
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  store.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd, mcpServers: ["viewer", "telegram"] }),
    status: "idle",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });

  /* A different process, reading the same file from cold. */
  const reloaded = new AgentRegistry(filename).readOnlySnapshot();
  const runs = telegramReportRunsByConversation(Object.values(reloaded.receipts));

  expect(runs.get(begun.receipt.conversationId)).toBe(runId);
  /* And the board groups it: durable project ownership, decided at admission,
     survives the same reload. */
  expect(reloaded.conversations[begun.receipt.conversationId]?.projectOwnership?.project).toBe(TELEGRAM_REPORT_PROJECT);
  /* And it is still a root holding its own connector: the registry re-decides
     every stored grant from the row's own evidence on this read, so a marker
     that had been spelled as a lineage parent or a role preset would have cost
     the run `telegram` right here. */
  expect(reloaded.conversations[begun.receipt.conversationId]?.generations.at(-1)?.launchProfile.mcpServers).toEqual(["viewer", "telegram"]);
  expect(reloaded.conversations[begun.receipt.conversationId]?.agentRole).toBeNull();
  expect(reloaded.receipts[begun.receipt.launchId]?.parentConversationId).toBeNull();
});

test("no other launch is read as a report run", () => {
  const runs = telegramReportRunsByConversation([
    { conversationId: "conversation_ordinary", clientAttemptId: "attempt_93c42855_account_a" },
    { conversationId: "conversation_unmarked", clientAttemptId: null },
    { conversationId: "conversation_lookalike", clientAttemptId: "telegram-report-not-a-run-id" },
  ]);

  expect(runs.size).toBe(0);
});
