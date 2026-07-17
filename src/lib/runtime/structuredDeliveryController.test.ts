import { expect, test } from "bun:test";

import type { RuntimeHostClient } from "./client";
import { publishStructuredHostProjection } from "./structuredDeliveryController";

test("structured host projection publishes a files revision for connected viewers", async () => {
  let filesRevision = 14;
  const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const client = {
    append: async (event: { kind: string; payload: Record<string, unknown> }) => {
      events.push(event);
      if (event.kind === "files.revision") filesRevision = Number(event.payload.filesRevision);
    },
    snapshot: async () => ({ filesRevision }),
  } as unknown as RuntimeHostClient;

  await publishStructuredHostProjection(client, {
    scope: { type: "session", id: "conversation-one" },
    kind: "session-status",
    producer: { kind: "claude-broker" },
    payload: {
      conversationId: "conversation-one",
      host: "dead",
      hostKind: "unhosted",
      turn: "idle",
    },
  });

  expect(events.map((event) => event.kind)).toEqual(["session-status", "files.revision"]);
  expect(events[1]?.payload).toEqual({ filesRevision: 15 });
});
