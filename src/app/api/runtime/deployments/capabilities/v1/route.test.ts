import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import {
  HOT_STATE_BACKEND,
  markHotStateActivationReady,
  markViewerReleaseReady,
  publishHotStateAuthority,
} from "@/lib/state/hotStateAuthority";
import {
  hasViewerDeploymentCapability,
  viewerDeploymentReleaseReady,
} from "@/runtime-host/deploymentHealth";

import { GET } from "./route";

test("the deployed predecessor adapter can pass after activation while a new adapter waits for full startup", async () => {
  const previous = process.env.LLV_STATE_DIR;
  const previousPort = process.env.PORT;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-hot-state-capability-"));
  process.env.LLV_STATE_DIR = sandbox;
  const revision = "a".repeat(40);
  const target = {
    endpoint: "http://127.0.0.1:19001",
    revision,
    hotStateBackend: HOT_STATE_BACKEND,
  };
  try {
    fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({
      endpoint: target.endpoint,
      revision,
    }));
    process.env.PORT = "19001";
    expect(GET().status).toBe(200);
    fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify(target));
    process.env.PORT = "19002";
    expect(GET().status).toBe(200);
    process.env.PORT = "19001";
    expect(GET().status).toBe(503);
    const authority = publishHotStateAuthority(sandbox, "sqlite", revision);
    expect(GET().status).toBe(503);
    const activated = markHotStateActivationReady(sandbox, authority);
    for (let startupPoll = 0; startupPoll < 31; startupPoll += 1) {
      const predecessorResponse = GET();
      const predecessorBody = await predecessorResponse.text();
      expect(predecessorResponse.status).toBe(200);
      expect(hasViewerDeploymentCapability(predecessorResponse.status, predecessorBody)).toBe(true);
      expect(viewerDeploymentReleaseReady(predecessorResponse.status, predecessorBody)).toBe(false);
    }
    markViewerReleaseReady(sandbox, activated);
    const completeResponse = GET();
    expect(viewerDeploymentReleaseReady(completeResponse.status, await completeResponse.text())).toBe(true);
  } finally {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
