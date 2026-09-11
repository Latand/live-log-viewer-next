/** The composer's delivery and queue routes served by the real handlers over a
 * real runtime host journal, delivering to the installed Codex app-server.
 *
 * Everything below the routes is production: the journal behind a runtime host
 * socket, the structured delivery queue and native queue executor bound by
 * `bindStructuredDeliveryQueue`, the image store and the file inbox. The only
 * synthetic parts are the model provider — a credential-free local Responses
 * server that records what Codex sends it — and Codex's account and model
 * catalog answers, which a credential-free CLI cannot produce. Queue, history,
 * native identities, dispatch and persistence execute in the real CLI.
 * State lives in a private temporary directory; no account is reachable. */
import crypto from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import { NextRequest } from "next/server";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { RuntimeHost } from "@/runtime-host/host";
import { RuntimeJournal } from "@/runtime-host/journal";
import { serveRuntimeHost } from "@/runtime-host/socket";

import { UnixRuntimeHostClient } from "../client";
import { CodexAppServerHost } from "../codexAppServerHost";
import type { RuntimeOperationReceipt } from "../contracts";
import { handleRuntimeCommand, handleRuntimeOperationQuery, handleRuntimeRetry } from "../http";
import { handleNativeQueue } from "../nativeQueueHttp";
import { codexHostColumns } from "../registry";
import { admitRuntimeImagePayload } from "../runtimeImageAdmission";
import { runtimeImageStore } from "../runtimeImageStore";
import { resolveSendReceipt } from "../sendSettlement";
import { bindStructuredDeliveryQueue, structuredDeliveryHostForConversation } from "../structuredDeliveryController";
import { kickStructuredDeliveryQueue } from "../structuredDeliverySignal";
import { enqueueStructuredMessage } from "../structuredMessageDelivery";
import { isolateComposerPayloadRuntime } from "./composerPayloadRuntime";

/** One request Codex made to the model provider, reduced to what it carried. */
export interface ProviderRequest {
  index: number;
  bytes: number;
  /** SHA-256 of every decoded `input_image` in the newest user message. */
  images: string[];
  /** Every `input_text` in the newest user message. */
  texts: string[];
}

export interface NativeCodexRuntime {
  conversationId: string;
  threadId: string;
  accountId: string;
  artifactPath: string;
  registry: AgentRegistry;
  journal: RuntimeJournal;
  host(): CodexAppServerHost;
  /** Every JSON-RPC request the Viewer made to the CLI, by method. */
  rpc: Array<{ method: string; params: Record<string, unknown> }>;
  provider: {
    requests: ProviderRequest[];
    /** Requests whose streamed response is still open, oldest first. */
    open(): number;
    /** Finish the oldest open response as a completed assistant message. */
    completeNext(): boolean;
  };
  handle(request: Request): Promise<Response>;
  receipts(): Promise<RuntimeOperationReceipt[]>;
  close(): Promise<void>;
}

const PROVIDER_ACCOUNT = { account: { type: "chatgpt", planType: "fixture" }, requiresOpenaiAuth: false };
const PROVIDER_MODELS = { data: [{ id: "fixture-model", model: "fixture-model", isDefault: true, inputModalities: ["text", "image"], supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] };

function newestUserContent(body: Record<string, unknown>): { images: string[]; texts: string[] } {
  const input = Array.isArray(body.input) ? body.input as Array<Record<string, unknown>> : [];
  const user = input.filter((item) => item.role === "user" && Array.isArray(item.content)).at(-1);
  const images: string[] = [];
  const texts: string[] = [];
  for (const part of (user?.content ?? []) as Array<Record<string, unknown>>) {
    if (part.type === "input_image" && typeof part.image_url === "string") {
      const comma = part.image_url.indexOf(",");
      images.push(crypto.createHash("sha256").update(Buffer.from(part.image_url.slice(comma + 1), "base64")).digest("hex"));
    }
    if (part.type === "input_text" && typeof part.text === "string") texts.push(part.text);
  }
  return { images, texts };
}

export async function startNativeCodexRuntime(directory: string, binary: string): Promise<NativeCodexRuntime> {
  isolateComposerPayloadRuntime(directory);
  const stateDirectory = process.env.LLV_STATE_DIR!;
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", NODE_ENV: "test" };
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "CODEX_HOME", "TMPDIR"]) {
    env[key] = path.join(directory, "codex-env", key.toLowerCase());
    fs.mkdirSync(env[key]!, { recursive: true, mode: 0o700 });
  }
  const cwd = path.join(directory, "workspace");
  fs.mkdirSync(cwd, { recursive: true });

  const requests: ProviderRequest[] = [];
  const open: ServerResponse[] = [];
  const provider = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>; } catch { /* recorded as empty */ }
      requests.push({ index: requests.length, bytes: raw.length, ...newestUserContent(body) });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: `fixture-response-${requests.length}` } })}\n\n`);
      open.push(response);
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("the local Responses fixture could not bind");
  fs.writeFileSync(path.join(env.CODEX_HOME!, "config.toml"), `model = "fixture-model"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"
[model_providers.fixture]
name = "Credential-free local Responses"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
[analytics]
enabled = false
[features]
apps = false
plugins = false
`);
  let completed = 0;
  const completeNext = (): boolean => {
    const response = open.shift();
    if (!response) return false;
    completed += 1;
    const id = `fixture-answer-${completed}`;
    const output = { id, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fixture answer", annotations: [] }] };
    for (const event of [
      { type: "response.output_item.added", output_index: 0, item: { ...output, status: "in_progress", content: [] } },
      { type: "response.output_item.done", output_index: 0, item: output },
      { type: "response.completed", response: { id, status: "completed", output: [output], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
    return true;
  };

  const rpc: NativeCodexRuntime["rpc"] = [];
  /* Only the account and model catalog answers are synthetic; every other
     message passes between the host and the installed CLI unchanged. */
  const spawnProcess = (_command: string, args: string[]) => {
    const child = spawn(binary, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const input = new PassThrough();
    const output = new PassThrough();
    const methods = new Map<number, string>();
    const inbound = createInterface({ input });
    inbound.on("line", (line) => {
      const message = JSON.parse(line) as { id?: unknown; method?: string; params?: Record<string, unknown> };
      if (typeof message.id === "number" && message.method) methods.set(message.id, message.method);
      if (message.method) rpc.push({ method: message.method, params: message.params ?? {} });
      child.stdin.write(line + "\n");
    });
    input.on("finish", () => child.stdin.end());
    const outbound = createInterface({ input: child.stdout });
    outbound.on("line", (line) => {
      const message = JSON.parse(line) as { id?: number; result?: unknown };
      const method = typeof message.id === "number" ? methods.get(message.id) : undefined;
      if (method === "account/read") message.result = PROVIDER_ACCOUNT;
      if (method === "model/list") message.result = PROVIDER_MODELS;
      output.write(JSON.stringify(message) + "\n");
    });
    child.once("close", () => { inbound.close(); outbound.close(); output.end(); });
    return new Proxy(child, { get(target, property) {
      if (property === "stdin") return input;
      if (property === "stdout") return output;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as ChildProcessWithoutNullStreams;
  };
  const host = await CodexAppServerHost.start({ cwd, binary, codexHome: env.CODEX_HOME, env, model: "fixture-model", spawnProcess });
  const threadId = host.identity.threadId;
  const accountId = "fixture-account";
  const artifactPath = host.identity.path ?? path.join(env.CODEX_HOME!, "sessions", `rollout-fixture-${threadId}.jsonl`);

  const registry = new AgentRegistry(path.join(stateDirectory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  setAgentRegistryForTests(registry);
  const profile = emptyLaunchProfile({ cwd });
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId,
    launchProfile: profile,
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: new Date().toISOString(),
  }]);
  const conversation = registry.conversationForPath(artifactPath);
  if (!conversation) throw new Error("the Codex thread did not register as a conversation");
  const key = { engine: "codex" as const, sessionId: threadId };
  registry.upsert({
    key,
    artifactPath,
    cwd,
    accountId,
    launchProfile: profile,
    status: "idle",
    host: null,
    structuredHost: codexHostColumns(await host.health(), 0),
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });

  const journal = new RuntimeJournal(path.join(stateDirectory, "runtime-events.sqlite"), { structuredHosts: true });
  const socketPath = path.join(directory, "rt.sock");
  const server = serveRuntimeHost(socketPath, new RuntimeHost(journal, undefined, undefined, true));
  await once(server, "listening");
  const client = new UnixRuntimeHostClient(socketPath, 30_000, 30_000, 30_000);
  await bindStructuredDeliveryQueue([{ key, host }], {
    registry,
    client,
    recover: async () => ({ target: null, path: artifactPath, conversationId: conversation.id, spawned: false }),
  });

  const commandDependencies = {
    enabled: () => true,
    structuredEnabled: () => true,
    client: () => client,
    registry: () => registry,
    enqueue: enqueueStructuredMessage,
    retireReplySuggestions: () => ({ cleared: false, pending: false }),
    kick: kickStructuredDeliveryQueue,
  };
  const queueDependencies = {
    client: () => client,
    enabled: () => true,
    kick: kickStructuredDeliveryQueue,
    admitImages: (images: unknown) => admitRuntimeImagePayload({ images }),
    storeImages: (uploads: Parameters<ReturnType<typeof runtimeImageStore>["putMany"]>[0]) => runtimeImageStore().putMany(uploads),
    nativeSnapshot: async (id: string) => {
      const native = structuredDeliveryHostForConversation(id)?.nativeQueue;
      if (!native) return null;
      try { return await native.queue.refresh(); } catch { return native.queue.read(); }
    },
  };
  const retryDependencies = {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    kick: kickStructuredDeliveryQueue,
    recover: async () => ({ target: null, path: artifactPath, conversationId: conversation.id, spawned: false }),
    republish: async () => true,
    recordRetryAttempt: (previous: string, retry: string) => registry.recordDeliveryRetryAttempt(previous, retry),
  };
  const queryDependencies = {
    client: () => client,
    rolledBack: () => false,
    settle: (operationId: string) => resolveSendReceipt(operationId, { registry, client }),
  };
  return {
    conversationId: conversation.id,
    threadId,
    accountId,
    artifactPath,
    registry,
    journal,
    host: () => host,
    rpc,
    provider: { requests, open: () => open.length, completeNext },
    async handle(request) {
      const url = new URL(request.url);
      const next = new NextRequest(new URL(url.pathname + url.search, "http://localhost"), {
        method: request.method,
        headers: { host: "localhost", "content-type": request.headers.get("content-type") ?? "application/json" },
        ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.text() }),
      });
      const operation = /^\/api\/runtime\/operations\/([^/]+)$/.exec(url.pathname);
      if (url.pathname === "/api/runtime/send" && request.method === "POST") return handleRuntimeCommand(next, "send", commandDependencies);
      if (operation && request.method === "POST") return handleRuntimeRetry(next, decodeURIComponent(operation[1]!), retryDependencies);
      if (url.pathname === "/api/runtime/queue") return handleNativeQueue(next, queueDependencies);
      if (operation && request.method === "GET") return handleRuntimeOperationQuery(decodeURIComponent(operation[1]!), queryDependencies);
      return Response.json({ error: "not served by the native Codex fixture" }, { status: 404 });
    },
    async receipts() {
      const snapshot = await client.snapshot();
      return (snapshot.recentOperations ?? []).filter((receipt) => receipt.conversationId === conversation.id);
    },
    async close() {
      await bindStructuredDeliveryQueue([], { registry, client: null });
      await host.release().catch(() => {});
      for (const response of open.splice(0)) response.end();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      server.close();
      journal.close();
      setAgentRegistryForTests(null);
    },
  };
}
