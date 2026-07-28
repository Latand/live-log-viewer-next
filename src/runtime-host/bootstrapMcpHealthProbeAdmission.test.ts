import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { withBootstrapMcpHealthProbeAdmission } from "./bootstrapMcpHealthProbeAdmission";
import { RuntimeHostFence } from "./host";

test("bootstrap admission cannot replace the canonical runtime host owner", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-bootstrap-owner-"));
  const socketPath = path.join(sandbox, "runtime-host.sock");
  const fence = new RuntimeHostFence(`${socketPath}.lock`);
  fs.writeFileSync(socketPath, "owned-by-runtime-host");
  fence.acquire();
  let called = false;

  try {
    await expect(withBootstrapMcpHealthProbeAdmission(socketPath, async () => {
      called = true;
    })).rejects.toThrow("runtime host singleton fence is held");
    expect(called).toBe(false);
    expect(fs.readFileSync(socketPath, "utf8")).toBe("owned-by-runtime-host");
  } finally {
    fence.release();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
