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

import {
  markStructuredDeliveryControllerReady,
  markStructuredDeliveryControllerUnavailable,
  markStructuredHostStartupFailed,
  markStructuredHostStartupReady,
} from "@/lib/runtime/startupStatus";

import * as incumbent from "@/runtime-host/fixtures/incumbentDeploymentHealth";

import { GET } from "./route";

test("both verifier generations wait for serving startup while passive prechecks remain available", async () => {
  const previous = { state: process.env.LLV_STATE_DIR, port: process.env.PORT, hosts: process.env.LLV_STRUCTURED_HOSTS };
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-startup-capability-"));
  process.env.LLV_STATE_DIR = sandbox;
  process.env.LLV_STRUCTURED_HOSTS = "1";
  const revision = "a".repeat(40);
  fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({
    endpoint: "http://127.0.0.1:19001", revision, hotStateBackend: HOT_STATE_BACKEND,
  }));
  const probe = async (ready: boolean, status = 200, promoted = true) => {
    const response = GET();
    const text = await response.text();
    expect(response.status).toBe(status);
    expect(JSON.parse(text).releaseReady).toBe(ready);
    expect(incumbent.viewerDeploymentReleaseReady(response.status, text)).toBe(ready);
    if (promoted) expect(viewerDeploymentReleaseReady(response.status, text)).toBe(ready);
    else expect(hasViewerDeploymentCapability(response.status, text)).toBe(true);
  };
  try {
    process.env.PORT = "19002";
    markStructuredDeliveryControllerUnavailable();
    markStructuredHostStartupFailed();
    await probe(true, 200, false);
    process.env.PORT = "19001";
    expect(GET().status).toBe(503);
    const activated = markHotStateActivationReady(sandbox, publishHotStateAuthority(sandbox, "sqlite", revision));
    markStructuredDeliveryControllerReady();
    // Restore the actual not-yet-started state, including its pending default.
    const state = process as typeof process & {
      __llvStructuredHostStartupFailed?: boolean;
      __llvStructuredHostStartupProgress?: unknown;
    };
    delete state.__llvStructuredHostStartupFailed;
    delete state.__llvStructuredHostStartupProgress;
    await probe(false); // Activation can complete before serving readiness.
    markViewerReleaseReady(sandbox, activated);
    await probe(false); // The incumbent reads releaseReady, ignoring startup.
    markStructuredHostStartupReady();
    await probe(true);
    markStructuredDeliveryControllerUnavailable();
    await probe(false, 503);
    markStructuredDeliveryControllerReady();
    markStructuredHostStartupFailed();
    await probe(false, 503);
    process.env.LLV_STRUCTURED_HOSTS = "0";
    await probe(true);
  } finally {
    for (const [key, value] of Object.entries({ LLV_STATE_DIR: previous.state, PORT: previous.port, LLV_STRUCTURED_HOSTS: previous.hosts })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    markStructuredHostStartupReady();
    markStructuredDeliveryControllerUnavailable();
  }
});
