/**
 * The conversation the height capture measures, assembled from the real ones.
 *
 * This is the browser half of `capture-issue-1629-queue-height.ts`: it mounts
 * the SAME components the board mounts — `BranchPane` on the phone, and the
 * board's `NativeConversationPane` (which is `BranchPane` plus the composer
 * portal) for a card — around the real `TmuxComposer` and the real
 * `NativeQueuePanel`, with the real `useNativeQueue` hook behind them.
 *
 * Only the edges are stand-ins, and each of them is the seam the product
 * already publishes for a test: the runtime snapshot, the queue transport, the
 * log tail and `fetch`. Nothing about the layout is reconstructed here — the
 * pane's own header, the feed, the composer's form and every control come from
 * the app, which is the whole point: a hand-built wrapper only proves the
 * wrapper is consistent with itself.
 *
 * The query decides the case: `surface=phone|card`, `count`, `long`,
 * `unresolved`, `draft=long`, `receipts=<n>`, `voice`, and `noqueue` for the
 * composition that has no queue at all to give room back.
 *
 * `voice` mounts the REAL `VoicePipHost` against a fake realtime client with a
 * null microphone stream, so the docked call panel above the composer is the
 * app's own — the tallest thing this form ever gains, and the one that pushed
 * the input and Send out of a 680 px card.
 */
import { createRoot } from "react-dom/client";
import { createElement } from "react";

import { BranchPane } from "@/components/BranchPane";
import { NativeConversationPane } from "@/components/scheme/NativeConversationPane";
import { VoicePipHost } from "@/components/voice/VoicePipHost";
import { configureRealtimeClientForTests } from "@/hooks/useCodexRealtime";
import { reportCallPhase } from "@/lib/realtime/activeCall";
import { installSnapshot } from "@/components/runtime/runtimeModel";
import { setLogFeedDependenciesForTests } from "@/components/logFeedDependencies";
import { setTmuxComposerRuntimeDependenciesForTests } from "@/components/tmuxComposerRuntime";
import { setRuntimeBusForTests } from "@/hooks/runtimeBus";
import { setLocale } from "@/lib/i18n";
import type { NativeQueueRecord } from "@/lib/runtime/nativeQueueContracts";
import type { RuntimeSession, RuntimeSnapshot } from "@/lib/runtime/contracts";
import type { FileEntry } from "@/lib/types";

const params = new URLSearchParams(location.search);
const count = Number(params.get("count") ?? "16");
const long = params.has("long");
const unresolved = Number(params.get("unresolved") ?? "0");
const phone = params.get("surface") === "phone";
const receiptCount = Number(params.get("receipts") ?? "0");
const withVoice = params.has("voice");
const withQueue = !params.has("noqueue");

const CARD = "conversation_queue_height";
const THREAD = "thread-queue-height";
const ACCOUNT = "account-queue-height";
const PATH = "/fixture/codex.jsonl";

/** A wrapping message, because a row that never wraps hides how tall the queue
    really gets. */
const LONG = "Rebase the branch onto main, rerun the focused suites for the queue and the composer, and then write the evidence table into the pull request body with the exact counts from the run rather than the ones the description already claims.";

function rowText(index: number): string {
  return long && index % 4 === 0 ? `Queued instruction ${index + 1}: ${LONG}` : `Queued instruction ${index + 1}: run the focused check and report the result.`;
}

function record(index: number): NativeQueueRecord {
  return {
    entryId: `e${index}`,
    conversationId: CARD,
    binding: { threadId: THREAD, accountId: ACCOUNT },
    clientUserMessageId: `client-${index}`,
    nativeSubmissionId: `native-${index}`,
    revision: 1,
    versions: [{ revision: 1, operationId: `op-${index}`, text: rowText(index), images: [], contentDigest: `d-${index}` }],
    profilePolicy: "thread-at-dispatch",
    state: "queued",
    mutationOperationId: null,
    dispatchedRevision: null,
    dispatchedTurnId: null,
    proof: null,
    reason: null,
  };
}

const entries = Array.from({ length: count }, (_, index) => record(index));
const items = entries.map((entry, index) => ({
  id: entry.nativeSubmissionId ?? `native-${index}`,
  clientUserMessageId: entry.clientUserMessageId,
  input: [{ type: "text" as const, text: entry.versions[0]!.text }],
}));

/* Deliveries this conversation has no terminal answer for: the receipt list
   under the input, which is one of the surfaces that has to give room back when
   the form is at its budget. */
const receipts = Array.from({ length: receiptCount }, (_, index) => ({
  operationId: `receipt-${index}`,
  idempotencyKey: `receipt-key-${index}`,
  conversationId: CARD,
  kind: "send",
  status: index % 2 ? "failed" : "uncertain",
  text: `Submitted message ${index + 1}: check the requested result and preserve the work.`,
  reason: index % 2 ? "the transport timed out with no terminal answer" : "the delivery outcome is unknown",
  at: new Date(Date.now() - 10_000 + index).toISOString(),
  revision: 1,
}));

/* A call that is up, with a transcript and a notice, and NO microphone: the
   panel is the app's own and the client is a stand-in that answers a snapshot
   and nothing else. Nothing here reaches a provider. */
const voiceSnapshot = {
  phase: "live" as const,
  lines: Array.from({ length: 12 }, (_, index) => ({
    id: `v${index}`,
    role: index % 2 ? ("assistant" as const) : ("user" as const),
    text: `Voice transcript ${index + 1}: read the selected conversation and report the requested information.`,
    final: true,
  })),
  error: null,
  notice: "This account is approaching its usage limit; the call may be cut short.",
  agentUnavailable: null,
  startedAt: Date.now() - 62_000,
  micMuted: false,
  outputMuted: false,
};
const voiceClient = {
  subscribe: () => () => {},
  getSnapshot: () => voiceSnapshot,
  micStream: () => null,
  toggleMic() {},
  toggleOutput() {},
  start: async () => {},
  stop: async () => {},
  updateWorkerProgress() {},
  reconcileWorkerDeliveries() {},
  reconcileCanonicalTranscript() {},
  reportBackingHost() {},
  onDeliveryAcknowledged: () => () => {},
  realtimeSession: () => null,
};
if (withVoice) {
  configureRealtimeClientForTests(() => voiceClient as never);
  reportCallPhase(CARD, "live");
}

const session = {
  conversationId: CARD,
  sessionKey: { engine: "codex", sessionId: THREAD },
  hostKind: "codex-app-server",
  host: "hosted",
  turn: "idle",
  provenance: "structured",
  accountId: ACCOUNT,
  parentConversationId: null,
  cwd: null,
  artifactPath: PATH,
  capabilities: {
    steer: true,
    structuredAttention: true,
    nativeQueue: withQueue,
    imageInput: { supported: true, mimes: ["image/png"] },
  },
  activeTurnId: null,
  nativeQueueRevision: 0,
  attentionIds: [],
  recentReceipts: [],
  revision: 1,
} as unknown as RuntimeSession;

const snapshot = {
  schemaVersion: 1,
  snapshotSeq: 1,
  retentionFloorSeq: 0,
  runtime: { hostEpoch: 1, health: "healthy" },
  filesRevision: 0,
  sessions: [session],
  attentions: [],
  recentOperations: [],
  edges: [],
  flows: [],
  workflows: [],
  tasks: [],
} as unknown as RuntimeSnapshot;

const state = {
  store: installSnapshot(snapshot),
  connection: "live",
  resyncedAt: null,
  lastEventAt: null,
  enabled: true,
  structuredHostsEnabled: true,
};
setRuntimeBusForTests({
  getState: () => state,
  subscribe: () => () => {},
  subscribeFilesRevision: () => () => {},
  start() {},
  stop() {},
  refresh: async () => true,
} as unknown as Parameters<typeof setRuntimeBusForTests>[0]);

/* The queue transport: the read the panel projects from, and a write that
   records the attempt and refuses it, so a stray press in a capture can never
   look like a delivery. */
const writes: unknown[] = [];
Object.assign(window, { __queueWrites: writes });
setTmuxComposerRuntimeDependenciesForTests({
  useRuntimeReceiptsForArtifact: (() => receipts) as never,
  nativeQueue: {
    read: async () => ({ entries, native: { threadId: THREAD, items, stale: false } }),
    write: async (body) => {
      writes.push(body);
      return { status: 503, body: {} };
    },
  },
});

const lines = Array.from({ length: 60 }, (_, index) => JSON.stringify({
  type: "response_item",
  payload: {
    type: "message",
    id: `m${index}`,
    role: index % 2 ? "assistant" : "user",
    content: [{ type: index % 2 ? "output_text" : "input_text", text: `Existing transcript message ${index + 1}: checking the requested result.` }],
  },
}));
setLogFeedDependenciesForTests({
  useLogTail: () => ({
    lines, linesStart: 0, size: 1000, loading: false, error: null, tickTime: null,
    paused: false, setPaused() {}, clear() {}, hasMore: false, loadingOlder: false,
    loadOlder: async () => 0, prependGen: 0,
  }),
} as unknown as Parameters<typeof setLogFeedDependenciesForTests>[0]);

/* Every network read this page could make answers empty rather than reaching a
   host: the capture is about layout, and nothing here is a live conversation. */
const answer = (url: string) => new Response(
  JSON.stringify(url.includes("/targets") ? { targets: {} } : { voices: [], accounts: [], models: [], engines: [], options: [] }),
  { status: 200, headers: { "content-type": "application/json" } },
);
window.fetch = ((input: RequestInfo | URL) => Promise.resolve(answer(String(input)))) as typeof fetch;

setLocale("en");
sessionStorage.setItem(`llvDraft:${CARD}`, "A new instruction");
if (unresolved > 0) {
  /* Hand-offs this browser has no answer for: the panel's recovery section, in
     the record the composer itself keeps. */
  sessionStorage.setItem(`llvQueueAdmission:${CARD}`, JSON.stringify(
    Array.from({ length: unresolved }, (_, index) => ({
      key: `unknown-${index}`,
      mutation: { action: "add", text: `A message whose admission was never answered (${index + 1})` },
      binding: { threadId: THREAD, accountId: ACCOUNT },
    })),
  ));
}

const file = {
  path: PATH,
  root: "codex-sessions",
  name: "codex.jsonl",
  project: "viewer",
  title: "Queue height verification",
  engine: "codex",
  kind: "session",
  fmt: "codex",
  parent: null,
  mtime: Date.now() / 1000,
  size: 1000,
  activity: "idle",
  proc: "running",
  pid: null,
  conversationId: CARD,
  pendingQuestion: null,
  waitingInput: null,
  model: "gpt-6-astra",
  effort: "high",
} as unknown as FileEntry;

const host = document.getElementById("app")!;
createRoot(host).render(phone
  ? createElement(BranchPane, { file, tasks: [], isRoot: true })
  : createElement(NativeConversationPane, { file, tasks: [], isRoot: false, active: true, place: host, fullWindowPlace: null }));

/* The Viewer-level owner of the ONE call panel, mounted the way the app mounts
   it: it portals the panel into the slot the card publishes above its composer,
   so the docked call in these frames is the real composition. */
if (withVoice) {
  const voiceHost = document.createElement("div");
  document.body.append(voiceHost);
  createRoot(voiceHost).render(createElement(VoicePipHost, { mobile: phone, resolveClient: () => voiceClient as never }));
}
