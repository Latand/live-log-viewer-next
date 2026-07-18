import { expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { DELETE } from "./route";

test("DELETE rejects a body without a stable assignment handle", async () => {
  const request = new NextRequest("http://127.0.0.1/api/tasks/task-1/assignment", {
    method: "DELETE",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ path: " ", conversationId: "", panePid: null }),
  });
  const response = await DELETE(request, { params: Promise.resolve({ id: "task-1" }) });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "launchId, path, conversationId or panePid is required" });
});
