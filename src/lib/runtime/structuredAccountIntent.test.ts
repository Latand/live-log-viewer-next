import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";

import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { RuntimeJournal } from "@/runtime-host/journal";

import type { HostState } from "./engineHost";
import { FakeEngineHost, createFakeDeliveryLedger } from "./fixtures/fakeEngineHost";
import { StructuredDeliveryQueue, type StructuredDeliveryQueuePort, type StructuredReconfigureEffect } from "./structuredDeliveryQueue";

/*
 * An account pick is an intent, and the conversation moves when it is next
 * engaged, over a real runtime journal in a private SQLite file and a fake
 * engine host. The reconfigure handler stands in for the ownership rebind: it
 * records that it ran, and it is the only thing that could move the
 * conversation. No runtime host socket, registry or account is touched.
 */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-account-intent-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));
afterEach(() => setSystemTime());

const CONVERSATION = "conversation-account-intent";

function journalWithSwitch(name: string, turn: "running" | "idle"): RuntimeJournal {
  const journal = new RuntimeJournal(path.join(sandbox, `${name}.sqlite`), { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: CONVERSATION },
    kind: "session-status",
    payload: {
      conversationId: CONVERSATION,
      sessionKey: { engine: "claude", sessionId: "session-account-intent" },
      hostKind: "claude-broker",
      host: "hosted",
      turn,
      provenance: "structured",
      artifactPath: "/sessions/account-intent.jsonl",
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: turn === "running" ? "turn-running" : null,
    },
  });
  pick(journal, "pick-b", "account-b");
  return journal;
}

function pick(journal: RuntimeJournal, operationId: string, accountId: string): void {
  journal.executeOperation({
    kind: "reconfigure",
    operationId,
    idempotencyKey: operationId,
    conversationId: CONVERSATION,
    model: "claude-opus-5",
    effort: "high",
    fast: false,
    accountId,
  });
}

function send(journal: RuntimeJournal, operationId: string): void {
  journal.executeOperation({
    kind: "send",
    operationId,
    idempotencyKey: operationId,
    conversationId: CONVERSATION,
    text: `the operator's next message (${operationId})`,
    policy: "queue",
  });
}

function hostState(active: boolean): HostState {
  return {
    status: active ? "active" : "idle",
    sessionKey: "session-account-intent",
    endpoint: "fake:structured-host",
    pid: 1,
    processStartIdentity: "fake:1",
    eventCursor: 0,
    protocolVersion: "fake-v1",
    activeTurnRef: active ? "turn-running" : null,
    pendingAttention: [],
    activeFlags: [],
    account: null,
  };
}

function endTurn(state: HostState): void {
  state.status = "idle";
  state.activeTurnRef = null;
}

/**
 * The queue over the journal. `holds` is the durable failed-switch hold the
 * registry keeps in production; the handler clears it when a new switch is
 * claimed, as the registry's claim does, and `fail` makes the move fail the
 * way a signed-out target or a refused migration does.
 */
function queueOver(
  journal: RuntimeJournal,
  state: HostState,
  options: { fail?: string; cancelled?: Set<string>; registry?: { store: AgentRegistry; id: ViewerConversationId } } = {},
) {
  const holds = new Map<string, { accountId: string; reason: string }>();
  /* With a registry, the hold and the claim are the registry's own, as in production. */
  const registry = options.registry;
  const port: StructuredDeliveryQueuePort = {
    effects: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transition: async (operationId, status, details) => {
      journal.transitionOperation(operationId, status, details);
    },
    status: async (operationId) => journal.operationResult(operationId)?.receipt ?? null,
    reconfigureCancelled: (effect) => options.cancelled?.has(effect.operationId) ?? false,
    switchHold: (conversationId) => registry ? registry.store.switchHold(registry.id) : holds.get(conversationId) ?? null,
    holdForFailedSwitch: (effect, reason) => {
      if (registry) registry.store.holdForFailedSwitch(registry.id, { operationId: effect.operationId, accountId: effect.accountId!, reason });
      else holds.set(effect.conversationId, { accountId: effect.accountId!, reason });
    },
  };
  const ledger = createFakeDeliveryLedger();
  const host = new FakeEngineHost(ledger, state);
  const moves: string[] = [];
  const order: string[] = [];
  const queue = new StructuredDeliveryQueue(
    port,
    () => host,
    undefined,
    undefined,
    undefined,
    async (effect: StructuredReconfigureEffect) => {
      if (registry) {
        const claim = registry.store.claimConversationReconfigure(registry.id, {
          operationId: effect.operationId,
          revision: effect.eventSeq,
          profile: { model: effect.model, effort: effect.effort, fast: effect.fast },
          ...(effect.accountId ? { accountId: effect.accountId } : {}),
        });
        if (claim.kind !== "claimed") throw new Error(`reconfigure claim was ${claim.kind}`);
      } else {
        holds.delete(effect.conversationId);
      }
      moves.push(`${effect.operationId}→${effect.accountId ?? "profile"}`);
      order.push(`move:${effect.accountId}`);
      if (options.fail) throw new Error(options.fail);
      return "applied";
    },
  );
  const writes = () => {
    for (const write of ledger.writes) if (!order.includes(`send:${write.id}`)) order.push(`send:${write.id}`);
    return ledger.writes.map((write) => write.id);
  };
  return { queue, moves, order, writes, holds };
}

test("a pick while the agent is mid-turn sends no migration, and the running turn finishes on the old account", async () => {
  const journal = journalWithSwitch("mid-turn", "running");
  const state = hostState(true);
  const { queue, moves } = queueOver(journal, state);

  /* The pick is on the session at once, for every page that reads it. */
  expect(journal.snapshot().sessions[0]?.pendingReconfigure?.accountId).toBe("account-b");
  await queue.drain();
  expect(moves).toEqual([]);

  /* The turn ends and nobody engages the conversation: nothing moves. */
  endTurn(state);
  await queue.drain();
  await queue.drain();
  expect(moves).toEqual([]);
  expect(journal.operationResult("pick-b")?.receipt.status).toBe("queued");
  expect(journal.snapshot().sessions[0]?.pendingReconfigure?.accountId).toBe("account-b");
  journal.close();
});

test("an idle conversation's pick waits for the next engagement, however long that is", async () => {
  const journal = journalWithSwitch("idle-long-wait", "idle");
  const { queue, moves } = queueOver(journal, hostState(false));
  await queue.drain();
  expect(moves).toEqual([]);

  /* Well past the two-minute window a control gets to settle in: an intent is
     not a control that got stuck, and it is still the conversation's choice. */
  setSystemTime(new Date(Date.now() + 60 * 60_000));
  await queue.drain();
  expect(moves).toEqual([]);
  expect(journal.operationResult("pick-b")?.receipt.status).toBe("queued");
  journal.close();
});

test("the next message moves the conversation first and then runs on the picked account, once", async () => {
  const journal = journalWithSwitch("next-message", "running");
  const state = hostState(true);
  const { queue, moves, order, writes } = queueOver(journal, state);
  await queue.drain();
  endTurn(state);
  await queue.drain();
  expect(moves).toEqual([]);

  send(journal, "next-message");
  await queue.drain();
  writes();
  expect(moves).toEqual(["pick-b→account-b"]);
  expect(order).toEqual(["move:account-b", "send:next-message"]);
  expect(journal.operationResult("pick-b")?.receipt.status).toBe("applied");
  expect(journal.snapshot().sessions[0]?.pendingReconfigure ?? null).toBeNull();

  await queue.drain();
  expect(writes()).toEqual(["next-message"]);
  expect(moves).toEqual(["pick-b→account-b"]);
  journal.close();
});

test("a message sent while the turn still runs waits for it, then moves and runs on the picked account", async () => {
  const journal = journalWithSwitch("engaged-mid-turn", "running");
  const state = hostState(true);
  const { queue, moves, writes } = queueOver(journal, state);
  send(journal, "sent-mid-turn");
  await queue.drain();
  /* The running turn is never interrupted for the switch. */
  expect(moves).toEqual([]);
  expect(writes()).toEqual([]);

  endTurn(state);
  await queue.drain();
  expect(moves).toEqual(["pick-b→account-b"]);
  expect(writes()).toEqual(["sent-mid-turn"]);
  journal.close();
});

test("the latest pick is the intent: B then C moves to C only", async () => {
  const journal = journalWithSwitch("b-then-c", "idle");
  const { queue, moves } = queueOver(journal, hostState(false));
  await queue.drain();
  pick(journal, "pick-c", "account-c");
  await queue.drain();
  expect(moves).toEqual([]);
  send(journal, "after-c");
  await queue.drain();
  expect(moves).toEqual(["pick-c→account-c"]);
  expect(journal.operationResult("pick-b")?.receipt).toMatchObject({ status: "failed", reason: "superseded" });
  journal.close();
});

test("a withdrawn pick never moves anything, and the message behind it runs where the conversation already is", async () => {
  const journal = journalWithSwitch("withdrawn", "idle");
  const cancelled = new Set<string>();
  const { queue, moves, writes } = queueOver(journal, hostState(false), { cancelled });
  await queue.drain();
  cancelled.add("pick-b");
  await queue.drain();
  expect(journal.operationResult("pick-b")?.receipt).toMatchObject({ status: "failed", reason: "cancelled" });
  expect(journal.snapshot().sessions[0]?.pendingReconfigure ?? null).toBeNull();

  send(journal, "on-a");
  await queue.drain();
  expect(moves).toEqual([]);
  expect(writes()).toEqual(["on-a"]);
  journal.close();
});

test("a failed move holds the message with its reason, sends nothing, and releases it exactly once", async () => {
  const journal = journalWithSwitch("failed-move", "idle");
  const { queue, moves, writes, holds } = queueOver(journal, hostState(false), { fail: "claude account requires authentication" });
  send(journal, "held-message");
  await queue.drain();
  await queue.drain();

  expect(moves).toEqual(["pick-b→account-b"]);
  expect(writes()).toEqual([]);
  expect(journal.operationResult("held-message")?.receipt).toMatchObject({ status: "queued" });
  expect(holds.get(CONVERSATION)).toEqual({ accountId: "account-b", reason: "claude account requires authentication" });

  /* A second message is held beside it, not sent past it. */
  send(journal, "second-message");
  await queue.drain();
  expect(writes()).toEqual([]);

  /* «Send on the current account»: the hold is released, and each message
     goes exactly once. */
  holds.delete(CONVERSATION);
  await queue.drain();
  await queue.drain();
  expect(writes()).toEqual(["held-message", "second-message"]);
  expect(moves).toEqual(["pick-b→account-b"]);
  journal.close();
});

test("after a failed move, picking another account moves there and delivers the held message once", async () => {
  const journal = journalWithSwitch("failed-then-other", "idle");
  const failing = queueOver(journal, hostState(false), { fail: "the migration was refused" });
  send(journal, "held-message");
  await failing.queue.drain();
  expect(failing.writes()).toEqual([]);

  const retry = queueOver(journal, hostState(false));
  retry.holds.set(CONVERSATION, failing.holds.get(CONVERSATION)!);
  pick(journal, "pick-c", "account-c");
  await retry.queue.drain();
  await retry.queue.drain();
  expect(retry.moves).toEqual(["pick-c→account-c"]);
  expect(retry.writes()).toEqual(["held-message"]);
  journal.close();
});

test("a settings change after a failed move leaves the held message held, never sent on the old account", async () => {
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(sandbox, "held-settings-state");
  const store = new AgentRegistry(path.join(sandbox, "held-settings-registry.json"), () => false);
  const id = store.ensureConversation("claude", "/sessions/account-intent.jsonl", "account-a").id;
  try {
    const journal = journalWithSwitch("failed-then-settings", "idle");
    const failing = queueOver(journal, hostState(false), { fail: "claude account requires authentication", registry: { store, id } });
    send(journal, "held-message");
    await failing.queue.drain();
    expect(failing.writes()).toEqual([]);
    expect(store.switchHold(id)).toMatchObject({ accountId: "account-b" });

    /* A model-only change names no account: it is applied, and the hold stands. */
    const later = queueOver(journal, hostState(false), { registry: { store, id } });
    journal.executeOperation({
      kind: "reconfigure", operationId: "model-only", idempotencyKey: "model-only", conversationId: CONVERSATION,
      model: "claude-sonnet-5", effort: "high", fast: false,
    });
    await later.queue.drain();
    await later.queue.drain();
    expect(later.moves).toEqual(["model-only→profile"]);
    expect(later.writes()).toEqual([]);
    expect(journal.operationResult("held-message")?.receipt).toMatchObject({ status: "queued" });
    expect(store.switchHold(id)).toMatchObject({ accountId: "account-b" });

    /* «Send on the current account» is still the explicit release. */
    store.releaseSwitchHold(id);
    await later.queue.drain();
    expect(later.writes()).toEqual(["held-message"]);
    journal.close();
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
  }
});
