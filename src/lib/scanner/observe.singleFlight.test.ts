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
 * ## Isolation, and why it needs proving rather than asserting
 *
 * The scanner resolves three roots, and only two of them follow HOME. The
 * `claude-tasks` root is `<tmpdir>/claude-<uid>`, and when that does not exist it
 * FALLS BACK to a live `/tmp/claude-<uid>` — so a fixture that set HOME and TMPDIR but
 * never created the tmpdir candidate would quietly walk the operator's real
 * background-task outputs, and the fd-holder scan would then attribute the operator's
 * live pids onto them.
 *
 * So the fixture creates every root, including that one, and the probe REPORTS the
 * roots it resolved. The test asserts each is inside the fixture, that nothing was
 * attributed a pid or a pane, and that two independent fixtures produce identical
 * counts — which is what makes the numbers a property of the fixture rather than of
 * whatever happens to exist on the machine running this.
 *
 * The scan caps are raised through the scanner's own env knobs so the production-shaped
 * corpus survives the scheme window instead of being trimmed to one project's worth.
 */

const PROJECTS = 41;
const FILES_PER_PROJECT = 9;
const CODEX_FILES = 4;
const FILE_COUNT = PROJECTS * FILES_PER_PROJECT + CODEX_FILES;

const sandboxes: string[] = [];

afterAll(() => {
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function claudeTranscript(cwd: string, project: number, index: number): string {
  const at = new Date(Date.UTC(2026, 6, 1, 9, index % 60, project % 60)).toISOString();
  return [
    JSON.stringify({ type: "user", timestamp: at, cwd, message: { role: "user", content: `task ${project}/${index}` } }),
    JSON.stringify({ type: "assistant", timestamp: at, cwd, message: { role: "assistant", content: [{ type: "text", text: `working on ${project}/${index}` }] } }),
  ].join("\n") + "\n";
}

/** Claude encodes a session's cwd into its project directory name by replacing every
    separator with a dash. The fixture builds the slug from a repository that really
    exists, so the scanner resolves a distinct project per repo instead of folding the
    whole corpus into one unresolved group. */
function claudeProjectSlug(cwd: string): string {
  return cwd.split(path.sep).join("-");
}

function codexTranscript(index: number): string {
  const at = new Date(Date.UTC(2026, 6, 1, 8, index, 0)).toISOString();
  return [
    JSON.stringify({ type: "session_meta", payload: { id: `sess-${index}`, timestamp: at } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `codex task ${index}` }] } }),
  ].join("\n") + "\n";
}

interface Fixture { home: string; state: string; config: string; tmp: string; claudeTasks: string; files: number }

/** A corpus with the file count and project spread of a real machine, and every
    scanner root inside it — including the tmpdir-based one. */
function fixture(): Fixture {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-observe-shape-"));
  sandboxes.push(sandbox);
  const home = path.join(sandbox, "home");
  const tmp = path.join(home, "tmp");
  let files = 0;

  for (let project = 0; project < PROJECTS; project += 1) {
    /* A repository the scanner can actually identify: `projectIdentityFromRepositoryRoot`
       needs a `.git/config`, and with no origin remote it keys the project on the
       local path — which is distinct per repo, which is the point. */
    const repository = path.join(home, "repos", `project-${String(project).padStart(2, "0")}`);
    fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repository, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n");

    const directory = path.join(home, ".claude", "projects", claudeProjectSlug(repository));
    fs.mkdirSync(directory, { recursive: true });
    for (let index = 0; index < FILES_PER_PROJECT; index += 1) {
      fs.writeFileSync(path.join(directory, `session-${index}.jsonl`), claudeTranscript(repository, project, index));
      files += 1;
    }
  }

  const codex = path.join(home, ".codex", "sessions", "2026", "07", "01");
  fs.mkdirSync(codex, { recursive: true });
  for (let index = 0; index < CODEX_FILES; index += 1) {
    fs.writeFileSync(path.join(codex, `rollout-2026-07-01T08-00-00-sess${index}.jsonl`), codexTranscript(index));
    files += 1;
  }

  /* THE ONE THAT ESCAPES. Without this directory `claudeTasksRoot()` falls through to
     `/tmp/claude-<uid>` — the operator's live background-task outputs. */
  const claudeTasks = path.join(tmp, `claude-${process.getuid?.() ?? 1000}`);
  fs.mkdirSync(claudeTasks, { recursive: true });

  const state = path.join(home, "state");
  const config = path.join(home, "config");
  for (const directory of [state, config, path.join(tmp, "tmux")]) fs.mkdirSync(directory, { recursive: true });
  return { home, state, config, tmp, claudeTasks, files };
}

interface ProbeResult {
  roots: { key: string; root: string }[];
  claudeTasksRoot: string;
  files: number;
  projects: number;
  entriesWithPid: number;
  entriesWithPaneTarget: number;
  claudeTaskEntries: number;
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

async function runProbe(sandbox: Fixture): Promise<ProbeResult> {
  const child = Bun.spawn(["bun", "src/lib/scanner/observe.probe.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      /* Isolated on every axis the scanner, the state layer and the pane resolver
         read. TMPDIR is what moves the `claude-tasks` root off the live one; the
         fixture creates the directory so the fallback is never reached. */
      HOME: sandbox.home,
      XDG_CONFIG_HOME: sandbox.config,
      LLV_STATE_DIR: sandbox.state,
      TMPDIR: sandbox.tmp,
      TMUX_TMPDIR: path.join(sandbox.tmp, "tmux"),
      /* The scheme window exists to keep the BOARD bounded; here it would trim the
         production-shaped corpus this test is about, so it is opened to fit it. */
      LLV_SCHEME_PROJECT_CAP: String(PROJECTS + 5),
      LLV_SCHEME_CARDS_PER_PROJECT: String(FILES_PER_PROJECT + CODEX_FILES + 5),
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

function expectFullyIsolated(result: ProbeResult, sandbox: Fixture): void {
  expect(result.error).toBeUndefined();
  /* Every root, not just the two that follow HOME. */
  expect(result.roots.length).toBeGreaterThanOrEqual(3);
  for (const { root } of result.roots) expect(root.startsWith(sandbox.home + path.sep)).toBe(true);
  expect(result.claudeTasksRoot).toBe(sandbox.claudeTasks);
  /* The live fallback, named explicitly so this fails loudly if it is ever selected. */
  expect(result.claudeTasksRoot).not.toBe(`/tmp/claude-${process.getuid?.() ?? 1000}`);
  /* Nothing on the machine holds a fixture transcript open, so the fd-holder scan
     attributed no pid and the pane resolver was never reached. */
  expect(result.entriesWithPid).toBe(0);
  expect(result.entriesWithPaneTarget).toBe(0);
  /* And the isolated task root really is empty, so `outputHolders()` — the scan that
     walks fds UNDER that root — never ran. */
  expect(result.claudeTaskEntries).toBe(0);
}

test("the production-shaped corpus is read entirely from the fixture, with no live root", async () => {
  const sandbox = fixture();
  expect(sandbox.files).toBe(FILE_COUNT);
  const result = await runProbe(sandbox);

  expectFullyIsolated(result, sandbox);
  /* The whole corpus survives the scheme window: the shape claimed, rather than one
     project's cap worth. */
  expect(result.files).toBe(FILE_COUNT);
  /* One project per repository, plus the codex rollouts' own group. */
  expect(result.projects).toBe(PROJECTS + 1);
}, 180_000);

test("two independent fixtures produce identical counts, so the numbers are the fixture's", async () => {
  /* The proof that nothing ambient contributes: the live `/tmp/claude-<uid>` is
     neither created nor touched by this suite, and two separate sandboxes — each with
     its own tmpdir-based task root — agree exactly. */
  const [first, second] = [fixture(), fixture()];
  const [left, right] = await Promise.all([runProbe(first), runProbe(second)]);

  expectFullyIsolated(left, first);
  expectFullyIsolated(right, second);
  expect(left.claudeTasksRoot).not.toBe(right.claudeTasksRoot);
  expect({ files: left.files, projects: left.projects })
    .toEqual({ files: right.files, projects: right.projects });
  expect(left.files).toBe(FILE_COUNT);
}, 180_000);

test("twenty concurrent warm reads join one corpus walk, honour cancellation, and do not grow RSS", async () => {
  const sandbox = fixture();
  const result = await runProbe(sandbox);
  expectFullyIsolated(result, sandbox);

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
}, 180_000);
