import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { runtimeScope } from "@/lib/runtime/contracts";

import { RuntimeHost } from "./host";
import { RUNTIME_UNPROJECTED_RECEIPT_RETENTION_LIMIT, RuntimeJournal } from "./journal";

/* Isolated files only: every case here writes a journal of its own under the
   process temp directory and never reads the operator's runtime state. */
function sandbox(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `llv-projection-${name}-`));
}

function journalWithHostedSession(name: string, conversationId = "conv-projection"): RuntimeJournal {
  const journal = new RuntimeJournal(path.join(sandbox(name), "events.sqlite"), { structuredHosts: true });
  journal.append({
    scope: runtimeScope("session", conversationId),
    kind: "session-status",
    payload: {
      conversationId,
      sessionKey: { engine: "codex", sessionId: "thread-projection" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  return journal;
}

/** Admits one send and ends it, the way the delivery queue does: `awaitProjection`
    is what the queue asks for on a terminal transition it must project. */
function deliveredSend(
  journal: RuntimeJournal,
  operationId: string,
  options: { awaitProjection?: boolean; conversationId?: string } = {},
): void {
  const conversationId = options.conversationId ?? "conv-projection";
  journal.executeOperation({
    kind: "send",
    operationId,
    idempotencyKey: operationId,
    conversationId,
    text: `message for ${operationId}`,
    policy: "queue",
  });
  journal.transitionOperation(
    operationId,
    "delivered",
    {},
    options.awaitProjection ? { awaitProjection: true } : {},
  );
}

/** Pushes the compaction anchor past everything written so far. */
function compactPastEverything(journal: RuntimeJournal, conversationId = "conv-projection", retentionLimit?: number): void {
  journal.append({
    scope: runtimeScope("session", conversationId),
    kind: "session-status",
    payload: { conversationId, host: "hosted", turn: "idle" },
  });
  if (retentionLimit === undefined) journal.compact(1);
  else journal.compact(1, retentionLimit);
}

test("a terminal receipt whose projection is owed survives compaction", () => {
  const journal = journalWithHostedSession("retained");
  deliveredSend(journal, "op-retained", { awaitProjection: true });

  compactPastEverything(journal);

  expect(journal.operationResult("op-retained")?.receipt.status).toBe("delivered");
  expect(journal.unprojectedTerminalOperationIds()).toEqual(["op-retained"]);
  journal.close();
});

test("a terminal transition that asks for nothing retains nothing", () => {
  const journal = journalWithHostedSession("unretained");
  deliveredSend(journal, "op-unretained");

  compactPastEverything(journal);

  expect(journal.operationResult("op-unretained")).toBeNull();
  expect(journal.unprojectedTerminalOperationIds()).toEqual([]);
  journal.close();
});

test("acknowledgement releases the receipt, and the next compaction takes it", () => {
  const journal = journalWithHostedSession("acknowledged");
  deliveredSend(journal, "op-acknowledged", { awaitProjection: true });

  expect(journal.acknowledgeTerminalProjection(["op-acknowledged"])).toBe(1);
  expect(journal.unprojectedTerminalOperationIds()).toEqual([]);
  compactPastEverything(journal);

  expect(journal.operationResult("op-acknowledged")).toBeNull();
  journal.close();
});

test("acknowledgement moves the receipt itself in no way", () => {
  const journal = journalWithHostedSession("untouched");
  deliveredSend(journal, "op-untouched", { awaitProjection: true });
  const before = journal.operationResult("op-untouched")!.receipt;

  journal.acknowledgeTerminalProjection(["op-untouched"]);

  expect(journal.operationResult("op-untouched")!.receipt).toEqual(before);
  journal.close();
});

test("acknowledgement is idempotent, and an id it has never seen is a no-op", () => {
  const journal = journalWithHostedSession("idempotent");
  deliveredSend(journal, "op-idempotent", { awaitProjection: true });

  expect(journal.acknowledgeTerminalProjection(["op-idempotent"])).toBe(1);
  expect(journal.acknowledgeTerminalProjection(["op-idempotent"])).toBe(0);
  expect(journal.acknowledgeTerminalProjection(["op-never-admitted"])).toBe(0);
  expect(journal.acknowledgeTerminalProjection([])).toBe(0);
  expect(() => journal.acknowledgeTerminalProjection([""])).toThrow("runtime projection acknowledgement id is invalid");
  expect(() => journal.acknowledgeTerminalProjection(
    Array.from({ length: RUNTIME_UNPROJECTED_RECEIPT_RETENTION_LIMIT + 1 }, (_, index) => `op-${index}`),
  )).toThrow("runtime projection acknowledgement batch is too large");
  journal.close();
});

test("retention pressure keeps the newest owed receipts and releases the oldest", () => {
  const journal = journalWithHostedSession("pressure");
  for (const operationId of ["op-oldest", "op-middle", "op-newest"]) {
    deliveredSend(journal, operationId, { awaitProjection: true });
  }

  compactPastEverything(journal, "conv-projection", 2);

  expect(journal.unprojectedTerminalOperationIds()).toEqual(["op-newest", "op-middle"]);
  expect(journal.operationResult("op-oldest")).toBeNull();
  expect(journal.operationResult("op-middle")?.receipt.status).toBe("delivered");
  expect(journal.operationResult("op-newest")?.receipt.status).toBe("delivered");
  journal.close();
});

test("an unacknowledged receipt is retained however far the anchor moves", () => {
  const journal = journalWithHostedSession("repeated");
  deliveredSend(journal, "op-repeated", { awaitProjection: true });

  for (let pass = 0; pass < 3; pass += 1) compactPastEverything(journal);

  expect(journal.operationResult("op-repeated")?.receipt.status).toBe("delivered");
  journal.close();
});

test("a journal written before this column migrates on open and keeps its receipts", () => {
  const filename = path.join(sandbox("migration"), "events.sqlite");
  const before = new RuntimeJournal(filename, { structuredHosts: true });
  before.close();
  /* The shape a runtime host released before this repair leaves behind. */
  const legacy = new Database(filename);
  legacy.exec("ALTER TABLE operations DROP COLUMN projection_pending");
  legacy.close();

  const journal = new RuntimeJournal(filename, { structuredHosts: true });
  journal.append({
    scope: runtimeScope("session", "conv-projection"),
    kind: "session-status",
    payload: {
      conversationId: "conv-projection",
      sessionKey: { engine: "codex", sessionId: "thread-projection" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  deliveredSend(journal, "op-migrated", { awaitProjection: true });
  compactPastEverything(journal);

  expect(journal.operationResult("op-migrated")?.receipt.status).toBe("delivered");
  expect(journal.unprojectedTerminalOperationIds()).toEqual(["op-migrated"]);
  journal.close();
});

/* The same obligation over the socket, where a Viewer and a runtime host of
   different releases actually meet. */

function hostFor(journal: RuntimeJournal): RuntimeHost {
  return new RuntimeHost(journal, undefined, undefined, true);
}

test("the transition RPC carries the retention obligation, and the acknowledgement RPC releases it", async () => {
  const journal = journalWithHostedSession("rpc");
  const host = hostFor(journal);
  journal.executeOperation({
    kind: "send",
    operationId: "op-rpc",
    idempotencyKey: "op-rpc",
    conversationId: "conv-projection",
    text: "message for op-rpc",
    policy: "queue",
  });

  const transitioned = await host.handle({
    id: "request-transition",
    method: "operation-transition",
    params: { operationId: "op-rpc", status: "delivered", awaitProjection: true },
  });
  expect(transitioned.ok).toBe(true);
  expect(journal.unprojectedTerminalOperationIds()).toEqual(["op-rpc"]);

  const acknowledged = await host.handle({
    id: "request-ack",
    method: "operation-projection-ack",
    params: { operationIds: ["op-rpc"] },
  });
  expect(acknowledged).toMatchObject({ ok: true, result: 1 });
  expect(journal.unprojectedTerminalOperationIds()).toEqual([]);
  journal.close();
});

test("the RPC refuses a malformed retention flag and malformed acknowledgement ids", async () => {
  const journal = journalWithHostedSession("rpc-invalid");
  const host = hostFor(journal);
  journal.executeOperation({
    kind: "send",
    operationId: "op-rpc-invalid",
    idempotencyKey: "op-rpc-invalid",
    conversationId: "conv-projection",
    text: "message for op-rpc-invalid",
    policy: "queue",
  });

  expect(await host.handle({
    id: "request-flag",
    method: "operation-transition",
    params: { operationId: "op-rpc-invalid", status: "delivered", awaitProjection: "yes" },
  })).toMatchObject({ ok: false, error: "runtime operation projection retention flag is invalid" });
  expect(journal.operationResult("op-rpc-invalid")?.receipt.status).toBe("queued");

  expect(await host.handle({
    id: "request-ids",
    method: "operation-projection-ack",
    params: { operationIds: "op-rpc-invalid" },
  })).toMatchObject({ ok: false, error: "runtime projection acknowledgement ids are invalid" });
  journal.close();
});

test("a runtime host with structured delivery disabled refuses the acknowledgement outright", async () => {
  const journal = journalWithHostedSession("rpc-disabled");
  const host = new RuntimeHost(journal, undefined, undefined, false);

  expect(await host.handle({
    id: "request-disabled",
    method: "operation-projection-ack",
    params: { operationIds: ["op-anything"] },
  })).toMatchObject({ ok: false, error: "structured hosts are disabled" });
  journal.close();
});
