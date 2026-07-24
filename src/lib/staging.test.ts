import { expect, test } from "bun:test";

import { isStagingMode, stagingReleaseRecord, STAGING_RELEASE_FILE } from "./staging";

test("isStagingMode requires the exact LLV_STAGING=1 opt-in", () => {
  expect(isStagingMode({ LLV_STAGING: "1" } as NodeJS.ProcessEnv)).toBe(true);
  expect(isStagingMode({} as NodeJS.ProcessEnv)).toBe(false);
  expect(isStagingMode({ LLV_STAGING: "0" } as NodeJS.ProcessEnv)).toBe(false);
  expect(isStagingMode({ LLV_STAGING: "true" } as NodeJS.ProcessEnv)).toBe(false);
});

test("staging release records carry the deployed revision and container pair", () => {
  const record = stagingReleaseRecord({
    revision: "b".repeat(40),
    image: `agent-log-viewer:staging-${"b".repeat(12)}`,
    endpoint: "http://127.0.0.1:8899",
    containers: { viewer: "llv-staging-viewer", runtimeHost: "llv-staging-runtime-host" },
    deployedAt: "2026-07-24T00:00:00.000Z",
  });
  expect(record.revision).toBe("b".repeat(40));
  expect(record.endpoint).toBe("http://127.0.0.1:8899");
  expect(record.containers.viewer).toBe("llv-staging-viewer");
  expect(STAGING_RELEASE_FILE).toBe("staging-release.json");
});

test("staging release records reject partial or malformed payloads", () => {
  expect(() => stagingReleaseRecord(null)).toThrow();
  expect(() => stagingReleaseRecord({ revision: "not-a-sha" })).toThrow();
  expect(() => stagingReleaseRecord({
    revision: "b".repeat(40),
    image: "agent-log-viewer:staging-b",
    endpoint: "not-a-url",
    containers: { viewer: "v", runtimeHost: "r" },
    deployedAt: "2026-07-24T00:00:00.000Z",
  })).toThrow();
  expect(() => stagingReleaseRecord({
    revision: "b".repeat(40),
    image: "agent-log-viewer:staging-b",
    endpoint: "http://127.0.0.1:8899",
    containers: { viewer: "v" },
    deployedAt: "2026-07-24T00:00:00.000Z",
  })).toThrow();
});
