import { expect, test } from "bun:test";

import { NextRequest } from "next/server";

import { RuntimeHostUnavailableError, type RuntimeHostClient } from "./client";
import { handleRuntimeCommand } from "./http";

function request(body: unknown, headers: Record<string, string> = { host: "127.0.0.1" }): NextRequest {
  return new NextRequest("http://127.0.0.1/api/runtime/send", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("runtime command HTTP handling preserves validation, CSRF, status, and conflict contracts", async () => {
  const commands: unknown[] = [];
  const client = {
    command: async (command: unknown) => {
      commands.push(command);
      return {
        operationId: "op-one",
        replayed: false,
        receipt: {
          operationId: "op-one",
          idempotencyKey: "send-one",
          conversationId: "conv-one",
          kind: "send" as const,
          status: "pending" as const,
          at: "2026-07-10T00:00:00.000Z",
          revision: 1,
        },
      };
    },
  } as unknown as RuntimeHostClient;
  const deps = { enabled: () => true, client: () => client };

  const accepted = await handleRuntimeCommand(request({ conversationId: "conv-one", text: "continue", idempotencyKey: "send-one" }), "send", deps);
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toMatchObject({ operationId: "op-one", receipt: { status: "pending" } });
  expect(commands).toHaveLength(1);

  const malformed = await handleRuntimeCommand(request({ conversationId: "conv-one", text: "", idempotencyKey: "send-one" }), "send", deps);
  expect(malformed.status).toBe(400);

  const forbidden = await handleRuntimeCommand(request({ conversationId: "conv-one", text: "continue", idempotencyKey: "send-one" }, { host: "evil.example", origin: "https://evil.example" }), "send", deps);
  expect(forbidden.status).toBe(403);

  const conflictClient = { command: async () => { throw new RuntimeHostUnavailableError("conflict", "idempotency-conflict"); } } as unknown as RuntimeHostClient;
  const conflict = await handleRuntimeCommand(request({ conversationId: "conv-one", text: "continue", idempotencyKey: "send-one" }), "send", { enabled: () => true, client: () => conflictClient });
  expect(conflict.status).toBe(409);
});
