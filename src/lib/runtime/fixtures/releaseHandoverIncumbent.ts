import fs from "node:fs";
import path from "node:path";

import { AgentRegistry } from "@/lib/agent/registry";
import { sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import { procBackend } from "@/lib/proc";
import { RuntimeJournal } from "@/runtime-host/journal";
import { activateViewerRuntimeWhenCurrent, completeViewerReleaseDemotion } from "@/lib/viewerInstrumentation";

import type { RuntimeHostClient } from "../client";
import type { HostState } from "../engineHost";
import { bindStructuredDeliveryQueue, publishStructuredDeliveryHost } from "../structuredDeliveryController";
import { createFakeDeliveryLedger, FakeEngineHost } from "./fakeEngineHost";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function runtimeClient(journal: RuntimeJournal): RuntimeHostClient {
  return {
    snapshot: async () => journal.snapshot(),
    events: async (after) => journal.replay(after),
    waitEvents: async (after) => journal.replay(after),
    append: async (event) => journal.append(event),
    operation: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    operationStatus: async (operationId) => journal.operationResult(operationId),
    retryOperation: async (operationId) => journal.retryOperation(operationId),
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details) => journal.transitionOperation(operationId, status, details),
    producerCursor: async (producerKind, eventKeyPrefix) => journal.producerCursor(producerKind, eventKeyPrefix),
  } as RuntimeHostClient;
}

const registryPath = required("LLV_HANDOVER_REGISTRY");
const journalPath = required("LLV_HANDOVER_JOURNAL");
const targetPath = required("LLV_HANDOVER_TARGET");
const demotionGate = required("LLV_HANDOVER_DEMOTION_GATE");
const readyPath = required("LLV_HANDOVER_READY");
const engine = required("LLV_HANDOVER_ENGINE") as SessionKey["engine"];
const sessionId = required("LLV_HANDOVER_SESSION_ID");
const key = { engine, sessionId } as const;
const registry = new AgentRegistry(registryPath, undefined, undefined, { sqliteMode: "off" });
const journal = new RuntimeJournal(journalPath, { structuredHosts: true });
const client = runtimeClient(journal);
const engineProcess = Bun.spawn({ cmd: ["/usr/bin/sleep", "60"], stdout: "ignore", stderr: "ignore" });
const engineIdentity = {
  pid: engineProcess.pid,
  startIdentity: procBackend.processIdentity(engineProcess.pid),
};
const viewerIdentity = {
  pid: process.pid,
  startIdentity: procBackend.processIdentity(process.pid),
};
const claimed = registry.claimStructuredHost(key, viewerIdentity, { allowUnhosted: true });
if (!claimed?.structuredHost || !claimed.claimOwner) throw new Error("incumbent Viewer could not claim the fixture host");
const hosted = registry.setStructuredHostClaimed(key, {
  ...claimed.structuredHost,
  endpoint: `stdio:${engineIdentity.pid}`,
  process: engineIdentity,
}, "live", claimed.claimOwner, claimed.claimEpoch);
if (!hosted) throw new Error("incumbent Viewer could not publish the fixture host");

let released = false;
const liveState: HostState = {
  status: "active",
  sessionKey: sessionId,
  endpoint: `stdio:${engineIdentity.pid}`,
  pid: engineIdentity.pid,
  processStartIdentity: engineIdentity.startIdentity,
  eventCursor: 0,
  protocolVersion: "handover-fixture",
  activeTurnRef: "handover-turn",
  pendingAttention: [],
  activeFlags: [],
  account: null,
};
const host = Object.assign(new FakeEngineHost(createFakeDeliveryLedger(), liveState), {
  onStateChange: (listener: (state: HostState) => void) => {
    listener(liveState);
    return () => {};
  },
  release: async () => {
    if (released) return;
    released = true;
    engineProcess.kill("SIGTERM");
    await engineProcess.exited;
    const current = registry.readOnlySnapshot().entries[sessionKeyId(key)];
    if (!current?.structuredHost || !current.claimOwner) throw new Error("incumbent host claim disappeared before release");
    const retired = registry.setStructuredHostClaimed(key, {
      ...current.structuredHost,
      endpoint: "stdio:released",
      process: null,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    }, "unhosted", current.claimOwner, current.claimEpoch, true);
    if (!retired) throw new Error("incumbent host claim changed before release");
  },
});

await bindStructuredDeliveryQueue([], { registry, client });
await publishStructuredDeliveryHost({ key, host });
fs.writeFileSync(readyPath, JSON.stringify({ viewer: viewerIdentity, engine: engineIdentity }));

const isCurrent = () => {
  if (!fs.existsSync(demotionGate)) return true;
  try { return fs.readFileSync(targetPath, "utf8").trim() === "incumbent"; }
  catch { return true; }
};
await activateViewerRuntimeWhenCurrent(async () => {}, isCurrent, {
  pollMs: 10,
  onDemoted: () => completeViewerReleaseDemotion(async () => {
    fs.writeFileSync(path.join(path.dirname(targetPath), "incumbent-checkpointed"), "1");
    journal.close();
  }),
});
setInterval(() => {}, 1_000);
