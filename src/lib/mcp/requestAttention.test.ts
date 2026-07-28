import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import type { AttentionCallerAuthority } from "@/lib/attention/callerAuthority";
import type { RegistryConversation } from "@/lib/agent/registry";
import { raiseAttentionRequest } from "@/lib/attention/service";
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
 * The root agent's own door into #688.
 *
 * Before this there was none: the record, the machine and the HTTP surface all
 * existed, and the only way to raise a request was a hand-written POST. The
 * agent could not ask for the operator's attention through the surface it
 * actually has.
 */

let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-attention-"));
  process.env.LLV_STATE_DIR = sandbox;
});
afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const REVIEWER = "/tmp/reviewer.jsonl";

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

function bindings(
  adoptions: Adoptions = { count: 0 },
  adoptRootSession = () => { adoptions.count += 1; },
  attentionAuthority: () => AttentionCallerAuthority = () => ROOT_CALLER,
) {
  return viewerMcpBindings(undefined, undefined, {
    listFiles: async () => [reviewerFile],
    loadTasks: () => [task],
    getPipelines: () => ({ pipelines: [{ id: "pipeline_1", project: "pipeline-project" }] }),
    getFlowsWithPresets: () => ({ flows: [{ id: "flow_1", project: "flow-project" }] }),
    adoptRootSession,
    attentionAuthority,
    /* The real one: it resolves the state path per call, so the sandbox set in
       beforeEach applies and the request lands on a real record. */
    raiseAttentionRequest,
  } as never);
}

function service(adoptions: Adoptions = { count: 0 }) {
  return createMcpToolService(bindings(adoptions), new MemoryMcpReceiptStore());
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

test("the root agent can raise a request through its normal tool surface", async () => {
  const adoptions = { count: 0 };
  const result = await service(adoptions).callTool("request_attention", ask()) as McpToolResult & { attentionId?: string };

  expect(result.ok).toBe(true);
  expect(result.attentionId).toStartWith("attention_");
  const stored = readAttentionFile().requests[0]!;
  /* It only ASKS: nothing moves until the operator agrees on a device. */
  expect(stored.state).toBe("pending");
  expect(stored.origin).toBe("root-agent");
  expect(stored.intent).toBe("show");
  /* The project is derived from the target rather than taken from the caller,
     and the frame records that no board was read. */
  expect(stored.frameAtCreation).toEqual({ project: "live-log-viewer-next", rect: { x: 0, y: 0, w: 0, h: 0 }, boardRevision: null });
  /* The root is named by stable identity, never by a session path — and the
     live session was folded into the chain on the way past. */
  expect(stored.requestedBy.rootId).toBe(readRootLineage()!.rootId);
  expect(adoptions.count).toBe(1);
});

test("a repeated clientRequestId replays the same receipt instead of asking twice", async () => {
  const tools = service();

  const first = await tools.callTool("request_attention", ask()) as McpToolResult & { attentionId?: string };
  const again = await tools.callTool("request_attention", ask()) as McpToolResult & { attentionId?: string };

  expect(again.replayed).toBe(true);
  expect(again.attentionId).toBe(first.attentionId!);
  /* One ask on the record. Without this a retried tool call would supersede its
     own previous request and the operator would watch the card replace itself. */
  expect(readAttentionFile().requests).toHaveLength(1);
});

test("the same key with different arguments is a conflict, not a second ask", async () => {
  const tools = service();
  await tools.callTool("request_attention", ask());

  const conflict = await tools.callTool("request_attention", ask({ reason: "Something else entirely." })) as McpToolResult;

  expect(conflict).toMatchObject({ ok: false, code: "idempotency_conflict" });
  expect(readAttentionFile().requests).toHaveLength(1);
});

test("every target kind the server can attribute resolves its own project", async () => {
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
});

test("a target the server cannot attribute is refused rather than filed under a guess", async () => {
  const tools = service();

  const draft = await tools.callTool("request_attention", ask({ clientRequestId: "raise-draft", target: { kind: "draft", draftId: "d1" } })) as McpToolResult;
  const missing = await tools.callTool("request_attention", ask({ clientRequestId: "raise-missing", target: { kind: "conversation", path: "/tmp/nope.jsonl" } })) as McpToolResult;
  const nonsense = await tools.callTool("request_attention", ask({ clientRequestId: "raise-nonsense", target: { kind: "elsewhere" } })) as McpToolResult;

  expect(draft).toMatchObject({ ok: false, error: "a draft target needs an explicit project" });
  expect(missing).toMatchObject({ ok: false, error: "no conversation on the board has that transcript path" });
  expect(nonsense).toMatchObject({ ok: false, error: "target must be a typed focus target" });
  expect(readAttentionFile().requests).toEqual([]);

  /* Naming the project explicitly is the way through for a board draft. */
  const named = await tools.callTool("request_attention", ask({ clientRequestId: "raise-draft-2", target: { kind: "draft", draftId: "d1" }, project: "demo" })) as McpToolResult;
  expect(named.ok).toBe(true);
  expect(readAttentionFile().requests[0]!.frameAtCreation.project).toBe("demo");
});

test("a geometric target may not be opened, and the refusal reaches the caller", async () => {
  const tools = service();

  const refused = await tools.callTool("request_attention", ask({
    target: { kind: "region", project: "demo", rect: { x: 0, y: 0, w: 100, h: 100 } },
    intent: "open",
  })) as McpToolResult;

  /* Refused, never silently downgraded: the operator is told which of show and
     open they are agreeing to, so a rewritten intent would make that a lie. */
  expect(refused).toMatchObject({ ok: false, error: "a geometric target can only be shown, not opened" });
  expect(readAttentionFile().requests).toEqual([]);
});

test("the ask is a mutation, so its receipt outlives the MCP process", async () => {
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

  /* A bounded receipt would let a retry after a restart ask the operator a
     second time for the same thing. */
  expect(retentions).toEqual(["durable"]);
  expect(MCP_TOOL_NAMES).toContain("request_attention");
});

test("a raise folds the real live root session into the chain, and a rollover keeps the link", async () => {
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
});

test("no rootId can be named by the caller", async () => {
  const tools = service();

  await tools.callTool("request_attention", ask({ rootId: "root_somebody_else" }));

  /* D4's authority rule: the service resolves the root identity itself, so a
     worker holding this tool still cannot speak as a root of its choosing. */
  expect(readAttentionFile().requests[0]!.requestedBy.rootId).toBe(readRootLineage()!.rootId);
  expect(readAttentionFile().requests[0]!.requestedBy.rootId).not.toBe("root_somebody_else");
});

/*
 * D4's authority rule, on the side the record could never enforce.
 *
 * `rootId` was already resolved server-side, so nobody could name a root of
 * their choosing — and that was read as the rule being enforced. It was not.
 * Every Viewer-spawned worker is registered with this same `viewer` MCP server,
 * so a worker calling this tool got the operator's own root identity written
 * onto a request `origin: "root-agent"`: not a forged root, the REAL one, asked
 * for by something that holds no claim on the operator's screen.
 */

const workerCaller: AttentionCallerAuthority = {
  kind: "worker",
  conversationId: "conversation_reviewer",
  role: "reviewer",
};

function serviceAs(authority: AttentionCallerAuthority) {
  return createMcpToolService(bindings(undefined, undefined, () => authority), new MemoryMcpReceiptStore());
}

test("a worker holding this tool is refused, and nothing reaches the record", async () => {
  const refused = await serviceAs(workerCaller).callTool("request_attention", ask()) as McpToolResult;

  expect(refused).toMatchObject({
    ok: false,
    error: "only the operator's root session may raise an attention request",
  });
  /* Named, so the agent can say why it was refused rather than retrying into a
     wall — and so the operator can see which worker tried. */
  expect((refused as { details?: Record<string, unknown> }).details)
    .toMatchObject({ callerConversationId: "conversation_reviewer", callerRole: "reviewer" });
  /* The whole point: no card, no queue entry, no expiry the root agent would
     later be told about as if it had asked. */
  expect(readAttentionFile().requests).toEqual([]);
});

test("the refusal lands before the root lineage is touched", async () => {
  const adoptions = { count: 0 };
  const tools = createMcpToolService(
    bindings(adoptions, undefined, () => workerCaller),
    new MemoryMcpReceiptStore(),
  );

  await tools.callTool("request_attention", ask());

  /* A worker must not be able to drive root-session adoption either: the raise
     path writes the durable lineage, and a refused caller reaching it would let
     a worker move the operator's root identity forward as a side effect. */
  expect(adoptions.count).toBe(0);
});

test("a caller no recorded host names is allowed through", async () => {
  /* Deliberate, and the reason is in `callerAuthority.ts`: the operator's root
     session is often a terminal the Viewer observes rather than launched, so
     there are ordinary setups with no host evidence naming it. Refusing those
     would take the feature from the person it exists for, to stop something
     that already requires running code as them. */
  const result = await serviceAs({ kind: "unidentified" }).callTool("request_attention", ask()) as McpToolResult;

  expect(result.ok).toBe(true);
  expect(readAttentionFile().requests).toHaveLength(1);
});

/* ── What the answer says about who will see it ─────────────────────────── */

function openView(overrides: Partial<PresencePayloadV1> = {}): PresencePayloadV1 {
  return {
    schemaVersion: 1,
    viewSessionId: "view-1",
    deviceId: "device-desktop",
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

test("the answer names the desktop the operator is sitting in front of", async () => {
  /* The reported defect, at the exact surface it was reported from: an open,
     visible desktop viewer, and a tool answering `offeredTo: []`. The presence
     the browser publishes lives in the server's process; the tool runs in
     another one, so the answer has to come off the shared record rather than
     out of whichever map this process happens to hold. */
  resetPresenceForTest();
  upsertPresence(openView());

  const result = await service().callTool("request_attention", ask()) as McpToolResult & { request?: { offeredTo?: string[]; state?: string } };

  expect(result.ok).toBe(true);
  expect(result.request!.offeredTo).toEqual(["device-desktop"]);
  /* Still only an ask: naming the desktop is not agreeing on its behalf. */
  expect(result.request!.state).toBe("pending");
  resetPresenceForTest();
});

test("with nobody at a desk the answer says so rather than naming a device that will not move", async () => {
  resetPresenceForTest();
  upsertPresence(openView({ viewSessionId: "view-phone", deviceId: "device-phone", device: { kind: "mobile", browser: "safari" } }));

  const result = await service().callTool("request_attention", ask()) as McpToolResult & { request?: { offeredTo?: string[] } };

  expect(result.request!.offeredTo).toEqual([]);
  resetPresenceForTest();
});
