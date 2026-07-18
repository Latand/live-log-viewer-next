import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { reviewerBindingTargetsForRound } from "@/components/flows/flowModel";
import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

import { type SwitchboardData, useSwitchboardData } from "./useSwitchboardData";

const dom = new Window({ url: "http://localhost/" });
const globals = globalThis as Record<string, unknown>;
const overrides: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const savedGlobals = new Map<string, { present: boolean; value: unknown }>();

beforeAll(() => {
  for (const [key, value] of Object.entries(overrides)) {
    savedGlobals.set(key, { present: key in globals, value: globals[key] });
    globals[key] = value;
  }
});

afterAll(() => {
  for (const [key, saved] of savedGlobals) {
    if (saved.present) globals[key] = saved.value;
    else delete globals[key];
  }
  dom.close();
});

function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "codex-sessions",
    name: overrides.path,
    project: "demo",
    title: overrides.path,
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1_000,
    size: 10,
    activity: "recent",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

function Probe({ files, flows, onData }: { files: FileEntry[]; flows: Flow[]; onData: (data: SwitchboardData) => void }) {
  onData(useSwitchboardData(files, [], "", 1_100, new Set(), flows));
  return null;
}

test("keeps every durable same-round reviewer binding out of standalone switchboard cards", async () => {
  const flowId = "flow-two-bindings";
  const membership = (slot: string) => ({
    kind: "flow" as const,
    containerId: flowId,
    role: "reviewer" as const,
    slot,
    stageId: null,
    stageOrder: null,
    round: 1,
    parentConversationId: "conversation-builder",
  });
  const builder = entry({ path: "/builder", conversationId: "conversation-builder" });
  const prior = entry({
    path: "/review-prior",
    conversationId: "conversation-prior",
    durableLineage: {
      kind: "review",
      role: "reviewer",
      parentConversationId: builder.conversationId!,
      reviewsConversationId: builder.conversationId!,
      memberships: [membership("reviewer:1:binding-a")],
    },
  });
  const current = entry({
    path: "/review-current",
    conversationId: "conversation-current",
    durableLineage: {
      kind: "review",
      role: "reviewer",
      parentConversationId: builder.conversationId!,
      reviewsConversationId: builder.conversationId!,
      memberships: [membership("reviewer:1:binding-b")],
    },
  });
  const flow = {
    id: flowId,
    template: "implement-review-loop",
    project: "demo",
    cwd: "/repo",
    implementerPath: builder.path,
    implementerConversationId: builder.conversationId,
    roles: {
      implementer: { engine: "codex", model: null, effort: null },
      reviewer: { engine: "codex", model: null, effort: null },
    },
    baseRef: "4f66203e",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "reviewing",
    stateDetail: null,
    rounds: [{
      n: 1,
      reviewerPath: current.path,
      reviewerConversationId: current.conversationId,
      reviewerBindingId: "binding-b",
      findingsPath: null,
      triggeredBy: "marker",
      readyNote: null,
      verdict: null,
      findingsCount: null,
      startedAt: "2026-07-18T00:00:00Z",
      reviewedAt: null,
      relayedAt: null,
      error: null,
    }],
    createdAt: "2026-07-18T00:00:00Z",
    closedAt: null,
  } satisfies Flow;
  const files = [builder, prior, current];

  expect(reviewerBindingTargetsForRound(flow, flow.rounds[0], files).map(({ path }) => path))
    .toEqual([prior.path, current.path]);

  let data: SwitchboardData | null = null;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Probe files={files} flows={[flow]} onData={(next) => { data = next; }} />);
  });

  expect(data).not.toBeNull();
  const standalonePaths = [data!.waiting, data!.working, data!.recent, data!.older]
    .flatMap((items) => items.map((item) => item.file.path));
  expect(standalonePaths).toEqual([builder.path]);

  await act(async () => { root.unmount(); });
  host.remove();
});
