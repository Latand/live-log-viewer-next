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
 * appears, or held forever so the test can kill this process once the
 * acceptance marker is written. The handler itself always runs to completion
 * first — the response is what gets lost, never the effect.
 */
interface HttpHostConfig {
  portFile: string;
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
  mode?: "respond" | "hold" | "lose" | "hold-before";
  /** What the send fixture does once the reservation exists. */
  sendEffect?: "deliver" | "queue";
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
      if (reservation.state === "assigned") {
        registry.beginDeliveryAttempt(reservation.id, config.recipientGenerationId);
        /* THE recipient effect: the controlled recipient takes the message
           exactly here, once per actuation, whatever the HTTP layer answers. */
        effect({ kind: "recipient", clientMessageId, operationId, text: request.text });
        if ((control().sendEffect ?? "deliver") === "deliver") {
          registry.recordDeliveryOutcome(reservation.id, "delivered", null, "delivered");
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
      return spawnResponseForReceipt(input.receipt as never, transcriptPath, { structured: true });
    },
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
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
      const answer = new Response(answerBody, { status: response.status, headers: { "content-type": "application/json" } });
      if (current.mode === "hold" || current.mode === "lose") {
        marker("accepted");
        if (current.mode === "lose") return new Promise<Response>(() => {});
        await awaitFile(path.join(config.markerDir, "release"));
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
