import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-route-"));
const { GET, POST } = await import("./route");
const { registerPipelineTick } = await import("@/lib/pipelines/controllerSignal");

afterAll(() => fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }));

test("pipeline collection route mirrors flow GET and POST shapes", async () => {
  let ticks = 0;
  const unregister = registerPipelineTick(async () => { ticks += 1; });
  expect(await (await GET()).json()).toEqual({ pipelines: [] });
  const request = new NextRequest("http://127.0.0.1/api/pipelines", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({
      task: "ship",
      repoDir: process.cwd(),
      stages: [
        { id: "build", kind: "run", prompt: "build", next: "verify" },
        { id: "verify", kind: "run", prompt: "verify", next: null },
      ],
    }),
  });
  const response = await POST(request);
  expect(response.status).toBe(201);
  const body = await response.json() as { ok: boolean; pipeline: { id: string; state: string; stages: { id: string; effectiveRole: { effort: string } }[] } };
  expect(body.ok).toBe(true);
  expect(body.pipeline.state).toBe("provisioning");
  expect(body.pipeline.stages.map((stage) => stage.id)).toEqual(["build", "verify"]);
  expect(body.pipeline.stages[0]!.effectiveRole.effort).toBe("medium");
  await Promise.resolve();
  expect(ticks).toBe(1);
  unregister();
});

test("pipeline POST returns a persisted draft id for autoStart false", async () => {
  let ticks = 0;
  const unregister = registerPipelineTick(async () => { ticks += 1; });
  const request = new NextRequest("http://127.0.0.1/api/pipelines", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({
      task: "review before start",
      repoDir: process.cwd(),
      autoStart: false,
      stages: [
        { id: "build", kind: "run", prompt: "build", next: "verify" },
        { id: "verify", kind: "run", prompt: "verify", next: null },
      ],
    }),
  });
  const response = await POST(request);
  const body = await response.json() as { ok: boolean; pipeline: { id: string; state: string } };
  expect(response.status).toBe(201);
  expect(body).toMatchObject({ ok: true, pipeline: { state: "draft" } });
  expect(body.pipeline.id.length).toBeGreaterThan(0);
  await Promise.resolve();
  expect(ticks).toBe(0);
  unregister();
});

test("pipeline POST rejects malformed JSON", async () => {
  const response = await POST(new NextRequest("http://127.0.0.1/api/pipelines", { method: "POST", headers: { host: "127.0.0.1" }, body: "{" }));
  expect(response.status).toBe(400);
});

test("pipeline POST rejects non-object JSON", async () => {
  for (const body of ["null", "[]"]) {
    const response = await POST(new NextRequest("http://127.0.0.1/api/pipelines", { method: "POST", headers: { host: "127.0.0.1" }, body }));
    expect(response.status).toBe(400);
  }
});
