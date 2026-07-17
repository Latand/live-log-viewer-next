import { expect, test } from "bun:test";

import { portableBackend } from "./portable";

test("portable process identity fails closed without a high-resolution kernel token", () => {
  const first = portableBackend.processIdentity(process.pid);
  const second = portableBackend.processIdentity(process.pid);

  if (process.platform === "darwin") {
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  } else {
    expect(first).toBeNull();
    expect(second).toBeNull();
  }
});
