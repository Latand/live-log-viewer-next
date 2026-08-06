import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { targetedConversationAtPath, viewerMcpBindings, type TargetedConversationDependencies } from "./bindings";

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
function dependencies(options: { scans?: number; projections?: number; completedTranscript?: boolean } = {}) {
  const allowedScans = options.scans ?? 1;
  const allowedProjections = options.projections ?? 1;
  const counts = { scans: 0, projections: 0, rawScans: 0, targetedReads: 0, observations: 0, scanCalls: 0, projectionCalls: 0 };
  const completedTranscript = options.completedTranscript ?? true;
  const snapshot = {
    files: Array.from({ length: SCAN_ROWS }, (_value, index) => completedTranscript || index > 0
      ? scanRow(index)
      : { ...scanRow(index), path: "/sessions/completed-generation-other.jsonl" }),
    projectCatalog: [],
    complete: true,
  };
  const targetedCalls: Array<{ pathname: string; signal: AbortSignal | undefined; deadlineAt: number | undefined }> = [];
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
      targetedFileEntry: async (pathname: string, options: { signal?: AbortSignal; deadlineAt?: number } = {}) => {
        counts.targetedReads += 1;
        targetedCalls.push({ pathname, signal: options.signal, deadlineAt: options.deadlineAt });
        return pathname === transcriptPath ? scanRow(0) : undefined;
      },
      /* Stands in for transcript-only composition: the completed generation is
         consumed while the injected registry projection remains lazy. */
      collectSnapshot: async (_body: unknown, deps: {
        completedFileScan?: () => Promise<{ snapshot: typeof snapshot }>;
        registrySnapshot?: () => unknown;
      } = {}) => {
        counts.observations += 1;
        if (!deps.completedFileScan) throw new Error("snapshot received no completed scan seam");
        await deps.completedFileScan();
        return { schemaVersion: 1, sessions: [], caller: null };
      },
      boardFor: () => null,
    } as never,
    targetedCalls,
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

test("get_conversation hydrates one known transcript after a completed miss and propagates its bound", async () => {
  const { counts, injected, targetedCalls } = dependencies({ completedTranscript: false });
  const bindings = viewerMcpBindings(undefined, undefined, injected);
  const controller = new AbortController();
  const deadlineAt = Date.now() + 1_000;

  const result = await bindings.get_conversation(
    { clientRequestId: "get-targeted", transcriptPath },
    { signal: controller.signal, deadlineAt },
  ) as { transcriptPath: string };

  expect(result.transcriptPath).toBe(transcriptPath);
  expect(counts.scans).toBe(1);
  expect(counts.targetedReads).toBe(1);
  expect(counts.rawScans).toBe(0);
  expect(targetedCalls).toEqual([{ pathname: transcriptPath, signal: controller.signal, deadlineAt }]);
});

test("get_conversation cancels a targeted miss when its caller leaves", async () => {
  const { counts, injected } = dependencies({ completedTranscript: false });
  let started!: () => void;
  const targetedStarted = new Promise<void>((resolve) => { started = resolve; });
  let targetedSignal: AbortSignal | undefined;
  const domain = injected as unknown as {
    targetedFileEntry(pathname: string, options?: { signal?: AbortSignal; deadlineAt?: number }): Promise<ReturnType<typeof scanRow> | undefined>;
  };
  domain.targetedFileEntry = async (_pathname, options = {}) => new Promise((_resolve, reject) => {
    targetedSignal = options.signal;
    started();
    options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
  });
  const bindings = viewerMcpBindings(undefined, undefined, injected);
  const controller = new AbortController();
  const call = bindings.get_conversation(
    { clientRequestId: "get-cancelled", transcriptPath },
    { signal: controller.signal, deadlineAt: Date.now() + 1_000 },
  );
  const startState = await Promise.race([
    targetedStarted.then(() => "targeted" as const),
    call.then(() => "resolved" as const, () => "rejected" as const),
    Bun.sleep(250).then(() => "timed-out" as const),
  ]);
  expect(startState).toBe("targeted");
  controller.abort(new DOMException("caller left", "AbortError"));

  await expect(call).rejects.toMatchObject({ name: "AbortError" });
  expect(targetedSignal?.aborted).toBeTrue();
  expect(counts.targetedReads).toBe(0);
  expect(counts.rawScans).toBe(0);
});

test("get_conversation deadlines a targeted miss without orphan work", async () => {
  const { counts, injected } = dependencies({ completedTranscript: false });
  let targetedSignal: AbortSignal | undefined;
  const domain = injected as unknown as {
    targetedFileEntry(pathname: string, options?: { signal?: AbortSignal; deadlineAt?: number }): Promise<ReturnType<typeof scanRow> | undefined>;
  };
  domain.targetedFileEntry = async (_pathname, options = {}) => new Promise((_resolve, reject) => {
    targetedSignal = options.signal;
    options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
  });
  const bindings = viewerMcpBindings(undefined, undefined, injected);

  const call = bindings.get_conversation(
    { clientRequestId: "get-deadline", transcriptPath },
    { deadlineAt: Date.now() + 20 },
  );

  await expect(call).rejects.toMatchObject({ name: "DeadlineExceededError" });
  expect(targetedSignal?.aborted).toBeTrue();
  expect(counts.rawScans).toBe(0);
});

test("get_conversation returns hydrated records when the deadline lands after the partial exists", async () => {
  const { injected } = dependencies({ completedTranscript: false });
  const domain = injected as unknown as {
    targetedFileEntry(pathname: string): Promise<{
      entry: ReturnType<typeof scanRow>;
      session: {
        path: string;
        engine: "codex";
        messages: Array<{ kind: "message"; role: "assistant"; ts: null; text: string }>;
        reasoning: [];
        tools: [];
        traces: [];
      };
    }>;
  };
  domain.targetedFileEntry = async () => {
    await Bun.sleep(20);
    return {
      entry: scanRow(0),
      session: {
        path: transcriptPath,
        engine: "codex",
        messages: [{ kind: "message", role: "assistant", ts: null, text: "partial answer" }],
        reasoning: [],
        tools: [],
        traces: [],
      },
    };
  };
  const bindings = viewerMcpBindings(undefined, undefined, injected);

  const result = await bindings.get_conversation(
    { clientRequestId: "get-deadline-partial", transcriptPath, maxRecords: 8 },
    { deadlineAt: Date.now() + 5 },
  ) as { messages: Array<{ text: string }>; truncated: boolean; hint: string };

  expect(result.messages).toEqual([{ kind: "message", role: "assistant", ts: null, text: "partial answer" }]);
  expect(result.truncated).toBe(true);
  expect(result.hint).toContain("internal read deadline");
});

test("get_conversation returns a bounded partial from a synthetic 100 MiB transcript", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-large-conversation-"));
  sandboxes.push(directory);
  const root = path.join(directory, "sessions");
  fs.mkdirSync(root);
  const pathname = path.join(root, "rollout-large.jsonl");
  fs.writeFileSync(pathname, "");
  fs.truncateSync(pathname, 100 * 1024 * 1024);
  fs.appendFileSync(pathname, `\n${[
    JSON.stringify({ type: "session_meta", payload: { id: "large-fixture", timestamp: "2026-07-01T09:00:00.000Z", cwd: "/repo/fixture" } }),
    ...Array.from({ length: 12 }, (_value, index) => JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `partial-${index}` }] },
    })),
  ].join("\n")}\n`);
  const pathAllowed = (candidate: string) => {
    try { return fs.realpathSync(candidate).startsWith(fs.realpathSync(root) + path.sep); } catch { return false; }
  };
  const injected = {
    completedFileScan: ({ signal }: { signal?: AbortSignal } = {}) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    targetedFileEntry: (candidate: string, context: { signal?: AbortSignal; deadlineAt?: number } = {}) => targetedConversationAtPath(
      candidate,
      context,
      { roots: [["codex-sessions", root]], pathAllowed },
    ),
    listFiles: async () => { throw new Error("large reads must stay off the corpus scan path"); },
  } as never;
  const bindings = viewerMcpBindings(undefined, undefined, injected);
  const startedAt = performance.now();

  const result = await bindings.get_conversation(
    { clientRequestId: "get-large-partial", transcriptPath: pathname, maxRecords: 8 },
    { deadlineAt: Date.now() + 2_000 },
  ) as { messages: Array<{ text: string }>; truncated: boolean; hint: string };

  expect(performance.now() - startedAt).toBeLessThan(2_000);
  expect(result.messages.map((message) => message.text)).toEqual(Array.from({ length: 8 }, (_value, index) => `partial-${index + 4}`));
  expect(result.truncated).toBe(true);
  expect(result.hint).toContain("oversized transcript");
});

test("targeted conversation opens one canonical regular transcript and retains its title", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-targeted-open-"));
  sandboxes.push(directory);
  const root = path.join(directory, "sessions");
  fs.mkdirSync(root);
  const pathname = path.join(root, "rollout.jsonl");
  fs.writeFileSync(pathname, [
    JSON.stringify({ type: "session_meta", payload: { id: "fixture", timestamp: "2026-07-01T09:00:00.000Z", cwd: "/repo/fixture" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "canonical title" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "bounded answer" }] } }),
  ].join("\n") + "\n");

  const targeted = await targetedConversationAtPath(pathname, {}, {
    roots: [["codex-sessions", root]],
    pathAllowed: (candidate) => fs.realpathSync(candidate).startsWith(fs.realpathSync(root) + path.sep),
  });

  expect(targeted?.entry).toMatchObject({ path: pathname, title: "canonical title", engine: "codex" });
  expect(targeted?.session.messages.at(-1)?.text).toBe("bounded answer");
});

test("targeted conversation retains a safely opened Claude subagent sidecar title", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-targeted-sidecar-"));
  sandboxes.push(directory);
  const root = path.join(directory, "projects");
  const project = path.join(root, "-repo-fixture");
  fs.mkdirSync(project, { recursive: true });
  const pathname = path.join(project, "agent-fixture.jsonl");
  fs.writeFileSync(pathname, `${JSON.stringify({ type: "user", cwd: "/repo/fixture", message: { content: "fallback title" } })}\n`);
  fs.writeFileSync(pathname.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ description: "sidecar title" }));
  const pathAllowed = (candidate: string) => {
    try { return fs.realpathSync(candidate).startsWith(fs.realpathSync(root) + path.sep); } catch { return false; }
  };

  const targeted = await targetedConversationAtPath(pathname, {}, {
    roots: [["claude-projects", root]],
    pathAllowed,
  });

  expect(targeted?.entry).toMatchObject({ title: "sidecar title", engine: "claude", kind: "subagent" });
});

test("targeted conversation rejects external symlinks and a path swapped after safe open", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-targeted-race-"));
  sandboxes.push(directory);
  const root = path.join(directory, "sessions");
  const external = path.join(directory, "external");
  fs.mkdirSync(root);
  fs.mkdirSync(external);
  const externalPath = path.join(external, "outside.jsonl");
  const externalBody = `${JSON.stringify({ type: "session_meta", payload: { cwd: "/outside" } })}\n`;
  fs.writeFileSync(externalPath, externalBody);
  const symlinkPath = path.join(root, "external-link.jsonl");
  fs.symlinkSync(externalPath, symlinkPath);
  const pathAllowed = (candidate: string) => {
    try { return fs.realpathSync(candidate).startsWith(fs.realpathSync(root) + path.sep); } catch { return false; }
  };

  const targetedDependencies: TargetedConversationDependencies = {
    roots: [["codex-sessions", root]],
    pathAllowed,
  };
  expect(await targetedConversationAtPath(symlinkPath, {}, targetedDependencies)).toBeUndefined();
  const { injected } = dependencies({ completedTranscript: false });
  const domain = injected as unknown as {
    targetedFileEntry(pathname: string, options?: { signal?: AbortSignal; deadlineAt?: number }): ReturnType<typeof targetedConversationAtPath>;
  };
  domain.targetedFileEntry = (candidate, options = {}) => targetedConversationAtPath(candidate, options, targetedDependencies);
  await expect(viewerMcpBindings(undefined, undefined, injected).get_conversation({
    clientRequestId: "external-symlink",
    transcriptPath: symlinkPath,
  })).rejects.toThrow("conversation not found");

  const swappedPath = path.join(root, "swapped.jsonl");
  fs.writeFileSync(swappedPath, `${JSON.stringify({ type: "session_meta", payload: { cwd: "/inside" } })}\n`);
  expect(await targetedConversationAtPath(swappedPath, {}, {
    roots: [["codex-sessions", root]],
    pathAllowed,
    afterOpen: () => {
      fs.unlinkSync(swappedPath);
      fs.symlinkSync(externalPath, swappedPath);
    },
  })).toBeUndefined();
});

test("board_snapshot still consumes one scan and one projection", async () => {
  const { counts, injected } = dependencies();
  const bindings = viewerMcpBindings(undefined, undefined, injected);

  await bindings.board_snapshot({ clientRequestId: "board-1", limit: 100 });

  expect(counts.scans).toBe(1);
  expect(counts.projections).toBe(1);
  expect(counts.rawScans).toBe(0);
});

test("operator_snapshot keeps the transcript-only registry projection lazy", async () => {
  const { counts, injected } = dependencies();
  const bindings = viewerMcpBindings(undefined, undefined, injected);

  await bindings.operator_snapshot({ clientRequestId: "snapshot-1", caller: { transcriptPath } });

  expect(counts.observations).toBe(1);
  expect(counts.scans).toBe(1);
  expect(counts.projections).toBe(0);
  expect(counts.projectionCalls).toBe(0);
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
