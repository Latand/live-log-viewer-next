import { expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { POST } from "./route";

test("pipeline tick joins one coalesced reconciliation inside the live Viewer process", async () => {
  let calls = 0;
  const response = await POST.withDependencies(new NextRequest("http://127.0.0.1:8898/api/pipelines/tick", {
    method: "POST",
    headers: {
      host: "127.0.0.1:8898",
      origin: "http://127.0.0.1:8898",
      "sec-fetch-site": "same-origin",
    },
  }), async () => {
    calls += 1;
  });

  expect(response.status).toBe(202);
  expect(calls).toBe(1);
});
