import { expect, test } from "bun:test";

import type { ConversationMigration, MigrationIntent } from "./contracts";
import {
  MIGRATION_INTENT_PROGRESS_TIMEOUT_MS,
  migrationIntentCanEnroll,
  migrationIntentLastProgressAt,
} from "./intentLiveness";

const startedAt = "2026-07-29T10:00:00.000Z";

function intent(): MigrationIntent {
  return {
    id: "intent-fixture",
    engine: "codex",
    targetId: "target",
    origin: "manual",
    revision: 1,
    state: "draining",
    createdAt: startedAt,
    updatedAt: startedAt,
    requestIds: ["fixture"],
    evidence: null,
    stoppedAt: null,
  };
}

function migration(phase: ConversationMigration["phase"], updatedAt: string): ConversationMigration {
  return {
    intentId: "intent-fixture",
    phase,
    targetId: "target",
    revision: 1,
    error: null,
    errorCode: null,
    operationId: "operation-fixture",
    sourceGenerationId: "generation-fixture",
    providerReceipt: null,
    pendingContinuityPaths: [],
    boardProject: null,
    boardOperationId: null,
    boardPlacementProject: null,
    updatedAt,
  };
}

test("new requested enrolments cannot refresh an abandoned intent forever", () => {
  const value = intent();
  const enrolledAt = "2026-07-29T10:04:59.000Z";
  const context = {
    engineRouting: {
      claude: { activeAccountId: null },
      codex: { activeAccountId: "target" },
    },
    conversations: {
      newlyEnrolled: { migration: migration("requested", enrolledAt) },
    },
  };

  expect(migrationIntentLastProgressAt(context, value)).toBe(Date.parse(startedAt));
  expect(migrationIntentCanEnroll(
    context,
    value,
    Date.parse(startedAt) + MIGRATION_INTENT_PROGRESS_TIMEOUT_MS,
  )).toBe(false);
});

test("a real coordinator phase transition refreshes the progress bound", () => {
  const value = intent();
  const progressedAt = "2026-07-29T10:04:59.000Z";
  const context = {
    engineRouting: {
      claude: { activeAccountId: null },
      codex: { activeAccountId: "target" },
    },
    conversations: {
      progressing: { migration: migration("preparing", progressedAt) },
    },
  };

  expect(migrationIntentLastProgressAt(context, value)).toBe(Date.parse(progressedAt));
  expect(migrationIntentCanEnroll(
    context,
    value,
    Date.parse(progressedAt) + MIGRATION_INTENT_PROGRESS_TIMEOUT_MS - 1,
  )).toBe(true);
});

test("a future-dated progress marker fails closed", () => {
  const value = intent();
  value.updatedAt = "2026-07-29T11:00:00.000Z";
  const context = {
    engineRouting: {
      claude: { activeAccountId: null },
      codex: { activeAccountId: "target" },
    },
    conversations: {},
  };

  expect(migrationIntentCanEnroll(context, value, Date.parse(startedAt))).toBe(false);
});
