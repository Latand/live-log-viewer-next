import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";

import { GroupOverridePanel, resetRuntimeForEngine } from "./GroupOverridePanel";
import type { SchemeGroup } from "./layout";

const noop = () => undefined;

test("resetRuntimeForEngine clears the model and normalizes effort on an engine switch (issue #118 review F2)", () => {
  /* codex→claude: model always cleared; a claude-valid effort survives. */
  {
    const calls: Record<string, string> = {};
    resetRuntimeForEngine("claude", {
      setEngine: (e) => (calls.engine = e),
      setModel: (m) => (calls.model = m),
      setEffort: (e) => (calls.effort = e),
      effort: "high",
    });
    expect(calls.engine).toBe("claude");
    expect(calls.model).toBe("");
    expect("effort" in calls).toBe(false); // high is valid for claude — kept
  }
  /* claude(max)→codex: model cleared AND the codex-invalid max effort reset. */
  {
    const calls: Record<string, string> = {};
    resetRuntimeForEngine("codex", {
      setEngine: (e) => (calls.engine = e),
      setModel: (m) => (calls.model = m),
      setEffort: (e) => (calls.effort = e),
      effort: "max",
    });
    expect(calls.engine).toBe("codex");
    expect(calls.model).toBe("");
    expect(calls.effort).toBe(""); // max is invalid for codex — cleared
  }
});

const flow = {
  id: "f1",
  roles: {
    implementer: { engine: "claude", model: "opus", effort: "high" },
    reviewer: { engine: "codex", model: "gpt-5.6", effort: "xhigh" },
  },
  roundLimit: 5,
  state: "needs_decision",
  rounds: [{ n: 1, readyNote: "focus on error handling" }],
} as unknown as Flow;

const flowGroup: SchemeGroup = {
  key: "group::flow::f1", kind: "flow", id: "f1", hue: 210, members: ["/impl"],
  label: "Flow one", x: 0, y: 0, w: 10, h: 10, flow,
};

const pipeline = {
  id: "p1",
  task: "Ship pipelines",
  state: "running",
  stages: [
    { id: "plan", kind: "run", role: { roleId: "architect" }, prompt: "Plan it", next: "build", effectiveRole: { engine: "claude", model: "fable", effort: "high", access: "read-only", roleId: "architect", promptScaffold: null } },
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build it", next: null, effectiveRole: { engine: "codex", model: "gpt-5.6", effort: "medium", access: "read-write", roleId: "builder", promptScaffold: null } },
  ],
  runs: [
    { stageId: "plan", attempts: [{ agentPath: "/plan", state: "running" }] },
    { stageId: "build", attempts: [] },
  ],
} as unknown as Pipeline;

const pipelineGroup: SchemeGroup = {
  key: "group::pipeline::p1", kind: "pipeline", id: "p1", hue: 24, members: ["/plan"],
  label: "Pipe one", x: 0, y: 0, w: 10, h: 10, pipeline,
};

test("the flow override panel exposes next-reviewer role, note, rounds and lifecycle controls", () => {
  const html = renderToStaticMarkup(<GroupOverridePanel group={flowGroup} onClose={noop} />);
  expect(html).toContain('data-group-override="flow"');
  /* Change next-stage model/effort/engine (reseat the reviewer). */
  expect(html).toContain("Next reviewer");
  expect(html).toContain("Update reviewer");
  expect(html).toContain("<option");
  expect(html).toContain("codex");
  /* Edit the next-round prompt note, seeded from the last round's ready note. */
  expect(html).toContain("focus on error handling");
  /* Extend / limit rounds. */
  expect(html).toContain("+1 round");
  expect(html).toContain("Round limit");
  /* needs_decision surfaces retry-round; close is always present. */
  expect(html).toContain("Retry round");
  expect(html).toContain("Close");
});

test("the pipeline override panel edits the next unstarted stage and keeps stage controls", () => {
  const html = renderToStaticMarkup(<GroupOverridePanel group={pipelineGroup} onClose={noop} />);
  expect(html).toContain('data-group-override="pipeline"');
  /* The upcoming (zero-attempt) stage is editable: role + prompt + model + apply. */
  expect(html).toContain("Next stage");
  expect(html).toContain("Role");
  expect(html).toContain("No role");
  /* Role options are offered and deployer is excluded (pipeline-disallowed). */
  expect(html).toContain(">architect<");
  expect(html).not.toContain(">deployer<");
  expect(html).toContain("Stage prompt");
  expect(html).toContain("Build it");
  expect(html).toContain("Update stage");
  /* The already-running "plan" stage must not be offered for override. */
  expect(html).not.toContain("Plan it");
  /* Lifecycle controls remain. */
  expect(html).toContain("Pause");
  expect(html).toContain("Close");
});

test("a pipeline with every stage started shows the no-editable-stage message", () => {
  const started = {
    ...pipeline,
    runs: [
      { stageId: "plan", attempts: [{ agentPath: "/plan", state: "running" }] },
      { stageId: "build", attempts: [{ agentPath: "/build", state: "running" }] },
    ],
  } as unknown as Pipeline;
  const html = renderToStaticMarkup(
    <GroupOverridePanel group={{ ...pipelineGroup, pipeline: started }} onClose={noop} />,
  );
  expect(html).toContain("No upcoming stage to edit");
  expect(html).not.toContain("Update stage");
});
