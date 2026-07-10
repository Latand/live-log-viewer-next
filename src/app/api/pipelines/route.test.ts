import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-route-"));
const { GET, POST } = await import("./route");

afterAll(() => fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }));

test("pipeline collection route mirrors flow GET and POST shapes", async () => {
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
  const body = await response.json() as { ok: boolean; pipeline: { id: string; stages: { id: string; effectiveRole: { effort: string } }[] } };
  expect(body.ok).toBe(true);
  expect(body.pipeline.stages.map((stage) => stage.id)).toEqual(["build", "verify"]);
  expect(body.pipeline.stages[0]!.effectiveRole.effort).toBe("medium");
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
