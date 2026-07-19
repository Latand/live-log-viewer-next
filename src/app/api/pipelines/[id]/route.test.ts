import { expect, mock, test } from "bun:test";

import { NextRequest } from "next/server";

const pipeline = { id: "pipeline-1" };
mock.module("@/lib/pipelines/engine", () => ({
  getPipelines: () => ({ pipelines: [pipeline] }),
  createPipelineFromRequest: () => ({ pipeline }),
  tickPipelines: async () => ({ pipelines: [], changed: false }),
  patchPipeline: async (id: string, body: unknown) => {
    if (id !== pipeline.id) return { error: "pipeline not found", status: 404 };
    if ((body as { repoDir?: string }).repoDir === "/blocked") {
      return { error: "Git metadata is not writable: /blocked/.git", status: 403, code: "git_metadata_unwritable", field: "repoDir", path: "/blocked/.git" };
    }
    return { pipeline: { ...pipeline, body } };
  },
}));

const { DELETE, PATCH } = await import("./route");
const { registerPipelineTick } = await import("@/lib/pipelines/controllerSignal");

test("pipeline PATCH accepts the control actions including override-stage", async () => {
  let ticks = 0;
  const unregister = registerPipelineTick(async () => { ticks += 1; });
  for (const action of ["start", "update-draft", "set-position", "add-stage", "remove-stage", "reorder-stage", "pause", "resume", "retry-stage", "skip-stage", "override-stage", "delete", "close"]) {
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
