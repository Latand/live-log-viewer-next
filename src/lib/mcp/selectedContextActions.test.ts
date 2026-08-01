import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile, type ViewerConversationId } from "@/lib/accounts/migration/contracts";
import type { ConversationLookup, RegistryConversation } from "@/lib/agent/registry";
import { SELECTED_TAIL_MAX_LINES, selectedConversationResolver } from "@/lib/selection/resolve";
import {
  encodeSelectedContextRef,
  SELECTED_CONTEXT_VERSION,
  type SelectedContextRef,
} from "@/lib/selection/selectedContext";

import { viewerMcpBindings } from "./bindings";
import { McpToolRefusal } from "./server";

/**
 * #844 §7 through the MCP surface: a turn's selected-card reference is enough to
 * ACT on that card, and #844 §6's bounded read answers from it while every scan
 * is sick.
 *
 * Everything scan-shaped here is poisoned rather than slow — `listFiles`,
 * `completedFileScan`, `collectSnapshot` and the lookup's `conversationForPath`
 * all throw or hang forever. A regression that reaches for a corpus walk, or for
 * the `operator_snapshot` composition these tools exist to avoid, fails as a
 * thrown "must not" instead of as a timeout nobody reads.
 */

const SELECTED_ID = "conversation_atlas_selected";
const OTHER_ID = "conversation_atlas_other";

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;
let transcriptPath = "";

beforeEach(() => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-selected-mcp-"));
  sandboxes.push(sandbox);
  /* Isolated Viewer state: nothing in this file may touch the shared registry. */
  process.env.LLV_STATE_DIR = path.join(sandbox, "state");
  transcriptPath = path.join(sandbox, "rollout-2026-08-01T09-00-00-sess0001.jsonl");
  fs.writeFileSync(
    transcriptPath,
    Array.from({ length: 30 }, (_value, index) => JSON.stringify({ n: index })).join("\n") + "\n",
  );
});

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function conversation(id: string, artifactPath: string): RegistryConversation {
  return {
    id: id as ViewerConversationId,
    engine: "codex",
    generations: [{
      id: "gen-1",
      path: artifactPath,
      accountId: null,
      launchProfile: emptyLaunchProfile(),
      historyHash: null,
      host: null,
      createdAt: "2026-08-01T08:00:00.000Z",
      archivedAt: null,
    }],
    continuityPaths: [],
    abandonedContinuityPaths: [],
    providerForkPaths: [],
    projectOwnership: { project: "atlas", source: "operator", setAt: "2026-08-01T08:00:00.000Z", operationId: "op-1" },
    migration: null,
    migrationOptOut: null,
    supersededBy: null,
    agentRole: null,
    delegationDepth: null,
    turn: { state: "idle", source: "empty", terminalAt: null, observedAt: null },
    createdAt: "2026-08-01T08:00:00.000Z",
    updatedAt: "2026-08-01T08:00:00.000Z",
  };
}

function selectedRef(overrides: Partial<SelectedContextRef> = {}): SelectedContextRef {
  return {
    version: SELECTED_CONTEXT_VERSION,
    state: "selected",
    conversationId: SELECTED_ID,
    capturedAt: "2026-08-01T09:05:00.000Z",
    project: "atlas",
    viewSessionId: "view-1",
    deviceId: "device-1",
    label: "worker a",
    /* Capture-time provenance. A tool must resolve the CURRENT generation from
       the identity instead of trusting this. */
    path: "/sessions/stale-generation.jsonl",
    ...overrides,
  } as SelectedContextRef;
}

interface Harness {
  injected: never;
  actions: Array<Record<string, unknown>>;
  counts: { identityLookups: number; pathLookups: number };
}

function harness(options: { known?: Record<string, RegistryConversation>; pathAllowed?: boolean } = {}): Harness {
  const known = options.known ?? { [SELECTED_ID]: conversation(SELECTED_ID, transcriptPath) };
  const counts = { identityLookups: 0, pathLookups: 0 };
  const actions: Array<Record<string, unknown>> = [];
  const lookup: ConversationLookup = {
    conversation: (id) => {
      counts.identityLookups += 1;
      return known[id] ?? null;
    },
    canonicalConversationId: (id) => id,
    conversationForPath: () => {
      counts.pathLookups += 1;
      throw new Error("the selected-card path must resolve by identity, never by a path walk");
    },
  };
  return {
    counts,
    actions,
    injected: {
      selectedContext: {
        selectedConversation: () => selectedConversationResolver(lookup),
        pathAllowed: () => options.pathAllowed ?? true,
      },
      applyConversationAction: async (request: Record<string, unknown>) => {
        actions.push(request);
        return { status: 200, body: { ok: true, outcome: "delivered", target: "structured" } };
      },
      listFiles: async () => { throw new Error("the selected-card path must not start a raw corpus scan"); },
      /* Hangs forever, exactly as a degraded scan does. */
      completedFileScan: () => new Promise(() => {}),
      collectSnapshot: async () => { throw new Error("the selected-card path must not compose an operator snapshot"); },
      registrySnapshot: () => { throw new Error("the selected-card path must not materialise a registry projection"); },
    } as never,
  };
}

async function refusal(run: Promise<unknown>): Promise<McpToolRefusal> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(McpToolRefusal);
    return error as McpToolRefusal;
  }
  throw new Error("expected a typed refusal");
}

test("conversation_action acts on the selected card from its reference alone", async () => {
  const { injected, actions, counts } = harness();
  const bindings = viewerMcpBindings(undefined, undefined, injected);

  const result = await bindings.conversation_action({
    clientRequestId: "act-1",
    action: "interrupt",
    selectedContext: encodeSelectedContextRef(selectedRef()),
  }) as { conversationId: string; selectedContext: Record<string, unknown> };

  expect(result.conversationId).toBe(SELECTED_ID);
  expect(actions).toHaveLength(1);
  expect(actions[0]!.conversationId).toBe(SELECTED_ID);
  /* Identity only: the reference's capture-time path never becomes the target. */
  expect(actions[0]!.transcriptPath).toBe("");
  expect(result.selectedContext).toMatchObject({ conversationId: SELECTED_ID, label: "worker a", state: "selected" });
  expect(counts.identityLookups).toBe(1);
  expect(counts.pathLookups).toBe(0);
});

test("the marker token is accepted verbatim, `ctx=` prefix and all", async () => {
  const { injected, actions } = harness();
  const bindings = viewerMcpBindings(undefined, undefined, injected);

  await bindings.conversation_action({
    clientRequestId: "act-2",
    action: "interrupt",
    selectedContext: `ctx=${encodeSelectedContextRef(selectedRef())}`,
  });

  expect(actions[0]!.conversationId).toBe(SELECTED_ID);
});

test("a decoded reference object is accepted as well as its token", async () => {
  const { injected, actions } = harness();
  const bindings = viewerMcpBindings(undefined, undefined, injected);

  await bindings.conversation_action({
    clientRequestId: "act-3",
    action: "interrupt",
    selectedContext: selectedRef(),
  });

  expect(actions[0]!.conversationId).toBe(SELECTED_ID);
});

test("an explicit empty selection refuses distinctly and acts on nothing", async () => {
  const { injected, actions } = harness();
  const bindings = viewerMcpBindings(undefined, undefined, injected);

  const error = await refusal(bindings.conversation_action({
    clientRequestId: "act-4",
    action: "kill",
    selectedContext: encodeSelectedContextRef({
      version: SELECTED_CONTEXT_VERSION,
      state: "none",
      capturedAt: "2026-08-01T09:05:00.000Z",
      deviceId: "device-1",
    }),
  }));

  expect(error.details.code).toBe("selected_context_empty");
  expect(actions).toHaveLength(0);
});

test("a stale reference to a conversation the registry no longer owns refuses distinctly", async () => {
  const { injected, actions } = harness({ known: {} });
  const bindings = viewerMcpBindings(undefined, undefined, injected);

  const error = await refusal(bindings.conversation_action({
    clientRequestId: "act-5",
    action: "interrupt",
    selectedContext: encodeSelectedContextRef(selectedRef()),
  }));

  expect(error.details).toMatchObject({ code: "selected_context_unresolved", conversationId: SELECTED_ID });
  expect(actions).toHaveLength(0);
});

test("a reference that disagrees with an explicit conversationId is never resolved either way", async () => {
  const { injected, actions } = harness();
  const bindings = viewerMcpBindings(undefined, undefined, injected);

  const error = await refusal(bindings.conversation_action({
    clientRequestId: "act-6",
    action: "interrupt",
    conversationId: OTHER_ID,
    selectedContext: encodeSelectedContextRef(selectedRef()),
  }));

  expect(error.details).toMatchObject({
    code: "selected_context_conflict",
    conversationId: OTHER_ID,
    selectedConversationId: SELECTED_ID,
  });
  expect(actions).toHaveLength(0);
});

test("an unreadable reference refuses instead of being treated as no selection", async () => {
  const { injected, actions } = harness();
  const bindings = viewerMcpBindings(undefined, undefined, injected);

  const error = await refusal(bindings.conversation_action({
    clientRequestId: "act-7",
    action: "interrupt",
    selectedContext: "not-a-reference-token",
  }));

  expect(error.details.code).toBe("selected_context_invalid");
  expect(actions).toHaveLength(0);
});

test("an already-cancelled call acts on nothing", async () => {
  const { injected, actions } = harness();
  const bindings = viewerMcpBindings(undefined, undefined, injected);
  const controller = new AbortController();
  controller.abort();

  await expect(bindings.conversation_action({
    clientRequestId: "act-8",
    action: "interrupt",
    selectedContext: encodeSelectedContextRef(selectedRef()),
  }, { signal: controller.signal })).rejects.toThrow();
  expect(actions).toHaveLength(0);
});

test("get_conversation reads a bounded tail of the selected card while every scan is degraded", async () => {
  const { injected, counts } = harness();
  const bindings = viewerMcpBindings(undefined, undefined, injected);

  const result = await bindings.get_conversation({
    clientRequestId: "read-1",
    selectedContext: encodeSelectedContextRef(selectedRef()),
    tailLines: 4,
  }) as {
    conversationId: string;
    transcriptPath: string;
    scanned: boolean;
    tail: { lines: string[]; truncated: boolean };
  };

  expect(result.conversationId).toBe(SELECTED_ID);
  /* The CURRENT generation from the registry, not the path the reference carried. */
  expect(result.transcriptPath).toBe(transcriptPath);
  expect(result.scanned).toBe(false);
  expect(result.tail.lines).toEqual(['{"n":26}', '{"n":27}', '{"n":28}', '{"n":29}']);
  expect(result.tail.truncated).toBe(true);
  expect(counts.pathLookups).toBe(0);
});

test("the tail bound is the server's, however many lines the caller asks for", async () => {
  const { injected } = harness();
  const bindings = viewerMcpBindings(undefined, undefined, injected);

  const result = await bindings.get_conversation({
    clientRequestId: "read-2",
    conversationId: SELECTED_ID,
    tailLines: 100_000,
  }) as { tail: { lines: string[] } };

  expect(result.tail.lines.length).toBeLessThanOrEqual(SELECTED_TAIL_MAX_LINES);
});

test("a bounded tail needs an identity, and says so rather than scanning for one", async () => {
  const { injected } = harness();
  const bindings = viewerMcpBindings(undefined, undefined, injected);

  const error = await refusal(bindings.get_conversation({
    clientRequestId: "read-3",
    transcriptPath,
    tailLines: 4,
  }));

  expect(error.details.code).toBe("selected_tail_requires_identity");
});

test("a transcript outside the scanner roots is never tailed", async () => {
  const { injected } = harness({ pathAllowed: false });
  const bindings = viewerMcpBindings(undefined, undefined, injected);

  const error = await refusal(bindings.get_conversation({
    clientRequestId: "read-4",
    selectedContext: encodeSelectedContextRef(selectedRef()),
    tailLines: 4,
  }));

  expect(error.details).toMatchObject({ code: "selected_conversation_outside_roots", conversationId: SELECTED_ID });
});
