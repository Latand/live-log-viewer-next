import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { viewerComposeSnapshotPath } from "@/runtime-host/deploymentArtifacts";

import { VIEWER_CONTROL_TOKEN_ENV, viewerControlOrigin, viewerControlToken } from "./controlEndpoint";

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

/* #1511: #1496 made the Viewer authenticate every connection once a token is
   configured, so a control client that sends nothing is refused like a
   stranger. Agent processes are launched with LLV_TOKEN unset on purpose, and
   the credential is resolved from the operator-only state that already names
   the control origin. */

function sandbox(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "llv-control-token-"));
}

function releaseState(
  directory: string,
  options: { endpoint: string; container?: string; token?: string },
): string {
  const stateDir = path.join(directory, "state");
  const container = options.container ?? "viewer-fixture";
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "viewer-release.json"), JSON.stringify({
    revision: "a".repeat(40),
    image: "viewer:fixture",
    container,
    endpoint: options.endpoint,
  }));
  if (options.token !== undefined) {
    const snapshot = viewerComposeSnapshotPath(stateDir, container);
    fs.mkdirSync(path.dirname(snapshot), { recursive: true });
    fs.writeFileSync(snapshot, JSON.stringify({
      services: { viewer: { environment: { LLV_TOKEN: options.token } } },
    }));
  }
  return stateDir;
}

test("an agent environment with no token of its own carries the running Viewer's key", () => {
  const directory = sandbox();
  try {
    const stable = "http://127.0.0.1:19011";
    const stateDir = releaseState(directory, { endpoint: "http://127.0.0.1:19012", token: "release-key" });
    expect(viewerControlToken({
      LLV_STATE_DIR: stateDir,
      XDG_CONFIG_HOME: directory,
      LLV_VIEWER_PORT: "19011",
    }, stable)).toBe("release-key");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a probe pinned to a candidate carries the credential it was given, not the incumbent's", () => {
  const directory = sandbox();
  try {
    const candidate = "http://127.0.0.1:19013";
    const stateDir = releaseState(directory, { endpoint: "http://127.0.0.1:19014", token: "release-key" });
    expect(viewerControlToken({
      [VIEWER_CONTROL_TOKEN_ENV]: "pinned-key",
      LLV_STATE_DIR: stateDir,
      XDG_CONFIG_HOME: directory,
      LLV_VIEWER_CONTROL_URL: candidate,
      LLV_VIEWER_DEPLOY_TARGET: path.join(stateDir, "viewer-release.json"),
    }, candidate)).toBe("pinned-key");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a Viewer started outside a deployment is reached with the machine's own key", () => {
  const directory = sandbox();
  try {
    const keyFile = path.join(directory, "agent-log-viewer", "token");
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, "machine-key\n", { mode: 0o600 });
    expect(viewerControlToken({
      XDG_CONFIG_HOME: directory,
      LLV_VIEWER_PORT: "19015",
    }, "http://127.0.0.1:19015")).toBe("machine-key");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a Viewer with no token configured is still reached with a bare request", () => {
  const directory = sandbox();
  try {
    const stateDir = releaseState(directory, { endpoint: "http://127.0.0.1:19016" });
    expect(viewerControlToken({
      LLV_STATE_DIR: stateDir,
      XDG_CONFIG_HOME: directory,
      LLV_VIEWER_PORT: "19016",
    }, "http://127.0.0.1:19016")).toBeNull();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("no ambient key travels to an endpoint the release state does not name", () => {
  const directory = sandbox();
  try {
    const stranger = "http://127.0.0.1:19017";
    const stateDir = releaseState(directory, { endpoint: "http://127.0.0.1:19018", token: "release-key" });
    expect(viewerControlToken({
      LLV_STATE_DIR: stateDir,
      XDG_CONFIG_HOME: directory,
      LLV_TOKEN: "release-key",
      LLV_VIEWER_CONTROL_URL: stranger,
      LLV_VIEWER_DEPLOY_TARGET: path.join(stateDir, "viewer-release.json"),
      LLV_VIEWER_PORT: "19018",
    }, stranger)).toBeNull();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a client pinned by a partial release environment reads no ambient state at all", () => {
  const endpoint = "http://127.0.0.1:19019";
  const readFile = spyOn(fs, "readFileSync").mockImplementation(() => {
    throw new Error("ambient state was read for a credential");
  });
  try {
    expect(viewerControlToken({ LLV_VIEWER_CONTROL_URL: endpoint }, endpoint)).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  } finally {
    readFile.mockRestore();
  }
});

/* The Viewer parses its header with `/^Bearer\s+(.+)$/i`, so a key holding an
   internal space authenticates against the running release. A client that
   discarded such a key would send nothing and be refused 403 — #1511's own
   failure moved one layer along. Only a value that cannot travel in a header
   is absent. */

const SPACED = "release key with spaces";

test("a key the Viewer authenticates survives every resolver path when it holds a space", () => {
  const directory = sandbox();
  try {
    const endpoint = "http://127.0.0.1:19020";
    const stateDir = releaseState(directory, { endpoint, token: SPACED });
    expect(viewerControlToken({
      LLV_STATE_DIR: stateDir,
      XDG_CONFIG_HOME: directory,
      LLV_VIEWER_PORT: "19020",
    }, endpoint)).toBe(SPACED);
    expect(viewerControlToken({ [VIEWER_CONTROL_TOKEN_ENV]: SPACED }, endpoint)).toBe(SPACED);

    const keyFile = path.join(directory, "agent-log-viewer", "token");
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, `  ${SPACED}  `, { mode: 0o600 });
    expect(viewerControlToken({
      XDG_CONFIG_HOME: directory,
      LLV_VIEWER_PORT: "19021",
    }, "http://127.0.0.1:19021")).toBe(SPACED);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a key that cannot travel in a header still counts as absent", () => {
  const directory = sandbox();
  try {
    const endpoint = "http://127.0.0.1:19022";
    /* Built from character codes on purpose: a real control byte written into
       this file would be invisible to everyone reading it. CR, LF, NUL, VT and
       DEL are all outside the field-vchar an HTTP header value is made of. */
    for (const code of [0x0d, 0x0a, 0x00, 0x0b, 0x7f]) {
      const unsendable = `release${String.fromCharCode(code)}key`;
      const stateDir = releaseState(directory, { endpoint, token: unsendable });
      expect(viewerControlToken({
        LLV_STATE_DIR: stateDir,
        XDG_CONFIG_HOME: directory,
        LLV_TOKEN: unsendable,
        LLV_VIEWER_PORT: "19022",
      }, endpoint)).toBeNull();
      expect(viewerControlToken({ [VIEWER_CONTROL_TOKEN_ENV]: unsendable }, endpoint)).toBeNull();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
