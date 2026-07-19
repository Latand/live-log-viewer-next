import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

import { PIPELINE_TEMPLATES, createDraftPipeline } from "./pipelineModel";

/* createDraftPipeline posts a preflight-approved repository as a draft. */
const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Event: dom.Event,
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("POSTs an autoStart:false draft seeded with the default implement action (#353)", async () => {
  const requests: Array<{ url: string; body?: unknown }> = [];
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    return { ok: true, json: async () => ({ pipeline: { id: "p9" } }) };
  }) as unknown as typeof fetch;

  const result = await createDraftPipeline("demo", "/home/me/repo");
  expect(result.pipeline?.id).toBe("p9");
  const post = requests.find((request) => request.url === "/api/pipelines");
  const body = post?.body as { autoStart?: boolean; repoDir?: string; stages?: unknown[] };
  expect(body?.autoStart).toBe(false);
  expect(body?.repoDir).toBe("/home/me/repo");
  expect(requests.map((request) => request.url)).toEqual(["/api/pipelines"]);
  /* Every fresh draft carries the default implement action (#353) — no empty
     shell ever reaches the board; the 1-stage floor is enforced at Start. */
  expect(body?.stages).toEqual([{ id: "implement", kind: "run", role: { roleId: "builder" }, prompt: "{{task}}", next: null }]);
});

test("uses the explicit canonical repo prefill", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (url: string) => {
    requests.push(url);
    return { ok: true, json: async () => ({ pipeline: { id: "p10" } }) };
  }) as unknown as typeof fetch;

  const result = await createDraftPipeline("demo", "/explicit/repo");
  expect(result.pipeline?.id).toBe("p10");
  expect(requests.some((url) => url.startsWith("/api/spawn"))).toBe(false);
});

test("surfaces an error and never fetches when the preflight repo is absent", async () => {
  let posted = false;
  globalThis.fetch = (async () => {
    posted = true;
    return { ok: true, json: async () => ({ pipeline: { id: "x" } }) };
  }) as unknown as typeof fetch;

  const result = await createDraftPipeline("demo");
  expect(result.pipeline).toBeUndefined();
  expect(result.error).toBeTruthy();
  expect(posted).toBe(false);
});

test("a template POSTs the draft WITH the template's full role chain (#196 template-first)", async () => {
  const requests: Array<{ url: string; body?: unknown }> = [];
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    return { ok: true, json: async () => ({ pipeline: { id: "p11" } }) };
  }) as unknown as typeof fetch;

  const template = PIPELINE_TEMPLATES.find((candidate) => candidate.id === "planBuildReview")!;
  const result = await createDraftPipeline("demo", "/home/me/repo", template);
  expect(result.pipeline?.id).toBe("p11");
  const post = requests.find((request) => request.url === "/api/pipelines");
  const body = post?.body as { autoStart?: boolean; stages?: Array<{ kind: string; role?: { roleId: string }; next: string | null }> };
  /* Still a DRAFT — nothing spawns; but every role stage is already in the plan,
     so the canvas renders the whole chain as placeholders immediately. */
  expect(body?.autoStart).toBe(false);
  expect(body?.stages?.map((s) => s.role?.roleId)).toEqual(["architect", "builder", "reviewer"]);
  expect(body?.stages?.map((s) => s.kind)).toEqual(["run", "run", "review-loop"]);
  expect(body?.stages?.at(-1)?.next).toBeNull();
});
