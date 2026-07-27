import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-monitor-evidence-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const { evidenceFromFlows, evidenceFromPipelines, evidenceFromTasks } = await import("./evidence");
import type { FlowSummary, PipelineSummary, TaskSummary } from "./viewerApi";

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function task(overrides: Partial<TaskSummary>): TaskSummary {
  return { id: "task-1", project: "viewer", status: "inbox", text: "Card title\n\nbody", updatedAt: "2026-07-27T10:00:00Z", assignments: [], pipelineIds: [], ...overrides };
}

function pipeline(overrides: Partial<PipelineSummary>): PipelineSummary {
  return { id: "pipeline-1", task: "Pipeline title", project: "viewer", state: "running", createdAt: "2026-07-27T09:00:00Z", closedAt: null, ...overrides };
}

function flow(overrides: Partial<FlowSummary>): FlowSummary {
  return { id: "flow-1", project: "viewer", state: "reviewing", spec: "Flow spec headline", createdAt: "2026-07-27T09:00:00Z", closedAt: null, ...overrides };
}

describe("evidence projection", () => {
  test("a task's first line is its title and its status becomes a lifecycle position", () => {
    const [inbox, done, blocked] = evidenceFromTasks([
      task({ id: "a" }),
      task({ id: "b", status: "done" }),
      task({ id: "c", status: "blocked" }),
    ]);
    expect(inbox!.title).toBe("Card title");
    expect(inbox!.state).toBe("active");
    expect(done!.state).toBe("terminal");
    expect(blocked!.state).toBe("inert");
  });

  test("a task's owner comes from its pipeline first, then its assignment", () => {
    const [byPipeline, byAssignment, unowned] = evidenceFromTasks([
      task({ id: "a", pipelineIds: ["pipeline-9"], assignments: [{ state: "delivered" }] }),
      task({ id: "b", assignments: [{ state: "spawning" }] }),
      task({ id: "c", assignments: [{ state: "failed" }] }),
    ]);
    expect(byPipeline!.owner).toBe("pipeline pipeline-9");
    expect(byAssignment!.owner).toBe("an assigned agent");
    expect(unowned!.owner).toBeNull();
  });

  test("a monitor-created card is recognized as the monitor's own", () => {
    const [item] = evidenceFromTasks([task({ text: "Surfaced request\n\nmonitor-ref: abcdef0123456789" })]);
    expect(item!.monitorRef).toBe("abcdef0123456789");
  });

  test("pipeline and flow vocabularies map onto the same three positions", () => {
    expect(evidenceFromPipelines([pipeline({ state: "running" })])[0]!.state).toBe("active");
    expect(evidenceFromPipelines([pipeline({ state: "needs_decision" })])[0]!.state).toBe("inert");
    expect(evidenceFromPipelines([pipeline({ state: "completed" })])[0]!.state).toBe("terminal");
    expect(evidenceFromFlows([flow({ state: "reviewing" })])[0]!.state).toBe("active");
    expect(evidenceFromFlows([flow({ state: "paused" })])[0]!.state).toBe("inert");
    expect(evidenceFromFlows([flow({ state: "approved" })])[0]!.state).toBe("terminal");
  });

  test("issue references travel with the item so a request naming one correlates", () => {
    const [item] = evidenceFromPipelines([pipeline({ task: "Implement #741 monitor", spec: "see also #737" })]);
    expect(item!.references).toEqual([741, 737]);
  });
});
