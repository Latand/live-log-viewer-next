import { expect, test } from "bun:test";

import { registerPipelineTick, requestPipelineTick, requestRemotePipelineTick } from "./controllerSignal";

test("pipeline controller signals coalesce concurrent requests", async () => {
  let calls = 0;
  const unregister = registerPipelineTick(async () => { calls += 1; });

  requestPipelineTick();
  requestPipelineTick();
  await Promise.resolve();
  await Promise.resolve();

  expect(calls).toBe(1);
  unregister();
});

test("the standalone controller signal targets the live Viewer process", async () => {
  const requests: Array<{ url: string; method: string | undefined }> = [];
  await requestRemotePipelineTick(async (input, init) => {
    requests.push({ url: String(input), method: init?.method });
    return new Response(JSON.stringify({ ok: true }), { status: 202 });
  }, { LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:19000" });

  expect(requests).toEqual([{
    url: "http://127.0.0.1:19000/api/pipelines/tick",
    method: "POST",
  }]);
});
