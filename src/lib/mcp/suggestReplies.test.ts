import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AttentionCallerAuthority } from "@/lib/attention/callerAuthority";
import { clearReplySuggestions, readReplySuggestions, readReplySuggestionsFile } from "@/lib/suggestions/store";
import { MAX_REPLY_SUGGESTIONS } from "@/lib/suggestions/types";

import { viewerMcpBindings } from "./bindings";
import { createMcpToolService, MemoryMcpReceiptStore, MCP_TOOL_NAMES, TOOL_INPUT_SCHEMAS, type McpToolResult } from "./server";

/*
 * #1202 at the tool boundary: who may offer the operator reply drafts, what a
 * set may contain, and what the durable record holds afterwards.
 *
 * Authority is `request_attention`'s, for the same reason: this writes into the
 * surface the operator is answering in. It is an OPERATION contract — the tool
 * stays on every session's surface and the binding refuses the executions the
 * durable identity does not entitle.
 */

let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-suggest-"));
  process.env.LLV_STATE_DIR = sandbox;
});
afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const SEAT = "conversation_seat";
const MANAGER: AttentionCallerAuthority = { kind: "worker", conversationId: SEAT, role: "orchestrator" };
const WORKER: AttentionCallerAuthority = { kind: "worker", conversationId: "conversation_worker", role: "implementer" };
const ROOT: AttentionCallerAuthority = { kind: "root", conversationId: "conversation_root" };

/* The registry's alias chain, stubbed to identity: these cases compare ids the
   registry has never rekeyed, and the production resolver would open the real
   registry to say so. */
const ALIASES = new Map<string, string>();

function serviceAs(authority: AttentionCallerAuthority, receipts: MemoryMcpReceiptStore = new MemoryMcpReceiptStore()) {
  return createMcpToolService(
    viewerMcpBindings(undefined, undefined, {
      attentionAuthority: () => authority,
      authorizedSeats: () => [{ conversationId: SEAT, path: "/seat.jsonl", project: "viewer" }],
      canonicalSeatConversationId: (conversationId: string) => ALIASES.get(conversationId) ?? conversationId,
    } as never),
    receipts,
  );
}

/**
 * A process that died between writing the record and settling its receipt: the
 * write happened, the receipt never did. The next call with the same
 * clientRequestId finds a claim nobody completed.
 */
class InterruptedReceiptStore extends MemoryMcpReceiptStore {
  interrupt = false;
  override complete(key: string, digest: string, result: McpToolResult): void {
    if (this.interrupt) return;
    super.complete(key, digest, result);
  }
}

const call = (overrides: Record<string, unknown> = {}) => ({
  clientRequestId: "suggest-1",
  replies: [
    { label: "yes, do it", text: "Yes — merge it." },
    { label: "hold", text: "Hold. Explain the rollback first." },
  ],
  ...overrides,
});

test("the tool is on the published surface with the shape the mandate promises", () => {
  expect(MCP_TOOL_NAMES).toContain("suggest_replies");
  const schema = TOOL_INPUT_SCHEMAS.suggest_replies;
  expect(schema.safeParse(call()).success).toBe(true);
  expect(schema.safeParse(call({ conversationId: "conversation_other", replaces: true })).success).toBe(true);
  /* Bounds live in the schema, so a malformed set is refused at the protocol
     door rather than reaching the record. */
  expect(schema.safeParse(call({ replies: [] })).success).toBe(false);
  expect(schema.safeParse(call({
    replies: Array.from({ length: MAX_REPLY_SUGGESTIONS + 1 }, (_, index) => ({ label: `l${index}`, text: `t${index}` })),
  })).success).toBe(false);
  expect(schema.safeParse(call({ replies: [{ label: "no text" }] })).success).toBe(false);
  expect(schema.safeParse({ replies: call().replies }).success).toBe(false);
});

test("the designated seat's set lands on the conversation it is speaking in", async () => {
  const result = await serviceAs(MANAGER).callTool("suggest_replies", call()) as McpToolResult & { conversationId?: string; setId?: string };

  expect(result.ok).toBe(true);
  expect(result.conversationId).toBe(SEAT);
  const stored = readReplySuggestions(SEAT);
  expect(stored?.setId).toBe(result.setId!);
  expect(stored?.replies).toEqual([
    { label: "yes, do it", text: "Yes — merge it." },
    { label: "hold", text: "Hold. Explain the rollback first." },
  ]);
  /* Attribution is the server's, from the same identity chain the attention
     record trusts — the caller never says who it is. */
  expect(stored?.origin).toEqual({ kind: "manager", conversationId: SEAT, role: "orchestrator" });
});

test("the newest set replaces the previous one and says which set it replaced", async () => {
  const service = serviceAs(MANAGER);
  const first = await service.callTool("suggest_replies", call()) as McpToolResult & { setId?: string };
  const second = await service.callTool("suggest_replies", call({
    clientRequestId: "suggest-2",
    replaces: true,
    replies: [{ label: "ship it", text: "Ship it." }],
  })) as McpToolResult & { replaced?: string | null };

  expect(second.ok).toBe(true);
  expect(second.replaced).toBe(first.setId!);
  expect(readReplySuggestions(SEAT)?.replies).toEqual([{ label: "ship it", text: "Ship it." }]);
  expect(readReplySuggestionsFile().sets).toHaveLength(1);
});

test("the operator's own session offers drafts under its own message, and nowhere else", async () => {
  const own = await serviceAs(ROOT).callTool("suggest_replies", call()) as McpToolResult;

  expect(own.ok).toBe(true);
  expect(readReplySuggestions("conversation_root")?.origin.kind).toBe("gateway");

  /* No cross-board exception, for anyone: a set written into a pane the caller
     is not speaking in answers a question that pane never asked — and would
     not even surface there on its own, because a conversation re-reads its
     drafts when ITS OWN transcript moves. */
  const elsewhere = await serviceAs(ROOT).callTool("suggest_replies", call({
    clientRequestId: "suggest-root-elsewhere",
    conversationId: "conversation_other",
  })) as McpToolResult & { details?: { code?: string; refusedAs?: string } };

  expect(elsewhere.ok).toBe(false);
  expect(elsewhere.details?.code).toBe("SUGGEST_REPLIES_NOT_PERMITTED");
  expect(elsewhere.details?.refusedAs).toBe("cross-conversation");
  expect(readReplySuggestions("conversation_other")).toBeNull();
});

test("a worker session is refused, and nothing durable is written", async () => {
  const result = await serviceAs(WORKER).callTool("suggest_replies", call()) as McpToolResult & { details?: { code?: string; refusedAs?: string } };

  expect(result.ok).toBe(false);
  expect(result.details?.code).toBe("SUGGEST_REPLIES_NOT_PERMITTED");
  expect(result.details?.refusedAs).toBe("worker");
  expect(readReplySuggestionsFile().sets).toHaveLength(0);
});

test("an unattributable caller is refused before it can name a conversation", async () => {
  const result = await serviceAs({ kind: "unidentified" }).callTool("suggest_replies", call({
    conversationId: "conversation_other",
  })) as McpToolResult & { details?: { code?: string; refusedAs?: string } };

  expect(result.ok).toBe(false);
  expect(result.details?.code).toBe("SUGGEST_REPLIES_NOT_PERMITTED");
  expect(result.details?.refusedAs).toBe("unidentified");
  expect(readReplySuggestionsFile().sets).toHaveLength(0);
});

test("a caller with no conversation of its own must name one", async () => {
  const result = await serviceAs({ kind: "root", conversationId: "" } as AttentionCallerAuthority)
    .callTool("suggest_replies", call()) as McpToolResult & { error?: string };

  expect(result.ok).toBe(false);
  expect(result.error).toContain("conversationId");
});

test("an oversized label is refused with the rule it broke, leaving the previous set standing", async () => {
  const service = serviceAs(MANAGER);
  await service.callTool("suggest_replies", call());
  const result = await service.callTool("suggest_replies", call({
    clientRequestId: "suggest-long",
    replies: [{ label: "x".repeat(200), text: "body" }],
  })) as McpToolResult & { details?: { code?: string } };

  expect(result.ok).toBe(false);
  expect(result.details?.code).toBe("LABEL_TOO_LONG");
  expect(readReplySuggestions(SEAT)?.replies).toHaveLength(2);
});

test("a replayed clientRequestId answers from the receipt instead of writing a second set", async () => {
  const service = serviceAs(MANAGER);
  const first = await service.callTool("suggest_replies", call()) as McpToolResult & { setId?: string; replayed?: boolean };
  const replay = await service.callTool("suggest_replies", call()) as McpToolResult & { setId?: string; replayed?: boolean };

  expect(replay.ok).toBe(true);
  expect(replay.setId).toBe(first.setId!);
  expect(replay.replayed).toBe(true);
  expect(readReplySuggestionsFile().sets).toHaveLength(1);
});

test("a designated seat may not offer drafts in a conversation it does not hold", async () => {
  const result = await serviceAs(MANAGER).callTool("suggest_replies", call({
    conversationId: "conversation_someone_else",
  })) as McpToolResult & { details?: { code?: string; refusedAs?: string } };

  expect(result.ok).toBe(false);
  expect(result.details?.code).toBe("SUGGEST_REPLIES_NOT_PERMITTED");
  expect(result.details?.refusedAs).toBe("cross-conversation");
  /* Nothing written anywhere: not under the target, and not under the seat's
     own conversation as a consolation prize. */
  expect(readReplySuggestionsFile().sets).toHaveLength(0);
});

test("a seat's own conversation under a pre-migration id is still its own", async () => {
  /* The registry rekeyed this seat; the caller still knows itself by the id it
     was launched under. Identity is the alias chain's answer, not string
     equality, or a migrated seat would be locked out of its own pane. */
  ALIASES.set("conversation_seat_before_migration", SEAT);
  try {
    const result = await serviceAs(MANAGER).callTool("suggest_replies", call({
      conversationId: "conversation_seat_before_migration",
    })) as McpToolResult;

    expect(result.ok).toBe(true);
    /* Filed under what the registry calls the seat now, which is where the
       pane looks — not under the id the caller happened to hold. */
    expect(readReplySuggestions(SEAT)?.replies).toHaveLength(2);
    expect(readReplySuggestions("conversation_seat_before_migration")).toBeNull();
    expect((result as { conversationId?: string }).conversationId).toBe(SEAT);
  } finally {
    ALIASES.clear();
  }
});

test("a seat may not reach across projects either — the target is the rule, not the project", async () => {
  /* Another project's manager conversation: a seat that could write here would
     put words under a question the operator is answering somebody else with. */
  const result = await serviceAs(MANAGER).callTool("suggest_replies", call({
    conversationId: "conversation_other_project_seat",
  })) as McpToolResult & { details?: { refusedAs?: string } };

  expect(result.ok).toBe(false);
  expect(result.details?.refusedAs).toBe("cross-conversation");
  expect(readReplySuggestions("conversation_other_project_seat")).toBeNull();
});

test("an interrupted call is never re-run: drafts the operator already answered stay retired", async () => {
  const receipts = new InterruptedReceiptStore();
  receipts.interrupt = true;
  const first = await serviceAs(MANAGER, receipts).callTool("suggest_replies", call()) as McpToolResult;
  expect(first.ok).toBe(true);
  expect(readReplySuggestions(SEAT)).not.toBeNull();

  /* The operator answered, so the set is over. */
  clearReplySuggestions(SEAT);
  expect(readReplySuggestions(SEAT)).toBeNull();

  const retry = await serviceAs(MANAGER, receipts).callTool("suggest_replies", call()) as McpToolResult & { code?: string; retryable?: boolean };

  expect(retry.ok).toBe(false);
  expect(retry.code).toBe("call_interrupted");
  /* The whole point: a disposable draft is not worth resurrecting under a
     question that has already been answered. */
  expect(readReplySuggestions(SEAT)).toBeNull();
  expect(readReplySuggestionsFile().sets).toHaveLength(0);
});
