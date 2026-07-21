import { expect, test } from "bun:test";

import {
  currentRuntimeHostGeneration,
  RUNTIME_HOST_CONTAINER_ENV,
  RUNTIME_HOST_IMAGE_ENV,
  RUNTIME_HOST_REVISION_ENV,
  type RuntimeHostReleaseRecord,
} from "./hostRelease";

const record: RuntimeHostReleaseRecord = {
  image: "agent-log-viewer:deploy-candidate",
  revision: "b".repeat(40),
  container: "llv-runtime-host-bbbbbbbbbbbb",
  endpoint: "http://127.0.0.1:8898",
  stagedAt: "2026-07-21T09:00:00.000Z",
};

test("issue 518: a process claims the durable generation only with matching container identity", () => {
  expect(currentRuntimeHostGeneration({
    NODE_ENV: "test",
    [RUNTIME_HOST_IMAGE_ENV]: record.image,
    [RUNTIME_HOST_REVISION_ENV]: record.revision,
    [RUNTIME_HOST_CONTAINER_ENV]: record.container,
  }, record)).toEqual({ image: record.image, revision: record.revision });
});

test("issue 518: a predecessor cannot claim the successor release record", () => {
  expect(currentRuntimeHostGeneration({ NODE_ENV: "test" }, record)).toEqual({ image: null, revision: null });
  expect(currentRuntimeHostGeneration({
    NODE_ENV: "test",
    [RUNTIME_HOST_IMAGE_ENV]: "agent-log-viewer:stale",
    [RUNTIME_HOST_REVISION_ENV]: record.revision,
    [RUNTIME_HOST_CONTAINER_ENV]: record.container,
  }, record)).toEqual({ image: null, revision: null });
});
