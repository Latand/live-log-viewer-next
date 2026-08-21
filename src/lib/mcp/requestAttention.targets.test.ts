import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AttentionCallerAuthority } from "@/lib/attention/callerAuthority";
import { answerAttentionRequest, awaitAttentionArrival, raiseAttentionRequest } from "@/lib/attention/service";
import { readAttentionFile } from "@/lib/attention/store";
import { FOCUS_TARGET_SHAPES } from "@/lib/attention/targets";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { resetPresenceForTest, upsertPresence } from "@/lib/view/presenceStore";
import type { PresencePayloadV1 } from "@/lib/view/types";

import { viewerMcpBindings } from "./bindings";
import { createMcpToolService, MemoryMcpReceiptStore, type McpToolResult } from "./server";

/*
 * #1016 — the target contract, exercised as a caller meets it.
 *
 * The reported failure was not a bug in any single check: `target` published no
 * structure, so a caller composing one from the tool definition had nothing to
 * compose from, and every rejection answered "target must be a typed focus
 * target" whatever was wrong. This file pins the three things that closed it:
 * every PUBLISHED example is a call that actually works, a conversation can be
 * named by the durable id the rest of the MCP surface speaks, and a mis-shaped
 * target is refused in words that name the way through.
 */

let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-attention-targets-"));
  process.env.LLV_STATE_DIR = sandbox;
  resetPresenceForTest();
});
afterEach(() => {
  resetPresenceForTest();
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** The board the published examples name, entity for entity. */
const WORKER_PATH = "/tmp/worker-9f2c.jsonl";
const WORKER_ID = "conversation_9f2c";
const DEVICE = "device-desktop";
const PROJECT = "live-log-viewer-next";

const workerFile = {
  path: WORKER_PATH,
  project: PROJECT,
  title: "Builder — attention DX",
  engine: "claude",
  activity: "live",
} as unknown as FileEntry;

const boardTask = {
  id: "task_9f2c",
  project: PROJECT,
  status: "inbox",
  text: "Ship the handoff",
  placement: "unplaced",
  assignments: [],
  createdAt: "2026-08-19T10:00:00.000Z",
  updatedAt: "2026-08-19T10:00:00.000Z",
} as unknown as BoardTask;

const ROOT_CALLER: AttentionCallerAuthority = { kind: "root", conversationId: "conversation_root" };

const fastArrival: typeof awaitAttentionArrival = (id, options = {}) =>
  awaitAttentionArrival(id, { pollMs: 5, timeoutMs: 1_500, ...options });

function service() {
  const bindings = viewerMcpBindings(undefined, undefined, {
    completedFileScan: async () => ({ snapshot: { files: [], projectCatalog: [], complete: true } }),
    listFiles: async () => [workerFile],
    loadTasks: () => [boardTask],
    getPipelines: () => ({ pipelines: [{ id: "pipeline_9f2c", project: PROJECT }] }),
    getFlowsWithPresets: () => ({ flows: [{ id: "flow_9f2c", project: PROJECT }] }),
    /* The durable id the published conversation example names, holding the
       transcript its CURRENT generation is written to. */
    registrySnapshot: () => ({
      conversations: {
        [WORKER_ID]: {
          id: WORKER_ID,
          generations: [{ path: "/tmp/worker-9f2c.superseded.jsonl" }, { path: WORKER_PATH }],
          continuityPaths: [],
        },
      },
      conversationAliases: {},
    }),
    adoptRootSession: () => {},
    attentionAuthority: () => ROOT_CALLER,
    raiseAttentionRequest,
    awaitAttentionArrival: fastArrival,
  } as never);
  return createMcpToolService(bindings, new MemoryMcpReceiptStore());
}

function openView(): PresencePayloadV1 {
  return {
    schemaVersion: 1,
    viewSessionId: "view-1",
    deviceId: DEVICE,
    device: { kind: "desktop", browser: "chrome" },
    visibility: "visible",
    sequence: 1,
    inputSequence: 1,
    project: PROJECT,
    mode: "scheme",
    viewport: { width: 1_600, height: 900, dpr: 2 },
    camera: { x: 10, y: 20, zoom: 0.6, worldRect: { x: 0, y: 0, width: 100, height: 80 } },
    focusedPath: null,
    selectedPaths: [],
    visiblePaths: [],
    board: { renderedRevision: 4, durableRevision: 4, sync: "current" },
  };
}

/** An open desk and its browser, so a directed handoff can land. */
function desk() {
  upsertPresence(openView());
  const timer = setInterval(() => {
    try {
      for (const request of readAttentionFile().requests) {
        if (request.state !== "accepted" || request.acknowledgedBy !== DEVICE) continue;
        answerAttentionRequest(request.id, {
          kind: "arrive",
          deviceId: DEVICE,
          returnPoint: {
            deviceId: DEVICE,
            mode: "scheme",
            camera: { x: 120, y: 340, zoom: 0.55 },
            focusedPath: "/tmp/what-i-was-reading.jsonl",
            capturedAt: new Date().toISOString(),
          },
          resolution: "exact",
        });
      }
    } catch { /* mid-write read; the next tick sees the settled file */ }
  }, 10);
  return { stop: () => clearInterval(timer) };
}

const ask = (overrides: Record<string, unknown> = {}) => ({
  clientRequestId: "raise-1",
  target: { kind: "conversation", path: WORKER_PATH },
  reason: "The builder just opened the PR.",
  ...overrides,
});

/* The published examples ARE the contract: if one of them cannot be pasted into
   a call, the tool definition is teaching a shape the server refuses. */
test("every published per-kind example is a call that works", async () => {
  const browser = desk();
  try {
    const tools = service();

    for (const shape of FOCUS_TARGET_SHAPES) {
      const target = JSON.parse(shape.example) as Record<string, unknown>;
      const result = await tools.callTool("request_attention", ask({
        clientRequestId: `raise-${shape.kind}`,
        target,
        /* The one kind the server cannot attribute on its own, exactly as the
           published fields say. */
        ...(shape.kind === "draft" ? { project: PROJECT } : {}),
      })) as McpToolResult;

      expect([shape.kind, result.ok, result.error ?? null]).toEqual([shape.kind, true, null]);
      const stored = readAttentionFile().requests.at(-1)!;
      /* The durable id resolves to the CURRENT generation's transcript, so the
         record stores the same target a path-bearing caller would have written
         — the id is an input form, never a second kind of record. */
      expect(stored.target).toEqual(
        shape.kind === "conversation" ? { kind: "conversation", path: WORKER_PATH } : target as never,
      );
    }
    expect(readAttentionFile().requests).toHaveLength(FOCUS_TARGET_SHAPES.length);
  } finally {
    browser.stop();
  }
});

/* The five shapes the report tried, reconstructed from it: an id with no kind,
   a `type` discriminator, the kind + durable id, a plausibly-named path field,
   and the bare id as a string. Exactly one of them was ever going to be the
   contract; what the report proves is that the other four taught nothing. */
test("the five shapes from the report either land or say what was expected", async () => {
  const browser = desk();
  try {
    const tools = service();

    const byId = await tools.callTool("request_attention", ask({
      clientRequestId: "shape-3",
      target: { kind: "conversation", conversationId: WORKER_ID },
    })) as McpToolResult;
    expect(byId.ok).toBe(true);
    expect(readAttentionFile().requests.at(-1)!.target).toEqual({ kind: "conversation", path: WORKER_PATH });

    for (const [key, target, expected] of [
      ["no-kind", { conversationId: WORKER_ID }, [
        'target.kind must be one of conversation | pipeline | stage | flowRound | task | draft | region | point; read no "kind"',
        "received keys: conversationId",
        '{"kind":"conversation","conversationId":"conversation_9f2c"}',
      ]],
      ["type-discriminator", { type: "conversation", conversationId: WORKER_ID }, [
        'read no "kind"',
        "received keys: type, conversationId",
      ]],
      ["wrong-field", { kind: "conversation", transcriptPath: WORKER_PATH }, [
        'target kind "conversation" expects conversationId',
        "or path (that transcript's .jsonl path) — at least one",
        "received keys: kind, transcriptPath",
      ]],
      ["bare-string", WORKER_ID, [
        'target must be an object discriminated by "kind": one of conversation | pipeline | stage | flowRound | task | draft | region | point',
      ]],
    ] as const) {
      const refused = await tools.callTool("request_attention", ask({ clientRequestId: `shape-${key}`, target })) as McpToolResult;
      expect(refused.ok).toBe(false);
      for (const fragment of expected) expect(refused.error).toContain(fragment);
      /* Whatever it says, it never says the sentence that started this. */
      expect(refused.error).not.toBe("target must be a typed focus target");
    }

    /* One landed move, four refusals that filed nothing. */
    expect(readAttentionFile().requests).toHaveLength(1);
  } finally {
    browser.stop();
  }
});

test("a wrong shape names the kind it read and the fields that kind expects", async () => {
  const tools = service();

  for (const [key, target, expected] of [
    ["unknown-kind", { kind: "elsewhere", id: "x" }, [
      'target.kind must be one of conversation | pipeline | stage | flowRound | task | draft | region | point; read kind "elsewhere"',
      "received keys: kind, id",
    ]],
    ["task-wrong-field", { kind: "task", id: "task_9f2c" }, [
      'target kind "task" expects taskId (non-empty string)',
      'e.g. {"kind":"task","taskId":"task_9f2c"}',
    ]],
    ["stage-missing-half", { kind: "stage", pipelineId: "pipeline_9f2c" }, [
      'target kind "stage" expects pipelineId and stageId (non-empty strings)',
      '{"kind":"stage","pipelineId":"pipeline_9f2c","stageId":"review"}',
    ]],
    ["round-not-an-integer", { kind: "flowRound", flowId: "flow_9f2c", round: "2" }, [
      'target kind "flowRound" expects flowId (non-empty string) and round (integer, 0 or more)',
    ]],
    ["point-without-project", { kind: "point", x: 1, y: 2 }, [
      'target kind "point" expects project (non-empty string), x and y (finite numbers)',
    ]],
    ["conversation-empty", { kind: "conversation" }, [
      'target kind "conversation" expects conversationId (the durable "conversation_…" id, resolved to its current transcript)',
      "received keys: kind",
    ]],
  ] as const) {
    const refused = await tools.callTool("request_attention", ask({ clientRequestId: `bad-${key}`, target })) as McpToolResult;

    expect(refused.ok).toBe(false);
    for (const fragment of expected) expect(refused.error).toContain(fragment);
  }
  expect(readAttentionFile().requests).toEqual([]);
});

/* A conversationId nothing on the board answers to is the one miss a caller
   cannot tell from "the id form is unsupported" — so the refusal names both
   accepted forms rather than only the one that failed. */
test("an unresolvable conversationId names both accepted conversation forms", async () => {
  const refused = await service().callTool("request_attention", ask({
    clientRequestId: "missing-id",
    target: { kind: "conversation", conversationId: "conversation_gone" },
  })) as McpToolResult;

  expect(refused.ok).toBe(false);
  expect(refused.error).toContain('no registered conversation has id "conversation_gone"');
  expect(refused.error).toContain('{"kind":"conversation","conversationId":"conversation_9f2c"}');
  expect(refused.error).toContain('{"kind":"conversation","path":"/…/transcript.jsonl"}');
  expect(readAttentionFile().requests).toEqual([]);
});

/* The id is a way IN for callers that have no path, never a reinterpretation of
   calls that already work: a target carrying a usable path is recorded exactly
   as it arrived, down to whatever else it carries. */
test("a target that already names a path is recorded untouched", async () => {
  const browser = desk();
  try {
    const result = await service().callTool("request_attention", ask({
      target: { kind: "conversation", path: WORKER_PATH, conversationId: "conversation_gone" },
    })) as McpToolResult;

    expect(result.ok).toBe(true);
    expect(readAttentionFile().requests.at(-1)!.target).toEqual({
      kind: "conversation", path: WORKER_PATH, conversationId: "conversation_gone",
    } as never);
  } finally {
    browser.stop();
  }
});
