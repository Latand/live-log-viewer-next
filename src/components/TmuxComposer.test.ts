import { expect, test } from "bun:test";

import { deliveryAttemptKey } from "./TmuxComposer";

test("a failed durable receipt retries with its original delivery key", () => {
  expect(deliveryAttemptKey("fresh-key", "held-key")).toBe("held-key");
  expect(deliveryAttemptKey("fresh-key")).toBe("fresh-key");
});
