import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { AgentRegistry } from "@/lib/agent/registry";
import { RuntimeJournal } from "@/runtime-host/journal";
import { encodeCodexStructuredUserText } from "./codexStructuredUserText";
import { structuredContent } from "./structuredContent";
import { handleRuntimeRetry } from "./http";
import { resolveOriginalSend, resolveSendReceipt, sendReceiptFor } from "./sendSettlement";
import { readCanonicalCodexDelivery } from "./codexAppServerHost";
import type { RuntimeHostClient } from "./client";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "canonical-original-"));
  const transcript = path.join(directory, "native-generation.jsonl");
  const registry = new AgentRegistry(path.join(directory, "registry.json"));
  const conversation = registry.ensureConversation("codex", transcript, null);
  const filename = path.join(directory, "runtime.sqlite");
  let journal = new RuntimeJournal(filename, { structuredHosts: true });
  const operationId = "original-operation";
  const clientKey = "original-client-key";
  const text = "[viewer context — selected reviewer]\nOriginal т instruction 🎯";
  const selectedContext = { version: 1 as const, state: "selected" as const,
    conversationId: ["conversation", "selected-card"].join("_"), capturedAt: "2026-09-08T09:21:00.000Z", label: "reviewer" };
  const dedup = createHash("sha256").update(operationId).digest("hex");
  const wire = encodeCodexStructuredUserText(text, undefined, selectedContext, { kind: "operator" }, dedup);
  const contentDigest = structuredContent(text, []).contentDigest;
  const metadata = { conversationId: conversation.id, sessionKey: { engine: "codex", sessionId: "native-generation" },
    hostKind: "codex-app-server", host: "hosted", turn: "idle", activeTurnId: null, provenance: "structured",
    artifactPath: transcript, capabilities: { steer: true, structuredAttention: true } };
  journal.append({ scope: { type: "session", id: conversation.id }, kind: "session-status", payload: metadata });
  const command = { kind: "send" as const, operationId, conversationId: conversation.id, idempotencyKey: clientKey,
    text, contentDigest, selectedContext, policy: "queue" as const };
  journal.executeOperation(command);
  journal.transitionOperation(operationId, "delivering", { turnId: null });
  const held = registry.holdDelivery(conversation.id, text, clientKey, "text", [], contentDigest, { operationId, kind: "send", policy: "queue" });
  registry.recordDeliveryOutcome(held.id, "failed", "payload echo unverified", "unverified");
  const echo = (turnId: string, content = wire, seq = 1) => journal.append({ scope: { type: "session", id: conversation.id }, kind: "item",
    producer: { kind: "codex-app-server", eventKey: `engine-host:codex:native-generation:${seq}` },
    payload: { conversationId: conversation.id, turnId, phase: "started", item: { type: "userMessage", clientId: operationId, content: [{ type: "text", text: content }] } } });
  echo("original-turn");
  journal.transitionOperation(operationId, "uncertain", { reason: "Codex queue entry id belongs to a different payload" });
  const write = (value: string) => fs.writeFileSync(transcript, JSON.stringify({ type: "response_item", payload: { type: "message", role: "user",
    content: [{ type: "input_text", text: value }] } }) + "\n");
  write(wire);
  let kicks = 0;
  const client = { operationStatus: async (id: string) => journal.operationResult(id), reconcileDelivery: (id: string, expected: import("./contracts").RuntimeCanonicalDeliveryBinding) => journal.reconcileCanonicalDelivery(id, undefined, expected),
    retryOperation: async () => { throw new Error("reconciliation must never retry"); },
    claimDeliveryAction: async () => { throw new Error("reconciliation must never claim a retry"); },
  } as unknown as RuntimeHostClient;
  const request = (body: unknown = { action: "reconcile-delivery" }) => handleRuntimeRetry(new NextRequest(`http://127.0.0.1/api/runtime/operations/${operationId}`, {
    method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify(body),
  }), operationId, { enabled: () => true, registry: () => registry, client: () => client, kick: () => { kicks++; } });
  return { directory, transcript, filename, registry, conversation, operationId, clientKey, command, contentDigest, selectedContext, wire, dedup, text,
    journal: () => journal, client, echo, write, request, kicks: () => kicks,
    restart: () => { journal.close(); journal = new RuntimeJournal(filename, { structuredHosts: true }); },
    close: () => { journal.close(); fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

test("the original-key reconcile API settles canonical delivery without retry and survives query/snapshot/restart", async () => {
  const f = fixture();
  try {
    expect(sendReceiptFor(f.registry.readOnlySnapshot(), f.operationId)).toMatchObject({ state: "failed", resend: "verify-first" });
    const result = await f.request();
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ operationId: f.operationId, receipt: { status: "delivered", idempotencyKey: f.clientKey, turnId: "original-turn" }, send: { state: "delivered" } });
    expect(f.kicks()).toBe(0);
    expect(f.journal().effectBatch()).toEqual([]);
    const revision = f.journal().operationResult(f.operationId)!.receipt.revision;
    expect(f.journal().snapshot().recentOperations.find((receipt) => receipt.operationId === f.operationId)?.status).toBe("delivered");
    f.restart();
    expect(f.journal().operationResult(f.operationId)!.receipt).toMatchObject({ status: "delivered", idempotencyKey: f.clientKey, revision });
    expect((await f.request()).status).toBe(200);
    expect(f.journal().operationResult(f.operationId)!.receipt.revision).toBe(revision);
    expect(await resolveOriginalSend({ conversationId: f.conversation.id, clientMessageId: f.clientKey, text: f.text }, { registry: f.registry, client: f.client }))
      .toMatchObject({ kind: "found", operationId: f.operationId, current: { readable: true, value: { state: "delivered", resend: "not-needed" } } });
    expect(f.journal().executeOperation(f.command).receipt.status).toBe("delivered");
  } finally { f.close(); }
});

test("a journal-first crash repairs the stale unverified registry projection through the original receipt query", async () => {
  const f = fixture();
  try {
    await f.journal().reconcileCanonicalDelivery(f.operationId);
    expect(sendReceiptFor(f.registry.readOnlySnapshot(), f.operationId)?.state).toBe("failed");
    f.restart();
    expect(await resolveSendReceipt(f.operationId, { registry: f.registry, client: f.client })).toMatchObject({ state: "delivered", resend: "not-needed" });
    expect(sendReceiptFor(f.registry.readOnlySnapshot(), f.operationId)?.state).toBe("delivered");
    expect(f.kicks()).toBe(0);
  } finally { f.close(); }
});

for (const invalid of ["wrong-key", "changed-payload", "changed-context", "unreadable", "ambiguous"] as const) test(`canonical reconciliation refuses ${invalid} evidence without effects`, async () => {
  const f = fixture();
  try {
    if (invalid === "wrong-key") f.write(encodeCodexStructuredUserText(f.text, undefined, f.selectedContext, { kind: "operator" }, "f".repeat(64)));
    if (invalid === "changed-payload") f.write(encodeCodexStructuredUserText("different text", undefined, f.selectedContext, { kind: "operator" }, f.dedup));
    if (invalid === "changed-context") f.write(encodeCodexStructuredUserText(f.text, undefined, { ...f.selectedContext, label: "changed context" }, { kind: "operator" }, f.dedup));
    if (invalid === "unreadable") fs.unlinkSync(f.transcript);
    if (invalid === "ambiguous") f.echo("another-turn", f.wire, 2);
    const response = await f.request();
    expect(response.status).not.toBe(200);
    expect(f.journal().operationResult(f.operationId)?.receipt.status).toBe("uncertain");
    expect(sendReceiptFor(f.registry.readOnlySnapshot(), f.operationId)).toMatchObject({ state: "failed", resend: "verify-first" });
    expect(f.journal().effectBatch()).toEqual([]);
    expect(f.kicks()).toBe(0);
  } finally { f.close(); }
});

test("a discard/retry action winning during proof verification prevents canonical settlement", async () => {
  const f = fixture();
  try {
    await expect(f.journal().reconcileCanonicalDelivery(f.operationId, async (pathname, entry) => {
      const proof = await readCanonicalCodexDelivery(pathname, entry);
      f.journal().claimDeliveryAction(f.operationId, "discard");
      return proof;
    })).rejects.toThrow("moved");
    expect(f.journal().operationResult(f.operationId)?.receipt.status).toBe("uncertain");
    expect(f.journal().effectBatch()).toEqual([]);
  } finally { f.close(); }
});

test("reconciliation cannot accept a replacement key or caller-supplied delivery claim", async () => {
  const f = fixture();
  try {
    expect((await f.request({ action: "reconcile-delivery", idempotencyKey: "replacement" })).status).toBe(400);
    expect((await f.request({ action: "reconcile-delivery", status: "delivered" })).status).toBe(400);
    expect(f.journal().operationResult(f.operationId)?.receipt.status).toBe("uncertain");
  } finally { f.close(); }
});


test("runtime-host RPC reconciliation uses the original generation after a later session rotation", async () => {
  const { RuntimeHost } = await import("@/runtime-host/host");
  const f = fixture();
  try {
    f.journal().append({ scope: { type: "session", id: f.conversation.id }, kind: "session-status", payload: {
      conversationId: f.conversation.id, sessionKey: { engine: "codex", sessionId: "successor-generation" },
      artifactPath: path.join(f.directory, "successor.jsonl"), hostKind: "codex-app-server", host: "hosted", turn: "idle", activeTurnId: null,
    } });
    const host = new RuntimeHost(f.journal(), undefined, undefined, true);
    expect(await host.handle({ id: "original-proof-request", method: "operation-reconcile-delivery", params: { operationId: f.operationId,
      expected: { conversationId: f.conversation.id, idempotencyKey: f.clientKey, contentDigest: f.contentDigest } } }))
      .toMatchObject({ ok: true, result: { operationId: f.operationId, receipt: { status: "delivered", canonicalDelivery: { generation: "native-generation" } } } });
    expect(f.journal().effectBatch()).toEqual([]);
  } finally { f.close(); }
});


test("a contradictory registry expectation cannot mutate the original journal receipt", async () => {
  const f = fixture();
  try {
    await expect(f.journal().reconcileCanonicalDelivery(f.operationId, undefined,
      { conversationId: f.conversation.id, idempotencyKey: "wrong-client-key", contentDigest: f.contentDigest })).rejects.toThrow("binding");
    await expect(f.journal().reconcileCanonicalDelivery(f.operationId, undefined,
      { conversationId: f.conversation.id, idempotencyKey: f.clientKey, contentDigest: "f".repeat(64) })).rejects.toThrow("binding");
    expect(f.journal().operationResult(f.operationId)?.receipt.status).toBe("uncertain");
    expect(f.journal().effectBatch()).toEqual([]);
  } finally { f.close(); }
});


test("verified delivered truth is not downgraded by a stale uncertain journal answer", async () => {
  const f = fixture();
  try {
    const stale = f.journal().operationResult(f.operationId)!;
    expect((await f.request()).status).toBe(200);
    let reads = 0;
    const client = { ...f.client, operationStatus: async () => { reads++; return stale; } };
    expect(await resolveSendReceipt(f.operationId, { registry: f.registry, client })).toMatchObject({ state: "delivered", resend: "not-needed" });
    expect(await resolveOriginalSend({ conversationId: f.conversation.id, clientMessageId: f.clientKey }, { registry: f.registry, client }))
      .toMatchObject({ current: { readable: true, value: { state: "delivered" } } });
    expect(reads).toBe(0);
  } finally { f.close(); }
});
