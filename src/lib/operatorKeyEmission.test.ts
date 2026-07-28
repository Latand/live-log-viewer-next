import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initializeOperatorSpawnCapabilityAtStartup } from "./viewerInstrumentation";

/**
 * REGRESSION: STARTUP MINTS AND PRINTS NO OPERATOR KEY.
 *
 * Rounds 9–10 emitted an operator session secret here — to `/dev/tty` or an
 * inherited descriptor — and the startup told the operator to paste it into the tab
 * to "unlock operator-only actions". That was the ceremony the operator rejected
 * after using it: without the paste a fresh tab could neither open the manager nor
 * start a call from a card, and every reload took the tab back there.
 *
 * So the assertions are about ABSENCE, and they are written against everything the
 * startup writes rather than against the one channel round 10 happened to use: any
 * future round that hands a bearer to the operator has to make these fail.
 */

const previousStateDir = process.env.LLV_STATE_DIR;
let sandbox = "";

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-operator-key-emission-"));
  process.env.LLV_STATE_DIR = path.join(sandbox, "state");
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** Everything the startup said, as one blob. */
async function startupLog(env: Record<string, string | undefined> = {}): Promise<string> {
  const lines: string[] = [];
  await initializeOperatorSpawnCapabilityAtStartup(env, (line) => lines.push(line));
  return lines.join("\n");
}

test("the startup announces the origin and nothing else — no key, no paste, no unlock", async () => {
  const log = await startupLog({ PORT: "8899" });

  expect(log).toContain("http://127.0.0.1:8899");
  for (const ceremony of ["key", "paste", "unlock", "secret", "locked", "stand down"]) {
    expect(log.toLowerCase()).not.toContain(ceremony);
  }
});

test("no secret channel is opened: no tty write, no descriptor, nothing to collect", async () => {
  /* The descriptor round 10 wrote to. Naming it must now do nothing at all — a
     supervisor that still sets it collects no bearer, because none is minted. */
  const log = await startupLog({ PORT: "8898", LLV_OPERATOR_KEY_FD: "3" });
  expect(log).not.toMatch(/[A-Za-z0-9_-]{43}/);
});

test("the AGENT capability on disk is still ensured — identifying a worker is the one distinction kept", async () => {
  await startupLog({ PORT: "8898" });
  const { operatorSpawnCapabilityPath } = await import("@/lib/agent/operatorCapability");
  const capability = fs.readFileSync(operatorSpawnCapabilityPath(), "utf8").trim();
  expect(capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
});
