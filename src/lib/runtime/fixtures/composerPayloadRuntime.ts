/** The composer's delivery routes served by the real handlers over a real
 * runtime host journal, in a private state directory, with a fake engine host.
 * No provider, account, or operator state is reachable from here. */
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { inboxFilesDir } from "@/lib/inboxFiles";
import { RuntimeHost } from "@/runtime-host/host";
import { RuntimeJournal } from "@/runtime-host/journal";
import { serveRuntimeHost } from "@/runtime-host/socket";

import { UnixRuntimeHostClient } from "../client";
import type { RuntimeOperationReceipt } from "../contracts";
import type { QueueEntry } from "../engineHost";
import { handleRuntimeCommand, handleRuntimeOperationQuery, handleRuntimeRetry } from "../http";
import { handleNativeQueue } from "../nativeQueueHttp";
import { admitRuntimeImagePayload } from "../runtimeImageAdmission";
import { runtimeImageStore } from "../runtimeImageStore";
import { resolveSendReceipt } from "../sendSettlement";
import { bindStructuredDeliveryQueue } from "../structuredDeliveryController";
import type { StructuredRecoveryResult } from "../structuredRecovery";
import { kickStructuredDeliveryQueue } from "../structuredDeliverySignal";
import { enqueueStructuredMessage } from "../structuredMessageDelivery";
import { FakeEngineHost } from "./fakeEngineHost";

export interface DeliveredPayload {
  entryId: string;
  text: string;
  images: { sha256: string; mime: string; base64: string }[];
  files: { path: string; base64: string | null }[];
}

export interface ComposerPayloadRuntime {
  conversationId: string;
  artifactPath: string;
  registry: AgentRegistry;
  journal: RuntimeJournal;
  /** Every message the engine accepted, with bytes read back from server storage. */
  delivered: DeliveredPayload[];
  handle(request: Request): Promise<Response>;
  receipts(): Promise<RuntimeOperationReceipt[]>;
  /** A second conversation hosted by a native-queue Codex thread. The queue
      route admits its hand-offs into the real journal; nothing dispatches them
      to an engine, which leaves native semantics outside this fixture. */
  queue: { conversationId: string; threadId: string; accountId: string };
  /** The engine host starts unavailable while the journal still projects its
      session as hosted, so a send is admitted and then fenced by the queue.
      This makes it available again and republishes it. */
  hostUp(): Promise<void>;
  close(): Promise<void>;
}

const ALLOWED_ROOTS = [os.tmpdir(), "/var/tmp"].map((root) => path.resolve(root) + path.sep);

/** Points every state path at `directory` before any store resolves one. The
 * inbox sentinel stops the legacy-directory migration from copying anything in. */
export function isolateComposerPayloadRuntime(directory: string): void {
  const root = path.resolve(directory) + path.sep;
  if (!ALLOWED_ROOTS.some((allowed) => root.startsWith(allowed))) {
    throw new Error("composer payload runtime requires a private temporary directory");
  }
  const config = path.join(directory, "config");
  process.env.LLV_STATE_DIR = path.join(directory, "state");
  process.env.XDG_CONFIG_HOME = config;
  process.env.XDG_CACHE_HOME = path.join(directory, "cache");
  const inbox = path.join(config, "agent-log-viewer", "inbox");
  fs.mkdirSync(inbox, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(inbox, ".migrated-from-legacy"), "isolated fixture\n");
  fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true, mode: 0o700 });
}

function readDelivered(entry: QueueEntry): DeliveredPayload {
  const text = entry.content?.text ?? entry.text ?? "";
  const refs = entry.images ?? entry.content?.images ?? [];
  const inbox = inboxFilesDir() + path.sep;
  return {
    entryId: entry.id,
    text,
    images: refs.map((ref) => ({
      sha256: ref.sha256,
      mime: ref.mime,
      base64: runtimeImageStore().read(ref).toString("base64"),
    })),
    files: text.split("\n").filter((line) => line.startsWith(inbox)).map((filePath) => ({
      path: filePath,
      base64: fs.existsSync(filePath) ? fs.readFileSync(filePath).toString("base64") : null,
    })),
  };
}

export async function startComposerPayloadRuntime(directory: string): Promise<ComposerPayloadRuntime> {
  isolateComposerPayloadRuntime(directory);
  const stateDirectory = process.env.LLV_STATE_DIR!;
  const registry = new AgentRegistry(
    path.join(stateDirectory, "agent-registry.json"),
    undefined,
    undefined,
    { sqliteMode: "off" },
  );
  setAgentRegistryForTests(registry);
  const sessionId = crypto.randomUUID();
  const artifactPath = path.join(directory, "sessions", `${sessionId}.jsonl`);
  const profile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "fixture-account",
    launchProfile: profile,
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: new Date().toISOString(),
  }]);
  const conversation = registry.conversationForPath(artifactPath)!;
  const key = { engine: "codex" as const, sessionId };
  registry.upsert({
    key,
    artifactPath,
    cwd: directory,
    accountId: "fixture-account",
    launchProfile: profile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:composer-payload-host",
      process: null,
      eventCursor: 0,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 0,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const journal = new RuntimeJournal(path.join(stateDirectory, "runtime-events.sqlite"), { structuredHosts: true });
  const socketPath = path.join(directory, "rt.sock");
  const server = serveRuntimeHost(socketPath, new RuntimeHost(journal, undefined, undefined, true));
  await once(server, "listening");
  const client = new UnixRuntimeHostClient(socketPath, 30_000, 30_000, 30_000);
  let available = true;
  const delivered: DeliveredPayload[] = [];
  /* Recovery reports only what the fake host really is: while it is down no
     host starts, so the queue fences the admitted send as never executed. */
  const recovered = (spawned: boolean): StructuredRecoveryResult => ({
    target: null, path: artifactPath, conversationId: conversation.id, spawned,
  });
  const recover = async (): Promise<StructuredRecoveryResult | null> => available ? recovered(false) : null;
  const engine = Object.assign(new FakeEngineHost(), { onStateChange: () => () => {} });
  const health = engine.health.bind(engine);
  engine.health = async () => available ? health() : { ...await health(), status: "dead", pid: null, processStartIdentity: null };
  const send = engine.send.bind(engine);
  engine.send = async (entry) => {
    if (!available) throw new Error("the fixture engine host is down");
    if (!engine.ledger.receipts.has(entry.id)) delivered.push(readDelivered(entry));
    return send(entry);
  };
  const bind = () => bindStructuredDeliveryQueue([{ key, host: engine }], {
    registry,
    client,
    recover: async () => (await recover()) ?? recovered(false),
  });
  await bind();
  /* The process goes away after its hosted state was published and before
     anything observed it: admission still sees a hosted session. */
  available = false;
  const commandDependencies = {
    enabled: () => true,
    structuredEnabled: () => true,
    client: () => client,
    registry: () => registry,
    enqueue: enqueueStructuredMessage,
    retireReplySuggestions: () => ({ cleared: false, pending: false }),
    kick: kickStructuredDeliveryQueue,
  };
  const queue = { conversationId: `conversation_${crypto.randomUUID()}`, threadId: crypto.randomUUID(), accountId: "fixture-account" };
  journal.append({
    scope: { type: "session", id: queue.conversationId },
    kind: "session-status",
    payload: {
      conversationId: queue.conversationId,
      sessionKey: { engine: "codex", sessionId: queue.threadId },
      accountId: queue.accountId,
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "running",
      provenance: "structured",
      artifactPath: path.join(directory, "sessions", `${queue.threadId}.jsonl`),
      capabilities: { steer: true, structuredAttention: true, nativeQueue: true },
      diagnostics: { queueCapability: "supported", nativeQueue: true },
    },
  });
  const queueDependencies = {
    client: () => client,
    enabled: () => true,
    kick: () => {},
    admitImages: (images: unknown) => admitRuntimeImagePayload({ images }),
    storeImages: (uploads: Parameters<ReturnType<typeof runtimeImageStore>["putMany"]>[0]) => runtimeImageStore().putMany(uploads),
  };
  const retryDependencies = {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    kick: kickStructuredDeliveryQueue,
    recover,
    republish: async () => available,
    recordRetryAttempt: (previous: string, retry: string) => registry.recordDeliveryRetryAttempt(previous, retry),
  };
  const queryDependencies = {
    client: () => client,
    rolledBack: () => false,
    settle: (operationId: string) => resolveSendReceipt(operationId, { registry, client }),
  };
  return {
    conversationId: conversation.id,
    artifactPath,
    registry,
    journal,
    delivered,
    queue,
    async handle(request) {
      const url = new URL(request.url);
      const next = new NextRequest(new URL(url.pathname + url.search, "http://localhost"), {
        method: request.method,
        headers: { host: "localhost", "content-type": request.headers.get("content-type") ?? "application/json" },
        ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.text() }),
      });
      const operation = /^\/api\/runtime\/operations\/([^/]+)$/.exec(url.pathname);
      if (url.pathname === "/api/runtime/send" && request.method === "POST") {
        return handleRuntimeCommand(next, "send", commandDependencies);
      }
      if (operation && request.method === "POST") {
        return handleRuntimeRetry(next, decodeURIComponent(operation[1]!), retryDependencies);
      }
      if (url.pathname === "/api/runtime/queue") return handleNativeQueue(next, queueDependencies);
      if (operation && request.method === "GET") {
        return handleRuntimeOperationQuery(decodeURIComponent(operation[1]!), queryDependencies);
      }
      return Response.json({ error: "not served by the payload fixture" }, { status: 404 });
    },
    async receipts() {
      const snapshot = await client.snapshot();
      return (snapshot.recentOperations ?? []).filter((receipt) => receipt.conversationId === conversation.id);
    },
    async hostUp() {
      available = true;
      await bind();
    },
    async close() {
      await bindStructuredDeliveryQueue([], { registry, client: null });
      server.close();
      journal.close();
      setAgentRegistryForTests(null);
    },
  };
}
