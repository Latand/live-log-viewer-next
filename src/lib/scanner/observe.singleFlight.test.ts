import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The corpus observation at production shape (#845).
 *
 * `operator_snapshot` and `/api/agent/snapshot` both walk the whole corpus through
 * `observeFiles`, and it used to walk once per CALLER. Twenty concurrent warm
 * control-plane reads therefore meant twenty full walks racing each other and the
 * coordinator's own scan generation — and a client that gave up left its walk
 * running against files nobody would read.
 *
 * The fixture is deliberately production-shaped rather than a toy: 373 transcript
 * files across the project spread a real operator has, read by twenty concurrent
 * callers. It lives in an isolated HOME
 * inside a temp directory, and the scenario runs in a CHILD PROCESS whose HOME is set
 * before the scanner is imported — `ROOTS` is baked from `os.homedir()` at import
 * time, so an in-process test that lost the module-load race would sweep the
 * operator's real corpus instead.
 */

const FILE_COUNT = 373;
const PROJECTS = 41;

const sandboxes: string[] = [];

afterAll(() => {
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function transcript(index: number): string {
  const started = new Date(Date.UTC(2026, 6, 1, 9, 0, index % 60)).toISOString();
  return [
    JSON.stringify({ type: "session_meta", payload: { id: `sess-${index}`, timestamp: started, cwd: `/repo/project-${index % PROJECTS}` } }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "high", cwd: `/repo/project-${index % PROJECTS}` } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `task ${index}` }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `working on ${index}` }] } }),
  ].join("\n") + "\n";
}

/** A corpus with the file count and project spread of a real machine. */
function fixtureHome(): string {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-observe-shape-"));
  sandboxes.push(sandbox);
  const home = path.join(sandbox, "home");
  const codex = path.join(home, ".codex", "sessions", "2026", "07", "01");
  fs.mkdirSync(codex, { recursive: true });
  for (let index = 0; index < FILE_COUNT; index += 1) {
    fs.writeFileSync(path.join(codex, `rollout-2026-07-01T09-00-00-sess${String(index).padStart(4, "0")}.jsonl`), transcript(index));
  }
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  return home;
}

interface ProbeResult {
  files: number;
  afterWarm: number;
  afterConcurrent: number;
  distinctArrays: boolean;
  equalContent: boolean;
  cancellationOutcomes: string[];
  orphanAfterCancellation: boolean;
  generationsUnderLoad: number;
  rssBefore: number;
  rssAfter: number;
  error?: string;
}

let fixtureFileCount = 0;

async function runProbe(): Promise<ProbeResult> {
  const home = fixtureHome();
  fixtureFileCount = fs.readdirSync(path.join(home, ".codex", "sessions", "2026", "07", "01")).length;
  const state = path.join(home, "state");
  const config = path.join(home, "config");
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  const child = Bun.spawn(["bun", "src/lib/scanner/observe.probe.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      /* Isolated on every axis the scanner and the state layer read. */
      HOME: home,
      XDG_CONFIG_HOME: config,
      LLV_STATE_DIR: state,
      TMPDIR: path.join(home, "tmp"),
      NODE_ENV: "test",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  const line = out.trim().split("\n").at(-1) ?? "";
  if (!line.startsWith("{")) throw new Error(`probe produced no result: ${out}\n${err}`);
  return JSON.parse(line) as ProbeResult;
}

test("twenty concurrent warm reads join one corpus walk, honour cancellation, and do not grow RSS", async () => {
  const result = await runProbe();
  expect(result.error).toBeUndefined();

  /* The fixture really is the shape claimed on disk; the scanner's own scheme window
     then caps what a read carries, which is exactly the production behaviour this
     must not change. */
  expect(fixtureFileCount).toBe(FILE_COUNT);
  expect(result.files).toBeGreaterThan(0);

  /* One warm walk, and then TWENTY concurrent callers add exactly one more between
     them. Before #845 this line read twenty-one. */
  expect(result.afterWarm).toBe(1);
  expect(result.afterConcurrent).toBe(2);

  /* Joining must not mean sharing: the snapshot composer overlays titles onto these
     entries, so two callers holding one array would corrupt each other. */
  expect(result.distinctArrays).toBe(true);
  expect(result.equalContent).toBe(true);

  /* Every caller walking away is answered as cancelled, and leaves nothing running. */
  expect(result.cancellationOutcomes).toEqual(["cancelled"]);
  expect(result.orphanAfterCancellation).toBe(false);

  /* Ten rounds of twenty is ten walks, not two hundred. */
  expect(result.generationsUnderLoad).toBe(10);

  /* Two hundred reads of a 373-file corpus must not leave a heap behind them. The
     bound is generous on purpose — this catches retention, not allocation. */
  expect(result.rssAfter - result.rssBefore).toBeLessThan(150);
}, 120_000);
