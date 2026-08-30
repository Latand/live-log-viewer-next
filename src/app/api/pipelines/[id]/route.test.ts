import { expect, mock, test } from "bun:test";

import { NextRequest } from "next/server";

const pipeline = {
  id: "pipeline-1",
  task: "read one pipeline",
  spec: "Return the full durable record.",
  stages: [{ id: "build", kind: "run", prompt: "Build the route", next: null }],
  runs: [{
    stageId: "build",
    attempts: [{ attempt: 1, input: "Implement", output: "Complete", verdict: { status: "pass", findings: [] } }],
  }],
};
const closeReport = {
  stopped: [{ stageId: "build", attempt: 1, conversationId: "conversation_stage_1", agentPath: null, paneId: null }],
  alreadyStopped: [],
  unconfirmed: [],
  acknowledged: [],
  reviewers: [],
  stillRunning: [],
  worktree: { dir: "/repo-pipeline-1", uncommitted: ["notes.md"], truncated: false },
};
const refusedClose = {
  ...closeReport,
  stopped: [],
  stillRunning: [{ stageId: "build", attempt: 1, conversationId: "conversation_stage_1", agentPath: null, paneId: null, error: "host is unreachable" }],
};
mock.module("@/lib/pipelines/engine", () => ({
  getPipelines: () => ({ pipelines: [pipeline] }),
  getPipeline: (id: string) => {
    if (id === "pipeline-unreadable") throw new Error("pipeline registry unreadable");
    return id === pipeline.id ? pipeline : null;
  },
  createPipelineFromRequest: () => ({ pipeline }),
  tickPipelines: async () => ({ pipelines: [], changed: false }),
  patchPipeline: async (id: string, body: unknown) => {
    if (id !== pipeline.id) return { error: "pipeline not found", status: 404 };
    if ((body as { repoDir?: string }).repoDir === "/blocked") {
      return { error: "Git metadata is not writable: /blocked/.git", status: 403, code: "git_metadata_unwritable", field: "repoDir", path: "/blocked/.git" };
    }
    if ((body as { action?: string }).action === "close") {
      if ((body as { stageId?: string }).stageId === "stuck") {
        return { error: "could not stop stage build attempt 1", status: 409, close: refusedClose };
      }
      return { pipeline: { ...pipeline, body }, close: closeReport };
    }
    return { pipeline: { ...pipeline, body } };
  },
}));

const { DELETE, GET, PATCH } = await import("./route");
const { GET: GET_COLLECTION } = await import("../route");
const { registerPipelineTick } = await import("@/lib/pipelines/controllerSignal");

test("pipeline GET returns the full record for a known id", async () => {
  const response = await GET(
    new NextRequest("http://127.0.0.1/api/pipelines/pipeline-1"),
    { params: Promise.resolve({ id: "pipeline-1" }) },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, pipeline });
});

test("pipeline GET returns 404 for an unknown id", async () => {
  const response = await GET(
    new NextRequest("http://127.0.0.1/api/pipelines/pipeline-missing"),
    { params: Promise.resolve({ id: "pipeline-missing" }) },
  );
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "pipeline not found" });
});

test("pipeline GET record matches the same id in the collection response", async () => {
  const collection = await (await GET_COLLECTION()).json() as { pipelines: Array<{ id: string }> };
  const response = await GET(
    new NextRequest("http://127.0.0.1/api/pipelines/pipeline-1"),
    { params: Promise.resolve({ id: "pipeline-1" }) },
  );
  const body = await response.json() as { pipeline: unknown };
  expect(body.pipeline).toEqual(collection.pipelines.find((candidate) => candidate.id === pipeline.id));
});

test("pipeline GET returns 500 when the registry is unreadable", async () => {
  const response = await GET(
    new NextRequest("http://127.0.0.1/api/pipelines/pipeline-unreadable"),
    { params: Promise.resolve({ id: "pipeline-unreadable" }) },
  );
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "pipeline registry unreadable" });
});

test("pipeline PATCH accepts control and task-link actions", async () => {
  let ticks = 0;
  const unregister = registerPipelineTick(async () => { ticks += 1; });
  for (const action of ["start", "update-draft", "set-position", "add-stage", "remove-stage", "reorder-stage", "set-edge", "pause", "resume", "retry-stage", "skip-stage", "override-stage", "link-task", "unlink-task", "set-src", "delete", "close"]) {
    const response = await PATCH(
      new NextRequest("http://127.0.0.1/api/pipelines/pipeline-1", { method: "PATCH", headers: { host: "127.0.0.1" }, body: JSON.stringify({ action }) }),
      { params: Promise.resolve({ id: "pipeline-1" }) },
    );
    expect(response.status).toBe(200);
    await Promise.resolve();
  }
  expect(ticks).toBe(4);
  unregister();
});

test("pipeline DELETE discards a draft through the delete action", async () => {
  const response = await DELETE(
    new NextRequest("http://127.0.0.1/api/pipelines/pipeline-1", { method: "DELETE", headers: { host: "127.0.0.1" } }),
    { params: Promise.resolve({ id: "pipeline-1" }) },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, pipeline: { ...pipeline, body: { action: "delete" } } });
});

test("pipeline close forwards its host-teardown report on success and on refusal (#670)", async () => {
  const response = await PATCH(
    new NextRequest("http://127.0.0.1/api/pipelines/pipeline-1", { method: "PATCH", headers: { host: "127.0.0.1" }, body: JSON.stringify({ action: "close" }) }),
    { params: Promise.resolve({ id: "pipeline-1" }) },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, close: closeReport });

  const refused = await PATCH(
    new NextRequest("http://127.0.0.1/api/pipelines/pipeline-1", { method: "PATCH", headers: { host: "127.0.0.1" }, body: JSON.stringify({ action: "close", stageId: "stuck" }) }),
    { params: Promise.resolve({ id: "pipeline-1" }) },
  );
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: "could not stop stage build attempt 1", close: refusedClose });
});

test("pipeline PATCH rejects unknown actions", async () => {
  const response = await PATCH(
    new NextRequest("http://127.0.0.1/api/pipelines/pipeline-1", { method: "PATCH", headers: { host: "127.0.0.1" }, body: JSON.stringify({ action: "branch" }) }),
    { params: Promise.resolve({ id: "pipeline-1" }) },
  );
  expect(response.status).toBe(400);
});

test("pipeline PATCH rejects non-object JSON", async () => {
  for (const body of ["null", "[]"]) {
    const response = await PATCH(
      new NextRequest("http://127.0.0.1/api/pipelines/pipeline-1", { method: "PATCH", headers: { host: "127.0.0.1" }, body }),
      { params: Promise.resolve({ id: "pipeline-1" }) },
    );
    expect(response.status).toBe(400);
  }
});

test("pipeline PATCH forwards repository-admission fields from final revalidation", async () => {
  const response = await PATCH(
    new NextRequest("http://127.0.0.1/api/pipelines/pipeline-1", {
      method: "PATCH",
      headers: { host: "127.0.0.1" },
      body: JSON.stringify({ action: "update-draft", repoDir: "/blocked" }),
    }),
    { params: Promise.resolve({ id: "pipeline-1" }) },
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: "Git metadata is not writable: /blocked/.git",
    code: "git_metadata_unwritable",
    field: "repoDir",
    path: "/blocked/.git",
  });
});

test("pipeline close forwards the operator's host acknowledgement to the engine (#670)", async () => {
  const response = await PATCH(
    new NextRequest("http://127.0.0.1/api/pipelines/pipeline-1", {
      method: "PATCH",
      headers: { host: "127.0.0.1" },
      body: JSON.stringify({ action: "close", acknowledgeHosts: true }),
    }),
    { params: Promise.resolve({ id: "pipeline-1" }) },
  );
  expect(response.status).toBe(200);
  /* The dismissal has to survive the route, or the operator's only way out of
     an unidentifiable pane never reaches the close. */
  expect(await response.json()).toMatchObject({
    ok: true,
    pipeline: { body: { action: "close", acknowledgeHosts: true } },
  });
});
