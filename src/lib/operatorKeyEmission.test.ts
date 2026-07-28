import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emitOperatorKey, initializeOperatorSpawnCapabilityAtStartup } from "./viewerInstrumentation";

/**
 * The operator key must never reach captured output (#691 round 10).
 *
 * `console.error` is stderr, and under the managed/detached start stderr belongs to
 * the container logging driver, which writes it to a JSON file on disk. That made the
 * key a bearer at rest, readable by every same-uid process — the same defect as the
 * served page and the state file, arriving through the one channel that looked like it
 * was only for a human to read.
 *
 * These assert the property directly: whatever the startup writes to its log, the key
 * is not in it, and the DETACHED case emits no key at all.
 */

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-operator-key-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
  return dir;
}

/** A capability-shaped token: 32 random bytes, base64url. */
const KEY_SHAPE = /[A-Za-z0-9_-]{40,}/;

test("a detached start emits no key at all, and says so without one", async () => {
  sandbox();
  const logged: string[] = [];
  const written: { target: string | number; line: string }[] = [];

  await initializeOperatorSpawnCapabilityAtStartup(
    { PORT: "8898" },
    (line) => logged.push(line),
    /* No controlling terminal and no descriptor: exactly the container case. */
    (capability, env) => emitOperatorKey(capability, env, (target, line) => {
      written.push({ target, line });
      throw new Error("no such device");
    }),
  );

  const captured = logged.join("\n");
  expect(captured).not.toMatch(KEY_SHAPE);
  expect(captured).toContain("operator key withheld");
  /* And the withheld line explains the consequence rather than leaving it silent. */
  expect(captured).toContain("stay locked");
});

test("the key never appears in captured output even when it IS delivered", async () => {
  sandbox();
  const logged: string[] = [];
  let handed = "";

  await initializeOperatorSpawnCapabilityAtStartup(
    { PORT: "8898" },
    (line) => logged.push(line),
    (capability, env, writeTo) => emitOperatorKey(capability, env, (target, line) => {
      /* Stands in for /dev/tty: a real terminal, never the log stream. */
      handed = line.trim();
      void target;
      void writeTo;
    }),
  );

  expect(handed).toMatch(KEY_SHAPE);
  const captured = logged.join("\n");
  expect(captured).not.toContain(handed);
  expect(captured).not.toMatch(KEY_SHAPE);
  expect(captured).toContain("written to this terminal");
});

test("a supervisor descriptor takes the key instead of the terminal", () => {
  const sinks: (string | number)[] = [];
  const outcome = emitOperatorKey("k".repeat(43), { LLV_OPERATOR_KEY_FD: "3" }, (target) => { sinks.push(target); });
  expect(outcome).toBe("fd");
  expect(sinks).toEqual([3]);
});

test("a closed descriptor does NOT fall back to a log stream", () => {
  /* The failure mode worth naming: "the pipe went away, so print it" would put the
     key straight back into captured output. */
  const attempted: (string | number)[] = [];
  const outcome = emitOperatorKey("k".repeat(43), { LLV_OPERATOR_KEY_FD: "3" }, (target) => {
    attempted.push(target);
    throw new Error("EBADF");
  });
  expect(outcome).toBe("withheld");
  /* It tried the descriptor and then the terminal, and nothing else. */
  expect(attempted).toEqual([3, "/dev/tty"]);
});

test("stdin, stdout and stderr are never accepted as the key descriptor", () => {
  for (const descriptor of ["0", "1", "2", "-1", "", "nonsense"]) {
    const attempted: (string | number)[] = [];
    emitOperatorKey("k".repeat(43), { LLV_OPERATOR_KEY_FD: descriptor }, (target) => {
      attempted.push(target);
      if (target === "/dev/tty") throw new Error("no tty");
    });
    /* Straight to the terminal: fd 1 and 2 ARE the captured streams. */
    expect(attempted).toEqual(["/dev/tty"]);
  }
});

test("the startup writes exactly one key, to one sink", async () => {
  sandbox();
  const written: string[] = [];
  await initializeOperatorSpawnCapabilityAtStartup(
    { PORT: "8898" },
    () => undefined,
    (capability, env, writeTo) => emitOperatorKey(capability, env, (target, line) => {
      written.push(line);
      void target;
      void writeTo;
    }),
  );
  expect(written).toHaveLength(1);
});
