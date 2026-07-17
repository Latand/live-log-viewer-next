import fs from "node:fs";
import path from "node:path";

import { AgentRegistry } from "@/lib/agent/registry";

import type { RuntimeHostClient } from "../client";
import type { RuntimeSnapshot } from "../contracts";
import {
  RuntimeImageStore,
  runtimeImageCapability,
  runtimeImageRefsForUploads,
  type RuntimeImageUpload,
} from "../runtimeImageStore";
import { enqueueStructuredMessage } from "../structuredMessageDelivery";

const [stateRoot, artifactPath, clientMessageId, imageBase64, publishedMarker, releaseMarker] = process.argv.slice(2);
if (!stateRoot || !artifactPath || !clientMessageId || !imageBase64) {
  throw new Error("structured image admission writer arguments are incomplete");
}

const registry = new AgentRegistry(path.join(stateRoot, "agent-registry.json"));
const conversation = registry.conversationForPath(artifactPath);
if (!conversation) throw new Error("structured image admission conversation is missing");
const store = new RuntimeImageStore(path.join(stateRoot, "runtime-images"));
const upload: RuntimeImageUpload = { base64: imageBase64, mime: "image/png" };

function waitForRelease(filename: string): void {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(filename)) {
    if (Date.now() >= deadline) throw new Error("structured image admission release timed out");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

const runtimeSnapshot: RuntimeSnapshot = {
  schemaVersion: 1,
  snapshotSeq: 1,
  retentionFloorSeq: 0,
  serverTime: new Date().toISOString(),
  runtime: { hostEpoch: 1, health: "ready" },
  filesRevision: 0,
  sessions: [{
    conversationId: conversation.id,
    sessionKey: { engine: "claude", sessionId: conversation.generations.at(-1)!.id },
    hostKind: "claude-broker",
    host: "hosted",
    turn: "idle",
    provenance: "structured",
    revision: 1,
    attentionIds: [],
    recentReceipts: [],
    accountId: "default",
    parentConversationId: null,
    flowId: null,
    workflowId: null,
    cwd: "/repo",
    artifactPath,
    capabilities: {
      steer: false,
      structuredAttention: true,
      imageInput: runtimeImageCapability("claude", true),
    },
    activeTurnId: null,
  }],
  attentions: [],
  recentOperations: [],
  edges: [],
  flows: [],
  workflows: [],
  tasks: [],
  deployments: [],
};

const client = {
  snapshot: async () => runtimeSnapshot,
  command: async (command: { operationId: string; idempotencyKey: string }) => ({
    operationId: command.operationId,
    replayed: false,
    receipt: {
      operationId: command.operationId,
      idempotencyKey: command.idempotencyKey,
      conversationId: conversation.id,
      kind: "send" as const,
      status: "queued" as const,
      text: "",
      imageCount: 1,
      at: new Date().toISOString(),
      revision: 1,
    },
  }),
} as unknown as RuntimeHostClient;

const result = await enqueueStructuredMessage({
  path: artifactPath,
  conversationId: conversation.id,
  clientMessageId,
  text: "",
  images: [upload],
}, {
  enabled: () => true,
  client: () => client,
  registry: () => registry,
  previewImageRefs: (images) => runtimeImageRefsForUploads(images),
  storeImages: (images) => {
    const refs = store.putMany(images);
    if (publishedMarker && publishedMarker !== "-") {
      fs.writeFileSync(publishedMarker, "published\n");
      if (releaseMarker && releaseMarker !== "-") waitForRelease(releaseMarker);
    }
    return refs;
  },
  discardImages: (refs) => store.discardUnreferenced(refs),
  kick: () => {},
});

process.stdout.write(JSON.stringify(result));
