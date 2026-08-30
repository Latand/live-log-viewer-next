import { expect, test } from "bun:test";
import path from "node:path";

import {
  defaultRuntimeHostEndpoint,
  isNamedPipePath,
  runtimeHostEndpoint,
  runtimeHostFencePath,
} from "./localEndpoint";

const STATE_POSIX = "/home/user/.config/agent-log-viewer/state";
const STATE_WIN = "C:\\profile\\.config\\agent-log-viewer\\state";
const INSTALL = "0123456789abcdef";

test("POSIX keeps today's socket and its adjacent fence, byte for byte", () => {
  /* Windows support must move nothing on the platforms that already work: the
     fence being a separate field is the only structural change, and on POSIX it
     resolves to exactly the `${socketPath}.lock` the host has always used. */
  expect(runtimeHostEndpoint(STATE_POSIX, INSTALL, "linux")).toEqual({
    socketPath: `${STATE_POSIX}/runtime-host-${INSTALL}.sock`,
    fencePath: `${STATE_POSIX}/runtime-host-${INSTALL}.sock.lock`,
  });
  expect(defaultRuntimeHostEndpoint(STATE_POSIX, "darwin")).toEqual({
    socketPath: `${STATE_POSIX}/runtime-host.sock`,
    fencePath: `${STATE_POSIX}/runtime-host.sock.lock`,
  });
});

test("Windows listens on a named pipe and keeps its fence as a real file", () => {
  /* A pipe name is not a path: it has no parent directory to create, no inode
     to unlink, no mode to tighten, and nothing for a `.lock` sibling to sit
     beside. The fence has to be a file, because the lock the kernel releases on
     process death is a file-range lock. */
  const endpoint = runtimeHostEndpoint(STATE_WIN, INSTALL, "win32");
  expect(endpoint.socketPath).toBe(`\\\\.\\pipe\\agent-log-viewer-${INSTALL}`);
  expect(endpoint.fencePath).toBe(path.win32.join(STATE_WIN, `runtime-host-${INSTALL}.lock`));
  expect(isNamedPipePath(endpoint.socketPath)).toBe(true);
  expect(isNamedPipePath(endpoint.fencePath)).toBe(false);
});

test("two installs never share an endpoint on either platform", () => {
  const first = runtimeHostEndpoint(STATE_WIN, "aaaaaaaaaaaaaaaa", "win32");
  const second = runtimeHostEndpoint(STATE_WIN, "bbbbbbbbbbbbbbbb", "win32");
  expect(first.socketPath).not.toBe(second.socketPath);
  expect(first.fencePath).not.toBe(second.fencePath);
});

test("a pipe name is recognised in every form the OS accepts, and a path is not", () => {
  expect(isNamedPipePath("\\\\.\\pipe\\agent-log-viewer-x")).toBe(true);
  expect(isNamedPipePath("\\\\?\\pipe\\agent-log-viewer-x")).toBe(true);
  expect(isNamedPipePath("/home/user/runtime-host.sock")).toBe(false);
  expect(isNamedPipePath("C:\\profile\\runtime-host.sock")).toBe(false);
  expect(isNamedPipePath("\\\\server\\share\\runtime-host.sock")).toBe(false);
});

test("a host handed only a pipe name puts its fence in the state directory", () => {
  expect(runtimeHostFencePath("/state/runtime-host.sock", "/state")).toBe("/state/runtime-host.sock.lock");
  expect(runtimeHostFencePath("\\\\.\\pipe\\agent-log-viewer-abc", STATE_WIN))
    .toBe(path.win32.join(STATE_WIN, "agent-log-viewer-abc.lock"));
});
