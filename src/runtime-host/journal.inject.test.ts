import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { runtimeScope } from "@/lib/runtime/contracts";
import { structuredContent } from "@/lib/runtime/structuredContent";

import { RuntimeJournal } from "./journal";

function sandbox(name: string): string {
  return fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), `llv-inject-${name}-`));
}

function journalWithSession(name: string, session: {
  turn: "idle" | "running";
  inject: boolean;
  host?: "hosted" | "dead";
  activeTurnId?: string | null;
}): RuntimeJournal {
  const journal = new RuntimeJournal(path.join(sandbox(name), "events.sqlite"), {
    maxEvents: 100,
    now: () => 100,
    structuredHosts: true,
  });
  journal.append({
    scope: runtimeScope("session", "conv-one"),
    kind: "session.status",
    payload: {
      conversationId: "conv-one",
      sessionKey: { engine: "codex", sessionId: "thread-one" },
      hostKind: "codex-app-server",
      host: session.host ?? "hosted",
      turn: session.turn,
      provenance: "structured",
      accountId: "account-one",
      writerClaim: "owner:1",
      parentConversationId: null,
      flowId: null,
      workflowId: null,
      cwd: "/repo",
      artifactPath: "/sessions/one.jsonl",
      capabilities: { steer: true, structuredAttention: true, inject: session.inject },
      activeTurnId: session.activeTurnId ?? (session.turn === "running" ? "turn-live" : null),
    },
  });
  return journal;
}

function injectCommand(overrides: Record<string, unknown> = {}) {
  const text = typeof overrides.text === "string" ? overrides.text : "context for later";
  return {
    kind: "inject" as const,
    conversationId: "conv-one",
    idempotencyKey: "key-one",
    text,
    contentDigest: structuredContent(text, []).contentDigest,
    ...overrides,
  };
}

test("an injection is admitted against a RUNNING turn, which is what a send is not", () => {
  const journal = journalWithSession("running", { turn: "running", inject: true });
  const admitted = journal.executeOperation(injectCommand() as never);
  /* A send against a busy host queues behind the turn; an injection has no
     reason to wait, because it never contends for the turn. */
  expect(admitted.receipt.status).toBe("queued");
  expect(admitted.receipt.kind).toBe("inject");
  expect(admitted.receipt.turnId).toBe("turn-live");
  journal.close();
});

test("an injection is admitted against an idle thread", () => {
  const journal = journalWithSession("idle", { turn: "idle", inject: true });
  const admitted = journal.executeOperation(injectCommand() as never);
  expect(admitted.receipt.status).toBe("queued");
  expect(admitted.receipt.turnId).toBeNull();
  journal.close();
});

test("a host that has not advertised the capability is refused at admission", () => {
  const journal = journalWithSession("uncapable", { turn: "idle", inject: false });
  const admitted = journal.executeOperation(injectCommand() as never);
  /* Refused NOW rather than admitted and failed later: an operation that dies
     downstream reads to the operator as a lost message. */
  expect(admitted.receipt.status).toBe("rejected");
  expect(admitted.receipt.reason).toBe("unsupported-injection");
  journal.close();
});

test("a dead host is refused at admission", () => {
  const journal = journalWithSession("dead", { turn: "idle", inject: true, host: "dead" });
  const admitted = journal.executeOperation(injectCommand() as never);
  expect(admitted.receipt.status).toBe("rejected");
  expect(admitted.receipt.reason).toBe("dead-host");
  journal.close();
});

test("an explicit idle fence is refused while a turn is running", () => {
  const journal = journalWithSession("fenced", { turn: "running", inject: true });
  const admitted = journal.executeOperation(injectCommand({ turnId: null }) as never);
  expect(admitted.receipt.status).toBe("rejected");
  expect(admitted.receipt.reason).toBe("stale-turn");
  journal.close();
});

test("a named fence naming another turn is refused", () => {
  const journal = journalWithSession("stale", { turn: "running", inject: true });
  const admitted = journal.executeOperation(injectCommand({ turnId: "turn-gone" }) as never);
  expect(admitted.receipt.status).toBe("rejected");
  expect(admitted.receipt.reason).toBe("stale-turn");
  journal.close();
});

test("replaying the same key returns the original operation, never a second insertion", () => {
  const journal = journalWithSession("replay", { turn: "idle", inject: true });
  const first = journal.executeOperation(injectCommand() as never);
  const second = journal.executeOperation(injectCommand() as never);
  expect(second.operationId).toBe(first.operationId);
  expect(second.replayed).toBe(true);
  journal.close();
});

test("the same key with different text is refused rather than admitted", () => {
  const journal = journalWithSession("changed", { turn: "idle", inject: true });
  journal.executeOperation(injectCommand() as never);
  expect(() => journal.executeOperation(injectCommand({ text: "something else" }) as never)).toThrow();
  journal.close();
});

test("an injection never becomes a native-queue add", () => {
  const journal = journalWithSession("no-queue", { turn: "idle", inject: true });
  const admitted = journal.executeOperation(injectCommand() as never);
  /* The native queue is a different operation with different semantics; an
     injection routed into it would wait for idle instead of appending now. */
  expect(admitted.receipt.nativeQueue).toBeUndefined();
  journal.close();
});

test("an injection carrying images is refused by the journal too", () => {
  const journal = journalWithSession("images", { turn: "idle", inject: true });
  expect(() => journal.executeOperation(injectCommand({
    images: [{ sha256: "a".repeat(64), mime: "image/png", bytes: 10 }],
  }) as never)).toThrow(/images/i);
  journal.close();
});

test("an injection does not support retry, because the engine does not deduplicate", () => {
  const journal = journalWithSession("retry", { turn: "idle", inject: true });
  const admitted = journal.executeOperation(injectCommand() as never);
  /* An unknown outcome must never be redispatched under a fresh key: a second
     `thread/inject_items` writes a second record. */
  expect(() => journal.claimDeliveryAction(admitted.operationId, "retry")).toThrow(/does not support/i);
  journal.close();
});

test("an inject receipt carries the operator's words, so its outcome can be shown", () => {
  const journal = journalWithSession("text", { turn: "idle", inject: true });
  const admitted = journal.executeOperation(injectCommand({ text: "the context the operator added" }) as never);
  /* EVERY composer surface that renders a receipt requires text. A null here
     is the difference between a failed or unverified injection being visible
     and it disappearing silently — and `uncertain` is the outcome this whole
     operation exists to report honestly. */
  expect(admitted.receipt.text).toBe("the context the operator added");
  journal.close();
});

test("a long injection's receipt text is bounded like a send's", () => {
  const journal = journalWithSession("bounded", { turn: "idle", inject: true });
  const admitted = journal.executeOperation(injectCommand({ text: "x".repeat(500) }) as never);
  expect(admitted.receipt.text).toHaveLength(240);
  journal.close();
});

test("admission freezes the thread, account and writer generation on the durable effect", () => {
  const journal = journalWithSession("binding", { turn: "idle", inject: true });
  journal.append({ scope: runtimeScope("session", "conv-one"), kind: "session-status", payload: { writerClaim: "owner:7" } });
  const admitted = journal.executeOperation(injectCommand() as never);
  expect(admitted.receipt.status).toBe("queued");
  const effect = journal.effectBatch(100, ["runtime.inject"])[0]!;
  expect(effect.payload.binding).toEqual({ threadId: "thread-one", accountId: "account-one", writerClaim: "owner:7" });
  journal.append({ scope: runtimeScope("session", "conv-one"), kind: "session-status", payload: { writerClaim: "owner:8", accountId: "account-two" } });
  expect(journal.effectBatch(100, ["runtime.inject"])[0]!.payload.binding).toEqual(effect.payload.binding);
  journal.close();
});
