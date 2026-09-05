import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  MCP_TOOL_NAMES,
  SqliteMcpReceiptStore,
  createMcpToolService,
  type McpToolBindings,
} from "./server";

function waitFor(filename: string): void {
  while (!fs.existsSync(filename)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

/** The same barrier without blocking the listener's event loop, so a held
    response never stops the next request from being served. */
async function awaitFile(filename: string): Promise<void> {
  while (!fs.existsSync(filename)) await Bun.sleep(5);
}

/**
 * ── ROLE: controlled Viewer (#1490) ───────────────────────────────────────
 *
 * A real HTTP listener in front of the PRODUCTION handlers — `/api/tmux` is
 * `conversationHostPOST` and `/api/spawn` is `POST.withDependencies` — with
 * the runtime behind them replaced at the existing injection seams by
 * fixtures that write into the isolated registry this process shares with the
 * MCP process under test. Every effect the fixtures produce is appended to an
 * effects log, one line per actual recipient delivery or writer launch, so the
 * assertion "one delivery" counts what the recipient received rather than
 * what the HTTP layer answered.
 *
 * A control file, re-read on every request, decides how the RESPONSE behaves
 * after the handler has run: answered normally, held until a release file
 * appears, cut after its headers, or held forever so the test can kill this
 * process once the acceptance marker is written.
 *
 * Admission and execution are two separate barriers. With `admission:
 * "hold-effect"` the fixtures write the `admitted` marker the moment the
 * durable record exists (the reservation for a send, the launch receipt for a
 * spawn) and produce their effect only once the `execute` file appears — so a
 * test can lose the response BETWEEN the server admitting the request and the
 * recipient or writer doing anything, and then count exactly one effect.
 */
interface HttpHostConfig {
  portFile: string;
  /** The stable port every generation of this host listens on, as the
      production Viewer does, so an MCP process outlives a host restart. */
  port?: number;
  effectsPath: string;
  /** Every answer the production handlers produced, whether or not it was
      delivered — the fixture's own record of what the HTTP layer said. */
  responsesPath: string;
  controlPath: string;
  markerDir: string;
  recipientGenerationId: string;
  transcriptRoot: string;
}

interface HttpHostControl {
  /** `respond`: answer normally. `hold`: run the handler, write the accepted
      marker, then wait for the release file before answering. `lose`: run the
      handler, write the accepted marker, never answer. `hold-before`: write the
      reached marker BEFORE the handler runs and wait for the release file. */
  mode?: "respond" | "hold" | "lose" | "hold-before" | "cut";
  /** What the send fixture does once the reservation exists. */
  sendEffect?: "deliver" | "queue";
  /** `hold-effect`: write the `admitted` marker as soon as the durable record
      exists and defer the effect until the `execute` file appears. */
  admission?: "immediate" | "hold-effect";
  /** With `hold`: once released, answer with this status and the server's
      ambiguity verdict — the ids the handler actually admitted, `resend:
      verify-first`, `actuation: started` — instead of the handler's own
      answer. The delayed error that would regress a recovered success. */
  lateVerdict?: { status: number };
  /** Replace an actual handler answer after its effects with a proxy error. */
  lostStatus?: number;
  lostJson?: boolean;
  /** Lose the held response after a concurrent recovery has completed. */
  lateUnreadableStatus?: number;
  settleWriter?: boolean;
  /** Replace the admitted handler's response with incomplete or contradictory JSON. */
  replacedAnswer?: Record<string, unknown>;
}

async function runHttpHost(configPath: string): Promise<void> {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as HttpHostConfig;
  const { NextRequest } = await import("next/server");
  const { conversationHostPOST } = await import("@/app/api/conversation-host/handlers");
  const { setConversationHostDependenciesForTests } = await import("@/app/api/conversation-host/dependencies");
  const { POST } = await import("@/app/api/spawn/route");
  const { agentRegistry } = await import("@/lib/agent/registry");
  const { runtimeReceiptForSend, sendReceiptFor } = await import("@/lib/runtime/sendSettlement");
  const { spawnResponseForReceipt } = await import("@/lib/agent/spawnResponse");

  const control = (): HttpHostControl => {
    try {
      return JSON.parse(fs.readFileSync(config.controlPath, "utf8")) as HttpHostControl;
    } catch {
      return {};
    }
  };
  const effect = (record: Record<string, unknown>): void => {
    fs.appendFileSync(config.effectsPath, `${JSON.stringify(record)}\n`);
  };
  const marker = (name: string): void => {
    fs.writeFileSync(path.join(config.markerDir, name), String(Date.now()));
  };
  /* The execution barrier: an admitted request's effect waits here until the
     test releases execution. Runs off the request path so a held effect never
     blocks the response or the next request. */
  const executionBarrier = async (): Promise<void> => {
    marker("admitted");
    await awaitFile(path.join(config.markerDir, "execute"));
  };

  setConversationHostDependenciesForTests({
    completedFileScan: async () => ({ snapshot: { files: [] } }) as never,
    readTranscriptHosts: async () => ({}) as never,
    recordDirectOperatorWakatimeActivity: () => null,
    enqueueStructuredMessage: async (request) => {
      const registry = agentRegistry();
      const clientMessageId = request.clientMessageId?.trim() || `queue_${crypto.randomUUID()}`;
      const conversationId = (request.conversationId?.startsWith("conversation_")
        ? request.conversationId
        : registry.conversationForPath(request.path)?.id) as `conversation_${string}` | undefined;
      if (!conversationId) {
        return { ok: false, structured: true, outcome: "failed", error: "recipient conversation is unknown", status: 404 };
      }
      const operationId = `op_${crypto.createHash("sha256").update(clientMessageId).digest("hex").slice(0, 16)}`;
      const reservation = registry.holdDelivery(
        conversationId,
        request.text,
        clientMessageId,
        "text",
        [],
        null,
        { operationId, kind: "send", policy: "queue" },
      );
      const actuate = (): void => {
        registry.beginDeliveryAttempt(reservation.id, config.recipientGenerationId);
        /* THE recipient effect: the controlled recipient takes the message
           exactly here, once per actuation, whatever the HTTP layer answers. */
        effect({ kind: "recipient", clientMessageId, operationId, text: request.text });
        if ((control().sendEffect ?? "deliver") === "deliver") {
          registry.recordDeliveryOutcome(reservation.id, "delivered", null, "delivered");
        }
      };
      if (reservation.state === "assigned") {
        if (control().admission === "hold-effect") {
          /* Admitted and answered as queued; the recipient takes it only once
             execution is released, like a drain the runtime runs later. */
          void executionBarrier().then(actuate);
        } else {
          actuate();
        }
      }
      const receipt = sendReceiptFor(registry.readOnlySnapshot(), operationId);
      if (!receipt) return { ok: false, structured: true, outcome: "failed", error: "reservation vanished", status: 500 };
      return {
        ok: true,
        structured: true,
        target: null,
        outcome: receipt.state === "delivered" ? "delivered" : "queued",
        operationId,
        receipt: runtimeReceiptForSend(receipt),
      };
    },
  });

  const account = {
    engine: "codex" as const,
    accountId: "fixture-spawn-account",
    kind: "managed" as const,
    home: path.join(config.transcriptRoot, "home"),
    transcriptRoot: config.transcriptRoot,
    env: {},
  };
  const spawnDependencies = {
    registry: agentRegistry,
    resolveHealthySpawnAccount: async () => account,
    resolveSpawnAccount: () => account,
    runtimeHostClient: () => ({ fixture: true }) as never,
    assertStructuredRuntime: () => {},
    defer: (work: () => Promise<void>) => { void work(); },
    storeImages: () => [],
    spawnStructuredConversation: async (input: { receipt: { launchId: string; conversationId: string; clientAttemptId: string | null }; prompt: string }) => {
      /* The launch receipt already exists when the route hands the launch
         here: that is the admission. The writer runs only once execution is
         released. */
      if (control().admission === "hold-effect") await executionBarrier();
      /* THE writer effect: the controlled writer creates the conversation's
         transcript exactly here, once per launch it is handed. */
      const transcriptPath = path.join(config.transcriptRoot, `${input.receipt.launchId}.jsonl`);
      fs.mkdirSync(config.transcriptRoot, { recursive: true });
      fs.writeFileSync(transcriptPath, `${JSON.stringify({ prompt: input.prompt })}\n`);
      effect({
        kind: "writer",
        launchId: input.receipt.launchId,
        conversationId: input.receipt.conversationId,
        clientAttemptId: input.receipt.clientAttemptId,
      });
      if (control().settleWriter) {
        agentRegistry().completeSpawn(input.receipt.launchId, {
          key: { engine: "codex", sessionId: input.receipt.launchId },
          artifactPath: transcriptPath, cwd: config.transcriptRoot, accountId: null,
          status: "idle", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
        });
      }
      return spawnResponseForReceipt(input.receipt as never, transcriptPath, { structured: true });
    },
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: config.port ?? 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const current = control();
      if (current.mode === "hold-before") {
        marker("reached");
        await awaitFile(path.join(config.markerDir, "release"));
      }
      const body = await request.text();
      const next = new NextRequest(request.url, { method: request.method, headers: request.headers, body });
      let response: Response;
      if (url.pathname === "/api/tmux") response = await conversationHostPOST(next);
      else if (url.pathname === "/api/spawn") response = await POST.withDependencies(next, spawnDependencies as never);
      else return new Response(JSON.stringify({ error: "unrouted" }), { status: 404, headers: { "content-type": "application/json" } });
      const answerBody = await response.text();
      fs.appendFileSync(config.responsesPath, `${JSON.stringify({ pathname: url.pathname, status: response.status, body: answerBody })}\n`);
      if (current.replacedAnswer) {
        marker("accepted");
        return Response.json(current.replacedAnswer);
      }
      if (current.lostStatus) {
        marker("accepted");
        return new Response(current.lostJson ? JSON.stringify({ error: "upstream response lost" }) : "<html>upstream response lost</html>", {
          status: current.lostStatus,
          headers: { "content-type": current.lostJson ? "application/json" : "text/html" },
        });
      }
      const answer = new Response(answerBody, { status: response.status, headers: { "content-type": "application/json" } });
      if (current.mode === "hold" || current.mode === "lose") {
        marker("accepted");
        if (current.mode === "lose") return new Promise<Response>(() => {});
        await awaitFile(path.join(config.markerDir, "release"));
        if (current.lateUnreadableStatus) return new Response("response lost", { status: current.lateUnreadableStatus });
        if (current.lateVerdict) {
          let admitted: Record<string, unknown> = {};
          try {
            admitted = JSON.parse(answerBody) as Record<string, unknown>;
          } catch { /* the verdict then names no id, as a lost body would */ }
          const verdict = {
            error: "delivery was started and never settled",
            ...(typeof admitted.operationId === "string" ? { operationId: admitted.operationId } : {}),
            ...(typeof admitted.launchId === "string" ? { launchId: admitted.launchId } : {}),
            ...(typeof admitted.conversationId === "string" ? { conversationId: admitted.conversationId } : {}),
            resend: "verify-first",
            actuation: "started",
          };
          return new Response(JSON.stringify(verdict), { status: current.lateVerdict.status, headers: { "content-type": "application/json" } });
        }
      }
      if (current.mode === "cut") {
        /* The response is lost after its status line: the body errors before
           a byte of it is readable, so the caller learns nothing from it. */
        marker("accepted");
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.error(new Error("response cut by the fixture")); },
        }), { status: response.status, headers: { "content-type": "application/json" } });
      }
      return answer;
    },
  });
  fs.writeFileSync(config.portFile, String(server.port));
  await new Promise<never>(() => {});
}

if (process.argv[2] === "http-host") {
  await runHttpHost(process.argv[3]!);
} else {
  const filename = process.argv[2]!;
  const readyPath = process.argv[3]!;
  const startPath = process.argv[4]!;
  const ownerReadyPath = process.argv[5]!;
  const ownerReleasePath = process.argv[6]!;
  const ownerCountPath = process.argv[7]!;
  const resultPath = process.argv[8]!;
  const index = Number(process.argv[9]!);

  const store = new SqliteMcpReceiptStore(filename);
  let peakRssBytes = process.memoryUsage().rss;
  fs.writeFileSync(readyPath, JSON.stringify({ index, steadyRssBytes: peakRssBytes }));
  waitFor(startPath);

  const bindings = Object.fromEntries(MCP_TOOL_NAMES.map((toolName) => [toolName, async () => ({})])) as unknown as McpToolBindings;
  bindings.list_tasks = async () => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    fs.appendFileSync(ownerCountPath, `${index}\n`);
    fs.writeFileSync(ownerReadyPath, String(index), { flag: "wx" });
    waitFor(ownerReleasePath);
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    return { ownerIndex: index, count: 1 };
  };

  const startedAt = performance.now();
  const result = await createMcpToolService(bindings, store).callTool("list_tasks", {
    clientRequestId: "twenty-process-owner",
    limit: 1,
  });
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  store.close();
  fs.writeFileSync(resultPath, JSON.stringify({
    index,
    durationMs: performance.now() - startedAt,
    peakRssBytes,
    result,
  }));
}
