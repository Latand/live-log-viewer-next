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

import { GET } from "./route";

test("the promoted capability stays closed until release startup completes", () => {
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
    expect(GET().status).toBe(503);
    markViewerReleaseReady(sandbox, activated);
    expect(GET().status).toBe(200);
  } finally {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
