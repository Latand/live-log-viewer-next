import { expect, test } from "bun:test";

import { kickStructuredDeliveryQueue, setStructuredDeliveryKick } from "./structuredDeliverySignal";

test("route bundle realms observe the process-owned delivery kick", async () => {
  let calls = 0;
  setStructuredDeliveryKick(() => { calls += 1; });
  try {
    delete (globalThis as typeof globalThis & { __llvStructuredDeliveryKick?: unknown })
      .__llvStructuredDeliveryKick;
    await kickStructuredDeliveryQueue();
    expect(calls).toBe(1);
  } finally {
    setStructuredDeliveryKick(null);
  }
});
