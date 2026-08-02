import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { runtimeScope } from "@/lib/runtime/contracts";

import { RuntimeJournal } from "./journal";

function sandbox(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `llv-compact-${name}-`));
}

function hostedCodexSession(journal: RuntimeJournal, options: {
  conversationId: string;
  sessionId?: string;
  turn?: "idle" | "running" | "interrupt_requested";
  activeTurnId?: string | null;
  hostKind?: string;
  host?: string;
  engine?: "codex" | "claude";
}): void {
  journal.append({
    scope: runtimeScope("session", options.conversationId),
    kind: "session-status",
    payload: {
      conversationId: options.conversationId,
      sessionKey: { engine: options.engine ?? "codex", sessionId: options.sessionId ?? "thread-one" },
      hostKind: options.hostKind ?? "codex-app-server",
      host: options.host ?? "hosted",
      turn: options.turn ?? "idle",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: options.activeTurnId ?? null,
    },
  });
}

test("an idle owned codex conversation admits one durable compact operation with a control effect", () => {
  const journal = new RuntimeJournal(path.join(sandbox("admit"), "events.sqlite"), { structuredHosts: true, now: () => 100 });
  hostedCodexSession(journal, { conversationId: "conv-compact" });

  const result = journal.executeOperation({
    kind: "compact",
    operationId: "op-compact",
    idempotencyKey: "op-compact",
    conversationId: "conv-compact",
    sessionKey: { engine: "codex", sessionId: "thread-one" },
  });

  expect(result.receipt).toMatchObject({ kind: "compact", status: "pending", turnId: null });
  const effects = journal.effectBatch();
  expect(effects).toHaveLength(1);
  expect(effects[0]!.kind).toBe("runtime.compact");
  expect(effects[0]!.payload).toMatchObject({
    kind: "compact",
    operationId: "op-compact",
    conversationId: "conv-compact",
    sessionKey: { engine: "codex", sessionId: "thread-one" },
  });
  /* Nothing on the effect can be replayed as user input. */
  expect(effects[0]!.payload).not.toHaveProperty("text");
  journal.close();
});

test("a caller retry replays the admitted compact receipt instead of admitting a second compaction", () => {
  const journal = new RuntimeJournal(path.join(sandbox("idempotent"), "events.sqlite"), { structuredHosts: true, now: () => 100 });
  hostedCodexSession(journal, { conversationId: "conv-compact" });
  const command = {
    kind: "compact" as const,
    operationId: "op-compact",
    idempotencyKey: "op-compact",
    conversationId: "conv-compact",
    sessionKey: { engine: "codex" as const, sessionId: "thread-one" },
  };

  const first = journal.executeOperation(command);
  const retry = journal.executeOperation(command);

  expect(retry.replayed).toBe(true);
  expect(retry.operationId).toBe(first.operationId);
  expect(journal.effectBatch().filter((effect) => effect.kind === "runtime.compact")).toHaveLength(1);
  journal.close();
});

test("a busy turn rejects compact admission instead of racing the running turn", () => {
  const journal = new RuntimeJournal(path.join(sandbox("busy"), "events.sqlite"), { structuredHosts: true, now: () => 100 });
  hostedCodexSession(journal, { conversationId: "conv-busy", turn: "running", activeTurnId: "turn-live" });

  const result = journal.executeOperation({
    kind: "compact",
    operationId: "op-busy",
    idempotencyKey: "op-busy",
    conversationId: "conv-busy",
    sessionKey: { engine: "codex", sessionId: "thread-one" },
  });

  expect(result.receipt).toMatchObject({ status: "rejected", reason: "busy-turn" });
  expect(journal.effectBatch()).toHaveLength(0);
  journal.close();
});

test("a caller-supplied turn fence cannot smuggle a compaction past the busy-turn rule", () => {
  const journal = new RuntimeJournal(path.join(sandbox("no-fence"), "events.sqlite"), { structuredHosts: true, now: () => 100 });
  hostedCodexSession(journal, { conversationId: "conv-busy", turn: "running", activeTurnId: "turn-live" });

  const result = journal.executeOperation({
    kind: "compact",
    operationId: "op-fenced",
    idempotencyKey: "op-fenced",
    conversationId: "conv-busy",
    sessionKey: { engine: "codex", sessionId: "thread-one" },
    /* The compact contract has no turn fence; a caller that names the live turn
       anyway must still land on the busy-turn rejection. */
    turnId: "turn-live",
  } as never);

  expect(result.receipt).toMatchObject({ status: "rejected", reason: "busy-turn" });
  expect(journal.effectBatch()).toHaveLength(0);
  journal.close();
});

test("compact admission refuses a lost host, a stale generation, and an unsupported engine", () => {
  const journal = new RuntimeJournal(path.join(sandbox("refusals"), "events.sqlite"), { structuredHosts: true, now: () => 100 });
  hostedCodexSession(journal, { conversationId: "conv-dead", host: "dead" });
  hostedCodexSession(journal, { conversationId: "conv-stale", sessionId: "thread-current" });
  hostedCodexSession(journal, {
    conversationId: "conv-claude",
    engine: "claude",
    hostKind: "claude-broker",
    sessionId: "session-claude",
  });

  const dead = journal.executeOperation({
    kind: "compact",
    operationId: "op-dead",
    idempotencyKey: "op-dead",
    conversationId: "conv-dead",
    sessionKey: { engine: "codex", sessionId: "thread-one" },
  });
  const stale = journal.executeOperation({
    kind: "compact",
    operationId: "op-stale",
    idempotencyKey: "op-stale",
    conversationId: "conv-stale",
    sessionKey: { engine: "codex", sessionId: "thread-previous" },
  });
  const claude = journal.executeOperation({
    kind: "compact",
    operationId: "op-claude",
    idempotencyKey: "op-claude",
    conversationId: "conv-claude",
    sessionKey: { engine: "claude", sessionId: "session-claude" },
  });

  expect(dead.receipt).toMatchObject({ status: "rejected", reason: "dead-host" });
  expect(stale.receipt).toMatchObject({ status: "rejected", reason: "stale-generation" });
  expect(claude.receipt).toMatchObject({ status: "rejected", reason: "unsupported-capability" });
  expect(journal.effectBatch()).toHaveLength(0);
  journal.close();
});

test("a completed compaction is never reissued after a runtime-host restart", () => {
  const file = path.join(sandbox("restart-done"), "events.sqlite");
  const journal = new RuntimeJournal(file, { structuredHosts: true, now: () => 100 });
  hostedCodexSession(journal, { conversationId: "conv-compact" });
  journal.executeOperation({
    kind: "compact",
    operationId: "op-compact",
    idempotencyKey: "op-compact",
    conversationId: "conv-compact",
    sessionKey: { engine: "codex", sessionId: "thread-one" },
  });
  journal.transitionOperation("op-compact", "delivering");
  journal.transitionOperation("op-compact", "delivered", { reason: "compaction:compaction-one" });
  journal.close();

  const restarted = new RuntimeJournal(file, { structuredHosts: true, now: () => 200 });
  restarted.claimHostEpoch();

  expect(restarted.effectBatch()).toHaveLength(0);
  expect(restarted.operationResult("op-compact")!.receipt).toMatchObject({
    status: "delivered",
    reason: "compaction:compaction-one",
  });
  restarted.close();
});

test("a restart terminalizes an in-flight compaction as uncertain rather than replaying the control", () => {
  const file = path.join(sandbox("restart-inflight"), "events.sqlite");
  const journal = new RuntimeJournal(file, { structuredHosts: true, now: () => 100 });
  hostedCodexSession(journal, { conversationId: "conv-compact" });
  journal.executeOperation({
    kind: "compact",
    operationId: "op-compact",
    idempotencyKey: "op-compact",
    conversationId: "conv-compact",
    sessionKey: { engine: "codex", sessionId: "thread-one" },
  });
  /* The executor marks `delivering` before it writes thread/compact/start, so
     this is exactly the window where the engine outcome is unknown. */
  journal.transitionOperation("op-compact", "delivering");
  journal.close();

  const restarted = new RuntimeJournal(file, { structuredHosts: true, now: () => 200 });
  restarted.claimHostEpoch();

  const receipt = restarted.operationResult("op-compact")!.receipt;
  expect(receipt.status).toBe("uncertain");
  expect(receipt.reason).toContain("restart");
  expect(restarted.effectBatch()).toHaveLength(0);
  restarted.close();
});

test("a restart replays a compaction the executor never issued", () => {
  const file = path.join(sandbox("restart-pending"), "events.sqlite");
  const journal = new RuntimeJournal(file, { structuredHosts: true, now: () => 100 });
  hostedCodexSession(journal, { conversationId: "conv-compact" });
  journal.executeOperation({
    kind: "compact",
    operationId: "op-compact",
    idempotencyKey: "op-compact",
    conversationId: "conv-compact",
    sessionKey: { engine: "codex", sessionId: "thread-one" },
  });
  journal.close();

  const restarted = new RuntimeJournal(file, { structuredHosts: true, now: () => 200 });
  restarted.claimHostEpoch();

  expect(restarted.operationResult("op-compact")!.receipt.status).toBe("pending");
  expect(restarted.effectBatch().map((effect) => effect.kind)).toEqual(["runtime.compact"]);
  restarted.close();
});
