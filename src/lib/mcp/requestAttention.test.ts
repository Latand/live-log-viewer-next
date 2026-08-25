import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import type { AttentionCallerAuthority } from "@/lib/attention/callerAuthority";
import type { RegistryConversation } from "@/lib/agent/registry";
import { answerAttentionRequest, awaitAttentionArrival, raiseAttentionRequest } from "@/lib/attention/service";
import { readAttentionFile } from "@/lib/attention/store";
import { adoptLiveRootSession } from "@/lib/root/adopt";
import { readRootLineage } from "@/lib/root/store";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { resetPresenceForTest, upsertPresence } from "@/lib/view/presenceStore";
import type { PresencePayloadV1 } from "@/lib/view/types";

import { viewerMcpBindings } from "./bindings";
import { createMcpToolService, MemoryMcpReceiptStore, MCP_TOOL_NAMES, type McpToolResult } from "./server";

/*
 * The root agent's own door into #688 — since #873, an immediate VERIFIED
 * handoff: the call resolves the one active view, moves it, and answers only
 * after the arrival landed on the record. The wait/selection/failure contract
 * itself lives in `requestAttention.immediate.test.ts`; this file keeps the
 * door's other properties — attribution, target resolution, refusals, receipt
 * durability, and the server-resolved root identity.
 */

let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-attention-"));
  process.env.LLV_STATE_DIR = sandbox;
  /* Presence decides which view the handoff moves, so a view left over from
     another test would answer this one's question for it. */
  resetPresenceForTest();
});
afterEach(() => {
  resetPresenceForTest();
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const REVIEWER = "/tmp/reviewer.jsonl";
const DEVICE = "device-desktop";

const reviewerFile = {
  path: REVIEWER,
  project: "live-log-viewer-next",
  title: "Reviewer — login fix",
  engine: "claude",
  activity: "live",
} as unknown as FileEntry;

const task = {
  id: "task_1",
  project: "other-project",
  status: "inbox",
  text: "Ship the handoff",
  placement: "unplaced",
  assignments: [],
  createdAt: "2026-07-01T10:00:00.000Z",
  updatedAt: "2026-07-01T10:00:00.000Z",
} as unknown as BoardTask;

interface Adoptions { count: number }

/** The operator's own session, which is what every test here is unless it says
    otherwise. The guard itself is exercised by the D4 tests at the bottom. */
const ROOT_CALLER: AttentionCallerAuthority = { kind: "root", conversationId: "conversation_root" };

/** The real awaiter on a clock a test can afford. */
const fastArrival: typeof awaitAttentionArrival = (id, options = {}) =>
  awaitAttentionArrival(id, { pollMs: 5, timeoutMs: 1_500, ...options });

function bindings(
  adoptions: Adoptions = { count: 0 },
  adoptRootSession = () => { adoptions.count += 1; },
  attentionAuthority: () => AttentionCallerAuthority = () => ROOT_CALLER,
) {
  return viewerMcpBindings(undefined, undefined, {
    /* #845: a single-conversation read consumes the COMPLETED generation and only
       falls back to a private pinned scan when that genuinely misses. Empty here, so
       these tests keep exercising the pinned fallback they were written against. */
    completedFileScan: async () => ({ snapshot: { files: [], projectCatalog: [], complete: true } }),
    listFiles: async () => [reviewerFile],
    loadTasks: () => [task],
    getPipelines: () => ({ pipelines: [{ id: "pipeline_1", project: "pipeline-project" }] }),
    getFlowsWithPresets: () => ({ flows: [{ id: "flow_1", project: "flow-project" }] }),
    adoptRootSession,
    attentionAuthority,
    /* The real one: it resolves the state path per call, so the sandbox set in
       beforeEach applies and the request lands on a real record. */
    raiseAttentionRequest,
    awaitAttentionArrival: fastArrival,
  } as never);
}

function service(adoptions: Adoptions = { count: 0 }) {
  return createMcpToolService(bindings(adoptions), new MemoryMcpReceiptStore());
}

function openView(overrides: Partial<PresencePayloadV1> = {}): PresencePayloadV1 {
  return {
    schemaVersion: 1,
    viewSessionId: "view-1",
    deviceId: DEVICE,
    device: { kind: "desktop", browser: "chrome" },
    visibility: "visible",
    sequence: 1,
    inputSequence: 1,
    project: "live-log-viewer-next",
    mode: "scheme",
    viewport: { width: 1_600, height: 900, dpr: 2 },
    camera: { x: 10, y: 20, zoom: 0.6, worldRect: { x: 0, y: 0, width: 100, height: 80 } },
    focusedPath: null,
    selectedPaths: [],
    visiblePaths: [],
    board: { renderedRevision: 4, durableRevision: 4, sync: "current" },
    ...overrides,
  };
}

/** An open desk plus its browser: lands every request directed at it, so the
    verified handoff can complete and the property under test stays visible. */
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

/** A root conversation exactly as the registry holds one — the `root` role on
    the newest generation's launch profile, which is the only place the registry
    ever writes it. Typed as the real thing so the shape cannot drift. */
function rootConversation(id: string, transcript: string, updatedAt: string): RegistryConversation {
  return {
    id: id as RegistryConversation["id"],
    engine: "claude",
    generations: [{
      id: `${id}_g0`,
      path: transcript,
      accountId: null,
      launchProfile: emptyLaunchProfile({ cwd: "/repo", role: "root" }),
      historyHash: null,
      host: null,
      createdAt: "2026-07-01T09:00:00.000Z",
      archivedAt: null,
    }],
    continuityPaths: [],
    abandonedContinuityPaths: [],
    providerForkPaths: [],
    projectOwnership: null,
    migration: null,
    migrationOptOut: null,
    supersededBy: null,
    /* No role PRESET: the operator's own session is precisely the one without
       one, which is why the preset id can never identify it. */
    agentRole: null,
    delegationDepth: null,
    turn: { state: "idle", source: "empty", terminalAt: null, observedAt: null },
    createdAt: "2026-07-01T09:00:00.000Z",
    updatedAt,
  };
}

const ask = (overrides: Record<string, unknown> = {}) => ({
  clientRequestId: "raise-1",
  target: { kind: "conversation", path: REVIEWER },
  reason: "The reviewer finished with request-changes.",
  ...overrides,
});

test("the root agent can move the view through its normal tool surface", async () => {
  const browser = desk();
  try {
    const adoptions = { count: 0 };
    const result = await service(adoptions).callTool("request_attention", ask()) as McpToolResult & { attentionId?: string };

    expect(result.ok).toBe(true);
    expect(result.attentionId).toStartWith("attention_");
    const stored = readAttentionFile().requests[0]!;
    /* #873: the success stands on a landed record — never on a pending ask. */
    expect(stored.state).toBe("following");
    expect(stored.origin).toBe("root-agent");
    expect(stored.intent).toBe("show");
    /* The project is derived from the target rather than taken from the caller,
       and the frame records that no board was read. */
    expect(stored.frameAtCreation).toEqual({ project: "live-log-viewer-next", rect: { x: 0, y: 0, w: 0, h: 0 }, boardRevision: null });
    /* The root is named by stable identity, never by a session path — and the
       live session was folded into the chain on the way past. */
    expect(stored.requestedBy.rootId).toBe(readRootLineage()!.rootId);
    expect(adoptions.count).toBe(1);
  } finally {
    browser.stop();
  }
});

test("a repeated clientRequestId replays the same receipt instead of moving twice", async () => {
  const browser = desk();
  try {
    const tools = service();

    const first = await tools.callTool("request_attention", ask()) as McpToolResult & { attentionId?: string };
    const again = await tools.callTool("request_attention", ask()) as McpToolResult & { attentionId?: string };

    expect(again.replayed).toBe(true);
    expect(again.attentionId).toBe(first.attentionId!);
    /* One move on the record. Without this a retried tool call would supersede
       its own previous request and navigate the operator a second time. */
    expect(readAttentionFile().requests).toHaveLength(1);
  } finally {
    browser.stop();
  }
});

test("the same key with different arguments is a conflict, not a second move", async () => {
  const browser = desk();
  try {
    const tools = service();
    await tools.callTool("request_attention", ask());

    const conflict = await tools.callTool("request_attention", ask({ reason: "Something else entirely." })) as McpToolResult;

    expect(conflict).toMatchObject({ ok: false, code: "idempotency_conflict" });
    expect(readAttentionFile().requests).toHaveLength(1);
  } finally {
    browser.stop();
  }
});

test("every target kind the server can attribute resolves its own project", async () => {
  const browser = desk();
  try {
    const tools = service();

    for (const [key, target, project] of [
      ["pipeline", { kind: "pipeline", pipelineId: "pipeline_1" }, "pipeline-project"],
      ["stage", { kind: "stage", pipelineId: "pipeline_1", stageId: "review" }, "pipeline-project"],
      ["flow", { kind: "flowRound", flowId: "flow_1", round: 2 }, "flow-project"],
      ["task", { kind: "task", taskId: "task_1" }, "other-project"],
      ["point", { kind: "point", project: "geometric", x: 10, y: 20 }, "geometric"],
    ] as const) {
      const result = await tools.callTool("request_attention", ask({ clientRequestId: `raise-${key}`, target })) as McpToolResult;
      expect(result.ok).toBe(true);
      expect(readAttentionFile().requests.at(-1)!.frameAtCreation.project).toBe(project);
    }

    /* A geometric target IS its own frame, so it is the one kind that can degrade
       to a real destination when nothing named survives. */
    expect(readAttentionFile().requests.at(-1)!.frameAtCreation.rect).toEqual({ x: -290, y: -280, w: 600, h: 600 });
  } finally {
    browser.stop();
  }
});

test("a target the server cannot attribute is refused rather than filed under a guess", async () => {
  const browser = desk();
  try {
    const tools = service();

    const draft = await tools.callTool("request_attention", ask({ clientRequestId: "raise-draft", target: { kind: "draft", draftId: "d1" } })) as McpToolResult;
    const missing = await tools.callTool("request_attention", ask({ clientRequestId: "raise-missing", target: { kind: "conversation", path: "/tmp/nope.jsonl" } })) as McpToolResult;
    const nonsense = await tools.callTool("request_attention", ask({ clientRequestId: "raise-nonsense", target: { kind: "elsewhere" } })) as McpToolResult;

    expect(draft).toMatchObject({ ok: false, error: "a draft target needs an explicit project" });
    expect(missing).toMatchObject({ ok: false, error: "no conversation on the board has that transcript path" });
    /* #1016: the rejection names the discriminator and its kinds rather than
       restating that the value was not a target. The per-kind wording is pinned
       in `requestAttention.targets.test.ts`. */
    expect(nonsense.ok).toBe(false);
    expect(nonsense.error).toContain('target.kind must be one of conversation | pipeline | stage | flowRound | task | draft | region | point');
    expect(nonsense.error).toContain('read kind "elsewhere"');
    expect(readAttentionFile().requests).toEqual([]);

    /* Naming the project explicitly is the way through for a board draft. */
    const named = await tools.callTool("request_attention", ask({ clientRequestId: "raise-draft-2", target: { kind: "draft", draftId: "d1" }, project: "demo" })) as McpToolResult;
    expect(named.ok).toBe(true);
    expect(readAttentionFile().requests[0]!.frameAtCreation.project).toBe("demo");
  } finally {
    browser.stop();
  }
});

test("a geometric target may not be opened, and the refusal reaches the caller", async () => {
  const browser = desk();
  try {
    const refused = await service().callTool("request_attention", ask({
      target: { kind: "region", project: "demo", rect: { x: 0, y: 0, w: 100, h: 100 } },
      intent: "open",
    })) as McpToolResult;

    /* Refused, never silently downgraded: the operator is told which of show and
       open they are agreeing to, so a rewritten intent would make that a lie. */
    expect(refused).toMatchObject({ ok: false, error: "a geometric target can only be shown, not opened" });
    expect(readAttentionFile().requests).toEqual([]);
  } finally {
    browser.stop();
  }
});

test("the move is a mutation, so its receipt outlives the MCP process", async () => {
  const browser = desk();
  try {
    const retentions: string[] = [];
    const store = new MemoryMcpReceiptStore();
    const spy = {
      claim: (key: string, digest: string, retention: string) => {
        retentions.push(retention);
        return store.claim(key, digest);
      },
      complete: (key: string, digest: string, result: McpToolResult) => store.complete(key, digest, result),
    };

    await createMcpToolService(bindings(), spy as never).callTool("request_attention", ask());

    /* A bounded receipt would let a retry after a restart move the operator a
       second time for the same logical call. */
    expect(retentions).toEqual(["durable"]);
    expect(MCP_TOOL_NAMES).toContain("request_attention");
  } finally {
    browser.stop();
  }
});

test("a raise folds the real live root session into the chain, and a rollover keeps the link", async () => {
  const browser = desk();
  try {
    /* The adoption runs for real here against registry-shaped conversations — not
       a counter — because the defect this closes was the resolution reading a
       field the registry never writes `root` into: the raise worked, the chain
       stayed empty, and every request named an identity with no sessions behind
       it. Only a production-shaped source can tell the two apart. */
    let live = [rootConversation("conversation_root", "/tmp/root.jsonl", "2026-07-01T10:00:00.000Z")];
    const tools = createMcpToolService(
      bindings(undefined, () => { adoptLiveRootSession({ conversations: live, configuredRootId: null }); }),
      new MemoryMcpReceiptStore(),
    );

    await tools.callTool("request_attention", ask());

    const identity = readRootLineage()!.rootId;
    expect(readRootLineage()!.sessions).toHaveLength(1);
    expect(readRootLineage()!.sessions[0]).toMatchObject({ conversationId: "conversation_root", path: "/tmp/root.jsonl" });

    /* The rollover D5 exists for: the session the operator is talking to is
       replaced, and a request raised before it must still resolve after. */
    live = [...live, rootConversation("conversation_root_2", "/tmp/root-2.jsonl", "2026-07-01T11:00:00.000Z")];
    await tools.callTool("request_attention", ask({ clientRequestId: "raise-2", reason: "The verifier is blocked on you." }));

    const sessions = readRootLineage()!.sessions;
    expect(sessions.map((session) => session.conversationId)).toEqual(["conversation_root", "conversation_root_2"]);
    expect(sessions[1]!.seededFrom).toBe("conversation_root");
    /* Same stable identity across the rollover, and both requests named it. */
    expect(readRootLineage()!.rootId).toBe(identity);
    expect(readAttentionFile().requests.map((entry) => entry.requestedBy.rootId)).toEqual([identity, identity]);
  } finally {
    browser.stop();
  }
});

test("no rootId can be named by the caller", async () => {
  const browser = desk();
  try {
    await service().callTool("request_attention", ask({ rootId: "root_somebody_else" }));

    /* D4's authority rule: the service resolves the root identity itself, so a
       worker holding this tool still cannot speak as a root of its choosing. */
    expect(readAttentionFile().requests[0]!.requestedBy.rootId).toBe(readRootLineage()!.rootId);
    expect(readAttentionFile().requests[0]!.requestedBy.rootId).not.toBe("root_somebody_else");
  } finally {
    browser.stop();
  }
});

/*
 * #873 review, finding 1: this call moves the operator's screen the moment it
 * is made — no confirmation surface stands between the caller and the camera
 * anymore — so who may make it is gated on server-derived authority. The tool
 * stays on every session's surface (B+ availability is untouched); what the
 * binding refuses is EXECUTION: only the operator's own root/gateway session
 * and the target project's validated orchestrator seat move the view. A
 * refused caller files nothing: zero attention records, zero navigation.
 */

const workerCaller: AttentionCallerAuthority = {
  kind: "worker",
  conversationId: "conversation_reviewer",
  role: "reviewer",
};

function serviceAs(authority: AttentionCallerAuthority) {
  return createMcpToolService(bindings(undefined, undefined, () => authority), new MemoryMcpReceiptStore());
}

test("a worker caller is refused before anything durable exists: no record, no navigation", async () => {
  const browser = desk();
  try {
    const result = await serviceAs(workerCaller).callTool("request_attention", ask()) as McpToolResult;

    expect(result.ok).toBe(false);
    expect((result as { details?: { code?: string; refusedAs?: string } }).details?.code).toBe("ATTENTION_NOT_PERMITTED");
    expect((result as { details?: { refusedAs?: string } }).details?.refusedAs).toBe("worker");
    /* Zero durable traces: nothing for any browser poll to navigate later. */
    expect(readAttentionFile().requests).toHaveLength(0);
  } finally {
    browser.stop();
  }
});

test("the gateway's raise is attributed as the gateway", async () => {
  const browser = desk();
  try {
    await serviceAs(ROOT_CALLER).callTool("request_attention", ask({ clientRequestId: "raise-root" }));
    const stored = readAttentionFile().requests[0]!;
    expect(stored.raisedBy).toEqual({ kind: "gateway", conversationId: "conversation_root", role: null });
  } finally {
    browser.stop();
  }
});

test("a caller no recorded host names is refused: an unattributable identity may not move the screen", async () => {
  const browser = desk();
  try {
    /* Unidentified is an honest label for snapshots and reports, and exactly
       the identity that must never hold the camera: nothing durable would say
       WHO moved the operator's view. */
    const result = await serviceAs({ kind: "unidentified" }).callTool("request_attention", ask()) as McpToolResult;

    expect(result.ok).toBe(false);
    expect((result as { details?: { code?: string; refusedAs?: string } }).details?.code).toBe("ATTENTION_NOT_PERMITTED");
    expect((result as { details?: { refusedAs?: string } }).details?.refusedAs).toBe("unidentified");
    expect(readAttentionFile().requests).toHaveLength(0);
  } finally {
    browser.stop();
  }
});

/* ── What the answer says about who was moved ───────────────────────────── */

test("the answer names the desktop the operator is sitting in front of", async () => {
  /* The #873 successor of the old `offeredTo: []` defect: the tool runs in
     another process than the presence heartbeat, so the answer has to come off
     the shared record rather than out of whichever map this process holds —
     and it now names the ONE device that was actually moved. */
  const browser = desk();
  try {
    const result = await service().callTool("request_attention", ask()) as McpToolResult
      & { request?: { offeredTo?: string[]; state?: string }; handoff?: { deviceId?: string } };

    expect(result.ok).toBe(true);
    expect(result.request!.offeredTo).toEqual([DEVICE]);
    expect(result.handoff!.deviceId).toBe(DEVICE);
    /* Landed, not asked: success exists only after the arrival. */
    expect(result.request!.state).toBe("following");
  } finally {
    browser.stop();
  }
});

test("with nobody at a desk the call fails explicitly rather than naming a device that will not move", async () => {
  upsertPresence(openView({ viewSessionId: "view-phone", deviceId: "device-phone", device: { kind: "mobile", browser: "safari" } }));

  const result = await service().callTool("request_attention", ask()) as McpToolResult;

  expect(result.ok).toBe(false);
  expect((result as { details?: { code?: string } }).details?.code).toBe("NO_ACTIVE_VIEW");
  expect(readAttentionFile().requests).toEqual([]);
});
