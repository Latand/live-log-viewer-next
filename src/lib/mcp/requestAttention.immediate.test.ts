import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AttentionCallerAuthority } from "@/lib/attention/callerAuthority";
import { answerAttentionRequest, awaitAttentionArrival, raiseAttentionRequest } from "@/lib/attention/service";
import { readAttentionFile } from "@/lib/attention/store";
import type { AttentionRequestV1, FocusResolutionKind } from "@/lib/attention/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { resetPresenceForTest, upsertPresence } from "@/lib/view/presenceStore";
import type { PresencePayloadV1 } from "@/lib/view/types";

import { viewerMcpBindings } from "./bindings";
import { createMcpToolService, MemoryMcpReceiptStore, type McpToolResult } from "./server";

/*
 * #873 — the immediate, VERIFIED camera handoff.
 *
 * The production incident this closes: `request_attention` committed a
 * `pending` record, offered it to two devices, and returned success before the
 * active camera moved — the browser auto-followed on a later poll. The contract
 * under test here is the opposite shape: the call resolves exactly one
 * latest-interaction active view, the record never passes through an actionable
 * pending/offered state, and the successful MCP response exists only after the
 * chosen view actually arrived (or a bounded explicit failure closed it).
 */

let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-attention-immediate-"));
  process.env.LLV_STATE_DIR = sandbox;
  resetPresenceForTest();
});
afterEach(() => {
  resetPresenceForTest();
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

const ROOT_CALLER: AttentionCallerAuthority = { kind: "root", conversationId: "conversation_root" };

/** Fast production wait: the real awaiter, on a clock a test can afford. */
const fastArrival: typeof awaitAttentionArrival = (id, options = {}) =>
  awaitAttentionArrival(id, { pollMs: 5, timeoutMs: 1_500, ...options });

function service(overrides: Record<string, unknown> = {}) {
  return createMcpToolService(viewerMcpBindings(undefined, undefined, {
    completedFileScan: async () => ({ snapshot: { files: [], projectCatalog: [], complete: true } }),
    listFiles: async () => [reviewerFile],
    loadTasks: () => [] as BoardTask[],
    getPipelines: () => ({ pipelines: [] }),
    getFlowsWithPresets: () => ({ flows: [] }),
    adoptRootSession: () => {},
    attentionAuthority: () => ROOT_CALLER,
    raiseAttentionRequest,
    awaitAttentionArrival: fastArrival,
    ...overrides,
  } as never), new MemoryMcpReceiptStore());
}

const ask = (overrides: Record<string, unknown> = {}) => ({
  clientRequestId: "handoff-1",
  target: { kind: "conversation", path: REVIEWER },
  reason: "The reviewer finished with request-changes.",
  ...overrides,
});

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

/** What the return point the stand-in browser reports looks like. */
const BEFORE = {
  mode: "scheme" as const,
  camera: { x: 120, y: 340, zoom: 0.55 },
  focusedPath: "/tmp/what-i-was-reading.jsonl",
};

/**
 * The browser's half of the handoff, played against the REAL record: watch the
 * file for a request this device owns, and land it. `arrive` is legal only from
 * `accepted` by the acknowledger, so the stand-in also proves the record never
 * needed an offer or an accept from the device.
 */
function browserStandIn(deviceId: string, resolution: FocusResolutionKind = "exact") {
  const arrivals: string[] = [];
  const timer = setInterval(() => {
    try {
      for (const request of readAttentionFile().requests) {
        if (request.state !== "accepted" || request.acknowledgedBy !== deviceId) continue;
        if (resolution === "lost") {
          answerAttentionRequest(request.id, { kind: "abandon", deviceId });
          arrivals.push(request.id);
          continue;
        }
        const landed = answerAttentionRequest(request.id, {
          kind: "arrive",
          deviceId,
          returnPoint: { deviceId, capturedAt: new Date().toISOString(), ...BEFORE },
          resolution,
        });
        if (landed.ok) arrivals.push(request.id);
      }
    } catch {
      /* mid-write read; the next tick sees the settled file */
    }
  }, 10);
  return { arrivals, stop: () => clearInterval(timer) };
}

type HandoffResult = McpToolResult & {
  attentionId?: string;
  request?: AttentionRequestV1;
  handoff?: { deviceId: string; state: string; resolution: string | null; arrivedAt: string };
};

test("success is reported only after the chosen view arrived — never as a pending offer", async () => {
  upsertPresence(openView());
  const browser = browserStandIn("device-desktop");
  try {
    const result = await service().callTool("request_attention", ask()) as HandoffResult;

    expect(result.ok).toBe(true);
    /* The durable postcondition: the record the response describes has already
       LANDED. `following` is the state the arrival wrote, and the return point
       captured before the move is on it. */
    const stored = readAttentionFile().requests[0]!;
    expect(stored.state).toBe("following");
    expect(stored.acknowledgedBy).toBe("device-desktop");
    expect(stored.acceptedVia).toBe("auto-follow");
    expect(stored.returnPoints).toHaveLength(1);
    expect(result.handoff).toMatchObject({ deviceId: "device-desktop", state: "following", resolution: "exact" });
    expect(result.request!.state).toBe("following");
  } finally {
    browser.stop();
  }
});

test("the record never passes through an actionable pending or offered state", async () => {
  upsertPresence(openView());
  /* A stand-in that would ANSWER an offer the way the old flow did. If the
     record ever surfaces as pending/offered, these transitions succeed and the
     test fails; under the immediate contract they are refused as
     invalid-transition because the record was born accepted. */
  const observed: string[] = [];
  const timer = setInterval(() => {
    try {
      for (const request of readAttentionFile().requests) {
        observed.push(request.state);
        if (request.state === "pending" || request.state === "offered") continue;
        if (request.state === "accepted" && request.acknowledgedBy === "device-desktop") {
          answerAttentionRequest(request.id, {
            kind: "arrive",
            deviceId: "device-desktop",
            returnPoint: { deviceId: "device-desktop", capturedAt: new Date().toISOString(), ...BEFORE },
            resolution: "exact",
          });
        }
      }
    } catch { /* mid-write */ }
  }, 5);
  try {
    const result = await service().callTool("request_attention", ask()) as HandoffResult;
    expect(result.ok).toBe(true);
  } finally {
    clearInterval(timer);
  }
  observed.push(readAttentionFile().requests[0]!.state);
  expect(observed).not.toContain("pending");
  expect(observed).not.toContain("offered");
});

test("with no eligible active view the call fails explicitly and asks nothing durable", async () => {
  /* Nobody at a desk: only a phone (chat-only, cannot move a board). */
  upsertPresence(openView({ viewSessionId: "view-phone", deviceId: "device-phone", device: { kind: "mobile", browser: "safari" } }));

  const result = await service().callTool("request_attention", ask()) as McpToolResult;

  expect(result.ok).toBe(false);
  expect((result as { details?: { code?: string } }).details?.code).toBe("NO_ACTIVE_VIEW");
  /* No record: there is no device that could ever answer it, and a durable
     pending ask would be exactly the silent state this contract removes. */
  expect(readAttentionFile().requests).toEqual([]);
});

test("a background device receives no competing offer; the active one is chosen", async () => {
  upsertPresence(openView({ viewSessionId: "view-active", deviceId: "device-active" }));
  upsertPresence(openView({ viewSessionId: "view-hidden", deviceId: "device-hidden", visibility: "hidden" }));
  const browser = browserStandIn("device-active");
  try {
    const result = await service().callTool("request_attention", ask()) as HandoffResult;

    expect(result.ok).toBe(true);
    const stored = readAttentionFile().requests[0]!;
    expect(stored.acknowledgedBy).toBe("device-active");
    /* Exactly one device on the record: the hidden one is named nowhere, so no
       surface can ever render it a competing offer. */
    expect(stored.offeredTo).toEqual(["device-active"]);
  } finally {
    browser.stop();
  }
});

test("two active devices: the latest interaction wins, deterministically", async () => {
  const t0 = Date.now() - 10_000;
  upsertPresence(openView({ viewSessionId: "view-older", deviceId: "device-older" }), t0);
  upsertPresence(openView({ viewSessionId: "view-newer", deviceId: "device-newer" }), t0 + 5_000);
  const browser = browserStandIn("device-newer");
  try {
    const result = await service().callTool("request_attention", ask()) as HandoffResult;

    expect(result.ok).toBe(true);
    const stored = readAttentionFile().requests[0]!;
    expect(stored.acknowledgedBy).toBe("device-newer");
    expect(stored.offeredTo).toEqual(["device-newer"]);
  } finally {
    browser.stop();
  }
});

test("a handoff nobody completes ends as a bounded explicit failure, not a lingering ask", async () => {
  upsertPresence(openView());
  /* No browser stand-in: the chosen view never lands. */
  const tools = service({
    awaitAttentionArrival: ((id, options) => awaitAttentionArrival(id, { ...options, pollMs: 5, timeoutMs: 60 })) as typeof awaitAttentionArrival,
  });

  const result = await tools.callTool("request_attention", ask()) as McpToolResult;

  expect(result.ok).toBe(false);
  expect((result as { details?: { code?: string } }).details?.code).toBe("HANDOFF_TIMEOUT");
  /* The record is CLOSED, not abandoned mid-flight: nothing is left for a later
     poll to navigate, so the failure the agent was told is the whole truth. */
  const stored = readAttentionFile().requests[0]!;
  expect(stored.state).toBe("expired");
  expect(stored.expiredCause).toBe("lost");
});

test("a target the view finds nowhere to land is an explicit lost-target failure", async () => {
  upsertPresence(openView());
  const browser = browserStandIn("device-desktop", "lost");
  try {
    const result = await service().callTool("request_attention", ask()) as McpToolResult;

    expect(result.ok).toBe(false);
    expect((result as { details?: { code?: string } }).details?.code).toBe("TARGET_LOST");
    const stored = readAttentionFile().requests[0]!;
    expect(stored.state).toBe("expired");
    expect(stored.expiredCause).toBe("lost");
  } finally {
    browser.stop();
  }
});

test("a replayed clientRequestId returns the committed arrival receipt and never navigates twice", async () => {
  upsertPresence(openView());
  const browser = browserStandIn("device-desktop");
  const tools = service();
  try {
    const first = await tools.callTool("request_attention", ask()) as HandoffResult;
    const again = await tools.callTool("request_attention", ask()) as HandoffResult;

    expect(first.ok).toBe(true);
    expect(again.replayed).toBe(true);
    expect(again.attentionId).toBe(first.attentionId!);
    expect(again.handoff).toEqual(first.handoff!);
    /* One record and one landing: the retry re-read a receipt, it did not move
       the operator's view a second time. */
    expect(readAttentionFile().requests).toHaveLength(1);
    expect(browser.arrivals).toEqual([first.attentionId!]);
  } finally {
    browser.stop();
  }
});

test("a worker caller is treated exactly as today: attributed, never refused", async () => {
  upsertPresence(openView());
  const browser = browserStandIn("device-desktop");
  try {
    const result = await service({
      attentionAuthority: () => ({ kind: "worker", conversationId: "conversation_reviewer", role: "reviewer" }),
    }).callTool("request_attention", ask()) as HandoffResult;

    expect(result.ok).toBe(true);
    expect(readAttentionFile().requests[0]!.raisedBy)
      .toEqual({ kind: "agent", conversationId: "conversation_reviewer", role: "reviewer" });
  } finally {
    browser.stop();
  }
});
