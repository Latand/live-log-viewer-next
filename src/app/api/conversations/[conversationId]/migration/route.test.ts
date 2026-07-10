import { expect, test } from "bun:test";
import { NextRequest } from "next/server";

const { POST } = await import("./route");

test("retry reaches normal migration handling", async () => {
  const request = new NextRequest("http://127.0.0.1/api/conversations/conversation_missing/migration", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ action: "retry", expectedRevision: 0 }),
  });

  const response = await POST(request, { params: Promise.resolve({ conversationId: "conversation_missing" }) });

  expect(await response.json()).toEqual({ error: "migration retry failed a recoverable preflight" });
});
