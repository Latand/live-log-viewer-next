import { expect, mock, test } from "bun:test";

import { NextRequest } from "next/server";

const pipeline = { id: "pipeline-1" };
mock.module("@/lib/pipelines/engine", () => ({
  getPipelines: () => ({ pipelines: [pipeline] }),
  createPipelineFromRequest: () => ({ pipeline }),
  patchPipeline: async (id: string, body: unknown) => id === pipeline.id ? { pipeline: { ...pipeline, body } } : { error: "pipeline not found", status: 404 },
}));

const { PATCH } = await import("./route");

test("pipeline PATCH accepts the five control actions", async () => {
  for (const action of ["pause", "resume", "retry-stage", "skip-stage", "close"]) {
    const response = await PATCH(
      new NextRequest("http://127.0.0.1/api/pipelines/pipeline-1", { method: "PATCH", headers: { host: "127.0.0.1" }, body: JSON.stringify({ action }) }),
      { params: Promise.resolve({ id: "pipeline-1" }) },
    );
    expect(response.status).toBe(200);
  }
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
