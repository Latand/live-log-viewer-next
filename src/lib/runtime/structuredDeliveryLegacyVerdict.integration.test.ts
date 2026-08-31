import { expect, test } from "bun:test";

import {
  createFailedLegacyBufferProjection,
  FAILED_LEGACY_BUFFER_IDENTIFIER,
} from "./fixtures/failedLegacyBufferProjection";
import { hasStructuredDeliveryHost } from "./structuredDeliveryController";

test("a failed legacy pane-buffer delivery retains one live running runtime verdict", async () => {
  const fixture = await createFailedLegacyBufferProjection();
  try {
    expect(fixture.failedDelivery).toMatchObject({
      ok: false,
      outcome: "failed",
      error: "Pane buffer unreadable — message was not sent.",
    });
    expect(JSON.stringify(fixture.failedDelivery)).not.toContain(FAILED_LEGACY_BUFFER_IDENTIFIER);

    const sessions = fixture.snapshot.sessions
      .filter((session) => session.conversationId === fixture.conversationId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      hostKind: "tmux-legacy",
      host: "hosted",
      turn: "running",
      provenance: "derived",
    });
    expect(hasStructuredDeliveryHost(fixture.key)).toBeFalse();
  } finally {
    await fixture.dispose();
  }
});
