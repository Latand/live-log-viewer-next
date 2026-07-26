import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Pipeline } from "@/lib/pipelines/types";

import type { AgentLivenessRecord } from "./liveness";

/* The engine and the journal both resolve their state directory at import
   time, so pin a sandbox before either is loaded. Nothing in this file may
   reach the operator's shared registry. */
process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-lifecycle-projector-"));

const { patchPipeline } = await import("@/lib/pipelines/engine");
const { pipelineIdentity, savePipelines } = await import("@/lib/pipelines/store");
const { queryLifecycleEvents } = await import("./journal");
const { refreshLifecycleJournal } = await import("./projector");

afterAll(() => fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }));

const T0 = "2026-07-26T09:00:00.000Z";

const BUILDER_ROLE = { engine: "codex", model: null, effort: null, roleId: null, access: "read-write", promptScaffold: null };
const REVIEWER_ROLE = { engine: "codex", model: null, effort: null, roleId: null, access: "read-only", promptScaffold: null };

function pipelineFixture(id: string, overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id,
    task: "ship the lifecycle journal",
    taskIds: [],
    project: "viewer",
    repoDir: "/repo",
    ...pipelineIdentity(id, "ship the lifecycle journal", "/repo"),
    baseBranch: "main",
    baseRef: "main",
    lastPassedCommit: "",
    stages: [
      { id: "build", kind: "run", prompt: "build", next: "review", onFail: null, effectiveRole: BUILDER_ROLE },
      { id: "review", kind: "review-loop", prompt: "review", next: null, onFail: null, effectiveRole: REVIEWER_ROLE },
    ],
    runs: [{ stageId: "build", attempts: [] }, { stageId: "review", attempts: [] }],
    cursor: { stageId: "build", state: "running", input: null, activatedBy: null },
    state: "running",
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: T0,
    closedAt: null,
    ...overrides,
  } as unknown as Pipeline;
}

function typesFor(pipelineId: string): string[] {
  return queryLifecycleEvents({ pipelineId, limit: 200 }).events.map((event) => event.type);
}

test("pausing and resuming a pipeline through the real action emits stage_paused and stage_resumed (#686)", async () => {
  const id = "pipeline_pause_real";
  savePipelines([pipelineFixture(id)]);

  /* The production call site: the same `pipeline_action` the board and the MCP
     tool both drive. */
  const paused = await patchPipeline(id, { action: "pause" });
  expect(paused.pipeline?.state).toBe("paused");
  expect(paused.pipeline?.pausedAt).toBeTruthy();

  refreshLifecycleJournal({ pipelines: [paused.pipeline!] }, { force: true });
  expect(typesFor(id)).toContain("stage_paused");
  const pausedEvent = queryLifecycleEvents({ pipelineId: id, type: "stage_paused" }).events[0]!;
  expect(pausedEvent.state).toBe("waiting");
  expect(pausedEvent.at).toBe(paused.pipeline!.pausedAt!);
  expect(pausedEvent.stageId).toBe("build");

  const resumed = await patchPipeline(id, { action: "resume" });
  expect(resumed.pipeline?.state).toBe("running");
  expect(resumed.pipeline?.resumedAt).toBeTruthy();

  refreshLifecycleJournal({ pipelines: [resumed.pipeline!] }, { force: true });
  expect(typesFor(id)).toContain("stage_resumed");
  expect(queryLifecycleEvents({ pipelineId: id, type: "stage_resumed" }).events[0]!.state).toBe("running");

  /* Re-projecting the same durable record appends nothing, and a second pause
     is a genuinely new event because its timestamp differs. */
  const before = typesFor(id).length;
  refreshLifecycleJournal({ pipelines: [resumed.pipeline!] }, { force: true });
  expect(typesFor(id)).toHaveLength(before);
});

test("a traversed fail edge emits repair_ready from the durable activation record (#686)", () => {
  const id = "pipeline_repair_real";
  const pipeline = pipelineFixture(id, {
    runs: [
      {
        stageId: "build",
        attempts: [
          { n: 1, state: "passed", startedAt: T0, completedAt: "2026-07-26T09:05:00.000Z", conversationId: "conversation_builder" },
          {
            n: 2,
            state: "running",
            startedAt: "2026-07-26T09:20:00.000Z",
            completedAt: null,
            conversationId: "conversation_repair",
            /* The durable evidence that a repair round opened. */
            activatedBy: { stageId: "review", attempt: 1, edge: "fail" },
          },
        ],
      },
      {
        stageId: "review",
        attempts: [{
          n: 1,
          state: "failed",
          startedAt: "2026-07-26T09:06:00.000Z",
          completedAt: "2026-07-26T09:15:00.000Z",
          conversationId: "conversation_reviewer",
          verdict: { status: "fail", findings: ["the relay can drop a terminal event"] },
        }],
      },
    ],
    cursor: { stageId: "build", state: "running", input: "repair the findings", activatedBy: { stageId: "review", attempt: 1, edge: "fail" } },
  } as unknown as Partial<Pipeline>);

  refreshLifecycleJournal({ pipelines: [pipeline] }, { force: true });
  const repair = queryLifecycleEvents({ pipelineId: id, type: "repair_ready" }).events;
  /* The pending cursor and the spawned attempt describe ONE transition, so it
     is journaled once however many times it is observed. */
  expect(repair).toHaveLength(1);
  expect(repair[0]!.stageId).toBe("build");
  /* Dated when the findings landed, not when the projection ran. */
  expect(repair[0]!.at).toBe("2026-07-26T09:15:00.000Z");
  expect(repair[0]!.summary).toContain("review attempt 1");

  refreshLifecycleJournal({ pipelines: [pipeline] }, { force: true });
  expect(queryLifecycleEvents({ pipelineId: id, type: "repair_ready" }).count).toBe(1);
});

function livenessRecord(overrides: Partial<AgentLivenessRecord>): AgentLivenessRecord {
  return {
    conversationId: "conversation_agent_gone",
    transcriptPath: "/transcripts/stage.jsonl",
    project: "viewer",
    engine: "codex",
    title: "stage agent",
    lastRecordAt: T0,
    turnState: "busy",
    host: { state: "gone", kind: "structured", pid: 4242 },
    lifecycle: "stalled",
    reason: "host_gone_turn_open",
    silentForMs: 600_000,
    stalledForMs: 600_000,
    pipeline: null,
    ...overrides,
  };
}

test("a sweep journals agent_gone for an unfinished stage and agent_resumed when it comes back (#686)", () => {
  const conversationId = "conversation_lifecycle_agent";
  const pipelineRef = {
    pipelineId: "pipeline_agent_state",
    stageId: "build",
    attempt: 1,
    reportedState: "running" as const,
    reportedPipelineState: "running" as const,
    paneId: null,
  };

  /* The same entry point `agent_activity` uses. */
  refreshLifecycleJournal({
    liveness: [livenessRecord({ conversationId, lastRecordAt: "2026-07-26T09:10:00.000Z", pipeline: pipelineRef })],
  }, { force: true });
  expect(queryLifecycleEvents({ conversationId }).events.map((event) => event.type)).toEqual(["agent_stalled"]);

  /* The host exits while the pipeline still claims the stage is running. */
  refreshLifecycleJournal({
    liveness: [livenessRecord({
      conversationId,
      lastRecordAt: "2026-07-26T09:12:00.000Z",
      lifecycle: "gone",
      reason: "host_gone_turn_settled",
      turnState: "idle",
      pipeline: pipelineRef,
    })],
  }, { force: true });
  const gone = queryLifecycleEvents({ conversationId, type: "agent_gone" }).events;
  expect(gone).toHaveLength(1);
  expect(gone[0]!.state).toBe("gone");
  expect(gone[0]!.summary).toContain("still reports running");

  /* The operator restarts it and records start flowing again. */
  refreshLifecycleJournal({
    liveness: [livenessRecord({
      conversationId,
      lastRecordAt: "2026-07-26T09:30:00.000Z",
      lifecycle: "running",
      reason: "host_alive_turn_active",
      host: { state: "alive", kind: "structured", pid: 4343 },
      silentForMs: 5_000,
      stalledForMs: null,
      pipeline: pipelineRef,
    })],
  }, { force: true });
  const resumed = queryLifecycleEvents({ conversationId, type: "agent_resumed" }).events;
  expect(resumed).toHaveLength(1);
  expect(resumed[0]!.state).toBe("running");

  /* A settled conversation nobody is waiting on stays out of the journal: an
     inventory of finished transcripts must not bury the events that matter. */
  refreshLifecycleJournal({
    liveness: [livenessRecord({
      conversationId: "conversation_long_finished",
      lifecycle: "gone",
      reason: "host_gone_turn_settled",
      turnState: "idle",
      pipeline: null,
    })],
  }, { force: true });
  expect(queryLifecycleEvents({ conversationId: "conversation_long_finished" }).count).toBe(0);
});
