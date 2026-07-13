import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

import { createDraftPipeline } from "./pipelineModel";

/* createDraftPipeline resolves the repo from /api/spawn and POSTs a draft; it uses
   getLocale() and dispatches a window event, so it needs a browser-ish env. */
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

test("resolves the repo from /api/spawn and POSTs an EMPTY autoStart:false draft (#136)", async () => {
  const requests: Array<{ url: string; body?: unknown }> = [];
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    if (url.startsWith("/api/spawn")) return { ok: true, json: async () => ({ cwd: "/home/me/repo", dirs: ["/home/me/repo"] }) };
    return { ok: true, json: async () => ({ pipeline: { id: "p9" } }) };
  }) as unknown as typeof fetch;

  const result = await createDraftPipeline("demo");
  expect(result.pipeline?.id).toBe("p9");
  const post = requests.find((request) => request.url === "/api/pipelines");
  const body = post?.body as { autoStart?: boolean; repoDir?: string; stages?: unknown[] };
  expect(body?.autoStart).toBe(false);
  expect(body?.repoDir).toBe("/home/me/repo");
  /* The draft is created EMPTY (#136 recast) — the operator assembles stages on
     the canvas; the 2-stage floor is enforced only at Start. */
  expect(body?.stages).toEqual([]);
});

test("prefers an explicit repo prefill over the spawn lookup (#136)", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (url: string) => {
    requests.push(url);
    return { ok: true, json: async () => ({ pipeline: { id: "p10" } }) };
  }) as unknown as typeof fetch;

  const result = await createDraftPipeline("demo", "/explicit/repo");
  expect(result.pipeline?.id).toBe("p10");
  /* With a prefill it must not consult /api/spawn at all. */
  expect(requests.some((url) => url.startsWith("/api/spawn"))).toBe(false);
});

test("surfaces an error and never POSTs when no repo can be resolved (#136)", async () => {
  let posted = false;
  globalThis.fetch = (async (url: string) => {
    if (url.startsWith("/api/spawn")) return { ok: true, json: async () => ({ cwd: null, dirs: [] }) };
    posted = true;
    return { ok: true, json: async () => ({ pipeline: { id: "x" } }) };
  }) as unknown as typeof fetch;

  const result = await createDraftPipeline("demo");
  expect(result.pipeline).toBeUndefined();
  expect(result.error).toBeTruthy();
  expect(posted).toBe(false);
});
