import { expect, mock, test } from "bun:test";

import { NextRequest } from "next/server";

const pipeline = { id: "pipeline-1" };
mock.module("@/lib/pipelines/engine", () => ({
  getPipelines: () => ({ pipelines: [pipeline] }),
  createPipelineFromRequest: () => ({ pipeline }),
  patchPipeline: async (id: string, body: unknown) => id === pipeline.id ? { pipeline: { ...pipeline, body } } : { error: "pipeline not found", status: 404 },
}));

const { DELETE, PATCH } = await import("./route");
const { registerPipelineTick } = await import("@/lib/pipelines/controllerSignal");

test("pipeline PATCH accepts the control actions including override-stage", async () => {
  let ticks = 0;
  const unregister = registerPipelineTick(async () => { ticks += 1; });
  for (const action of ["start", "update-draft", "add-stage", "remove-stage", "reorder-stage", "pause", "resume", "retry-stage", "skip-stage", "override-stage", "delete", "close"]) {
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
