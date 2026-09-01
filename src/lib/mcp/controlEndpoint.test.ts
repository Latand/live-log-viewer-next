import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { viewerControlOrigin } from "./controlEndpoint";

function releaseTarget(directory: string, endpoint: string): string {
  const filename = path.join(directory, "viewer-release.json");
  fs.writeFileSync(filename, JSON.stringify({
    revision: "a".repeat(40),
    image: "viewer:fixture",
    container: "viewer-fixture",
    endpoint,
  }));
  return filename;
}

test("a durable client carrying a retired launch URL resolves the stable Viewer listener", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-control-endpoint-"));
  try {
    const target = releaseTarget(directory, "http://127.0.0.1:19001");
    expect(viewerControlOrigin({
      LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:18001",
      LLV_VIEWER_DEPLOY_TARGET: target,
      LLV_VIEWER_PORT: "8898",
    })).toBe("http://127.0.0.1:8898");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an admitted candidate health probe keeps its exact endpoint before promotion", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-control-candidate-"));
  try {
    const endpoint = "http://127.0.0.1:19002";
    const target = releaseTarget(directory, "http://127.0.0.1:18002");
    expect(viewerControlOrigin({
      LLV_VIEWER_CONTROL_URL: endpoint,
      LLV_VIEWER_DEPLOY_TARGET: target,
      LLV_VIEWER_PORT: "8898",
    }, true)).toBe(endpoint);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an explicit development endpoint stays authoritative without a release target", () => {
  expect(viewerControlOrigin({
    LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:19003",
    LLV_VIEWER_DEPLOY_TARGET: "missing-fixture-target.json",
  })).toBe("http://127.0.0.1:19003");
});

test("an explicit endpoint with no release environment never reads ambient release state", () => {
  const endpoint = "http://127.0.0.1:19004";
  const readFile = spyOn(fs, "readFileSync").mockImplementation(() => {
    throw new Error("ambient release state was read");
  });
  try {
    expect(viewerControlOrigin({ LLV_VIEWER_CONTROL_URL: endpoint })).toBe(endpoint);
    expect(readFile).not.toHaveBeenCalled();
  } finally {
    readFile.mockRestore();
  }
});

test("every partial release environment stays pinned to its explicit endpoint", () => {
  const endpoint = "http://127.0.0.1:19005";
  const readFile = spyOn(fs, "readFileSync").mockImplementation(() => {
    throw new Error("partial release state was read");
  });
  try {
    for (const partial of [
      { LLV_VIEWER_DEPLOY_TARGET: "fixture-target.json" },
      { LLV_VIEWER_PORT: "19006" },
      { LLV_STATE_DIR: "fixture-state", LLV_VIEWER_PORT: "19006" },
    ]) {
      expect(viewerControlOrigin({ LLV_VIEWER_CONTROL_URL: endpoint, ...partial })).toBe(endpoint);
    }
    expect(readFile).not.toHaveBeenCalled();
  } finally {
    readFile.mockRestore();
  }
});

test("a malformed release target fails loudly instead of preserving a stale launch URL", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-control-invalid-target-"));
  try {
    const target = path.join(directory, "viewer-release.json");
    fs.writeFileSync(target, "{}");
    expect(() => viewerControlOrigin({
      LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:18004",
      LLV_VIEWER_DEPLOY_TARGET: target,
      LLV_VIEWER_PORT: "8898",
    })).toThrow("Viewer release target is invalid");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
