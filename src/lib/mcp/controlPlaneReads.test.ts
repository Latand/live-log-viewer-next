import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { viewerMcpBindings } from "./bindings";

/**
 * The control-plane reads consume ONE completed scan and ONE projection (#845).
 *
 * These reads answer "what is running" and "what did that conversation say". They
 * are not allowed to be the reason the machine rebuilds its world: `list_conversations`
 * forced `fresh: true` — a full corpus walk — per call, `get_conversation` forced a
 * full PINNED walk in its own exclusive scan generation per call, and `send_message`
 * reached past its injected projection to the registry.
 *
 * Every dependency here is poisoned after the number of reads the contract allows, so
 * a regression fails as a thrown "second read" rather than as a slow test. The
 * projection is production-shaped — roughly 4.7k conversations over 18.5k registry
 * rows, against a 373-row completed scan — so "bounded" is measured against the size
 * that made this urgent rather than against a fixture that would be fast either way.
 */

const CONVERSATIONS = 4_700;
const REGISTRY_ROWS = 18_500;
const SCAN_ROWS = 373;
const CONCURRENCY = 20;

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;
let transcriptPath = "";

beforeEach(() => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-control-reads-"));
  sandboxes.push(sandbox);
  process.env.LLV_STATE_DIR = path.join(sandbox, "state");
  transcriptPath = path.join(sandbox, "rollout-2026-07-01T09-00-00-sess0001.jsonl");
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({ type: "session_meta", payload: { id: "sess-1", timestamp: "2026-07-01T09:00:00.000Z", cwd: "/repo/project-0" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "status?" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "green" }] } }),
  ].join("\n") + "\n");
});

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function scanRow(index: number) {
  return {
    path: index === 0 ? transcriptPath : `/sessions/worker-${index}.jsonl`,
    root: "codex-sessions",
    name: `worker-${index}.jsonl`,
    project: `project-${index % 41}`,
    title: `worker ${index}`,
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1_780_000_000 + index,
    size: 2_048,
    activity: index % 7 === 0 ? "live" : "idle",
    proc: null,
    pid: null,
    model: "gpt-5.6-sol",
    pendingQuestion: null,
    waitingInput: null,
    conversationId: `conversation_${index}`,
  };
}

/** A registry projection at the shape that made this urgent. */
function projection() {
  const conversations: Record<string, unknown> = {};
  for (let index = 0; index < CONVERSATIONS; index += 1) {
    conversations[`conversation_${index}`] = {
      id: `conversation_${index}`,
      generations: [{ path: index === 0 ? transcriptPath : `/sessions/worker-${index}.jsonl` }],
      continuityPaths: [],
      agentRole: null,
      delegationDepth: 0,
    };
  }
  const entries: Record<string, unknown> = {};
  for (let index = 0; index < REGISTRY_ROWS; index += 1) {
    entries[`codex:sess-${index}`] = { artifactPath: `/sessions/worker-${index}.jsonl`, host: null, structuredHost: null };
  }
  /* A migration chains redirects rather than rewriting them, so the walk that
     resolves them has to follow more than one hop. */
  const conversationAliases = {
    conversation_retired: "conversation_middle",
    conversation_middle: "conversation_0",
  };
  return { conversations, entries, lineageEdges: {}, memberships: {}, conversationAliases };
}

/**
 * Counting, poisoned dependencies.
 *
 * The two seams are modelled the way the real ones behave, because otherwise the
 * assertion would be about the fake: `completedFileScan` is single-flight (concurrent
 * callers join one generation) and `registrySnapshot` is materialised once and served
 * from a process-local cache until the file changes. What is counted, and poisoned, is
 * therefore the number of GENERATIONS and MATERIALISATIONS — the expensive events —
 * rather than the number of times a read asked.
 */
function dependencies(options: { scans?: number; projections?: number } = {}) {
  const allowedScans = options.scans ?? 1;
  const allowedProjections = options.projections ?? 1;
  const counts = { scans: 0, projections: 0, rawScans: 0, observations: 0, scanCalls: 0, projectionCalls: 0 };
  const snapshot = { files: Array.from({ length: SCAN_ROWS }, (_value, index) => scanRow(index)), projectCatalog: [], complete: true };
  let inflight: Promise<{ snapshot: typeof snapshot }> | null = null;
  let materialised: ReturnType<typeof projection> | null = null;
  return {
    counts,
    injected: {
      completedFileScan: () => {
        counts.scanCalls += 1;
        if (inflight) return inflight;
        counts.scans += 1;
        if (counts.scans > allowedScans) throw new Error(`a second completed scan generation was started (${counts.scans})`);
        inflight = Promise.resolve({ snapshot });
        /* Released a turn later, so genuinely concurrent callers join and a LATER
           read still gets a fresh generation — exactly the real cache's shape. */
        void inflight.then(() => { queueMicrotask(() => { inflight = null; }); });
        return inflight;
      },
      registrySnapshot: () => {
        counts.projectionCalls += 1;
        if (materialised) return materialised;
        counts.projections += 1;
        if (counts.projections > allowedProjections) throw new Error(`a second registry projection was materialised (${counts.projections})`);
        materialised = projection();
        return materialised;
      },
      listFiles: async () => {
        counts.rawScans += 1;
        throw new Error("a control-plane read must not start a raw corpus scan");
      },
      /* Stands in for composition while exercising the same injected completed
         generation and registry projection as the production collector. */
      collectSnapshot: async (_body: unknown, deps: {
        completedFileScan?: () => Promise<{ snapshot: typeof snapshot }>;
        registrySnapshot?: () => unknown;
      } = {}) => {
        counts.observations += 1;
        if (!deps.completedFileScan) throw new Error("snapshot received no completed scan seam");
        await deps.completedFileScan();
        deps.registrySnapshot?.();
        return { schemaVersion: 1, sessions: [], caller: null };
      },
      boardFor: () => null,
    } as never,
  };
}

test("list_conversations reads the completed generation and starts no raw scan", async () => {
  const { counts, injected } = dependencies();
  const bindings = viewerMcpBindings(undefined, undefined, injected);

  const result = await bindings.list_conversations({ clientRequestId: "list-1", limit: 50 }) as { count: number };

  expect(result.count).toBe(50);
  expect(counts.scans).toBe(1);
  expect(counts.rawScans).toBe(0);
});

test("get_conversation reads the completed generation when it already carries the transcript", async () => {
  const { counts, injected } = dependencies();
  const bindings = viewerMcpBindings(undefined, undefined, injected);

  const result = await bindings.get_conversation({ clientRequestId: "get-1", transcriptPath }) as { transcriptPath: string };

  expect(result.transcriptPath).toBe(transcriptPath);
  /* The pin exists for a transcript the completed generation does not carry. This one
     it does, so the private exclusive scan never runs. */
  expect(counts.rawScans).toBe(0);
  expect(counts.scans).toBe(1);
});

test("board_snapshot still consumes one scan and one projection", async () => {
  const { counts, injected } = dependencies();
  const bindings = viewerMcpBindings(undefined, undefined, injected);

  await bindings.board_snapshot({ clientRequestId: "board-1", limit: 100 });

  expect(counts.scans).toBe(1);
  expect(counts.projections).toBe(1);
  expect(counts.rawScans).toBe(0);
});

test("operator_snapshot hands the collector the projection it already holds", async () => {
  const { counts, injected } = dependencies();
  const bindings = viewerMcpBindings(undefined, undefined, injected);

  await bindings.operator_snapshot({ clientRequestId: "snapshot-1", caller: { transcriptPath } });

  expect(counts.observations).toBe(1);
  expect(counts.scans).toBe(1);
  /* Exactly one, materialised by the caller and consumed by the collector. The
     default path built a second one inside `collectSnapshot`. */
  expect(counts.projections).toBe(1);
});

test("twenty concurrent control reads join one scan and one projection", async () => {
  /* A single-flight completed scan, as the real one is: the assertion is that the
     READS join it rather than each reserving their own generation. */
  const { counts, injected } = dependencies({ scans: 1, projections: 1 });
  const bindings = viewerMcpBindings(undefined, undefined, injected);

  const results = await Promise.all(Array.from({ length: CONCURRENCY }, (_value, index) => {
    const read = index % 3 === 0
      ? bindings.operator_snapshot({ clientRequestId: `snapshot-${index}`, text: { include: false } })
      : index % 3 === 1
        ? bindings.list_conversations({ clientRequestId: `list-${index}`, limit: 10 })
        : bindings.board_snapshot({ clientRequestId: `board-${index}`, limit: 10 });
    return read.catch((error: unknown) => ({ error: String(error) }));
  }));

  const refused = results.filter((entry) => typeof entry === "object" && entry !== null && "error" in entry);
  /* Poisoned after one of each, so any read that did NOT join shows up here. */
  expect(refused).toEqual([]);
  /* Twenty reads asked; one generation and one materialisation answered them all. */
  expect(counts.scanCalls).toBe(CONCURRENCY);
  expect(counts.scans).toBe(1);
  expect(counts.projections).toBe(1);
  expect(counts.rawScans).toBe(0);
});

test("send_message resolves the conversation it named from one injected projection", async () => {
  const { counts, injected } = dependencies();
  const posts: string[] = [];
  const bindings = viewerMcpBindings(undefined, {
    post: async (pathname: string) => {
      posts.push(pathname);
      return { operationId: "operation_1", outcome: "queued" };
    },
  } as never, injected);

  const result = await bindings.send_message({
    clientRequestId: "send-1",
    transcriptPath,
    text: "status check",
  }) as { conversationId: string | null; transcriptPath: string | null };

  expect(posts).toEqual(["/api/tmux"]);
  /* Resolved through the injected projection — including by a path the conversation
     owns — rather than by reaching for the registry a second time. */
  expect(result.conversationId).toBe("conversation_0");
  expect(result.transcriptPath).toBe(transcriptPath);
  expect(counts.projections).toBe(1);
});

test("a send addressed by conversation id follows the alias the projection records", async () => {
  const { counts, injected } = dependencies();
  const bindings = viewerMcpBindings(undefined, {
    post: async () => ({ operationId: "operation_2", outcome: "queued" }),
  } as never, injected);

  const result = await bindings.send_message({
    clientRequestId: "send-2",
    conversationId: "conversation_0",
    text: "status check",
  }) as { conversationId: string | null };

  expect(result.conversationId).toBe("conversation_0");
  expect(counts.projections).toBe(1);
});

test("a send addressed by a CHAINED alias follows the walk to its end", () => {
  /* The registry's alias resolution is multi-hop and cycle-guarded. Resolving one
     hop from an injected projection would answer with a conversation the operator
     has not been in for two moves — a silent wrong answer on a public tool. */
  const { counts, injected } = dependencies();
  const bindings = viewerMcpBindings(undefined, {
    post: async () => ({ operationId: "operation_3", outcome: "queued" }),
  } as never, injected);

  return bindings.send_message({
    clientRequestId: "send-3",
    conversationId: "conversation_retired",
    text: "status check",
  }).then((result) => {
    expect((result as { conversationId: string | null }).conversationId).toBe("conversation_0");
    expect(counts.projections).toBe(1);
  });
});
