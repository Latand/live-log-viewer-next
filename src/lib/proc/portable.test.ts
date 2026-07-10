import { expect, test } from "bun:test";

import { portableBackend } from "./portable";

test("portable process identity is stable for a live pid", () => {
  const first = portableBackend.processIdentity(process.pid);
  const second = portableBackend.processIdentity(process.pid);

  expect(first).not.toBeNull();
  expect(second).toBe(first);
});
