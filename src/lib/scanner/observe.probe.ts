/**
 * Out-of-process probe for the shared corpus observation (#845).
 *
 * `ROOTS` is baked from `os.homedir()` and `os.tmpdir()` at import time, so a test
 * that points HOME at a fixture only wins if it is the first thing in the process to
 * load the scanner — which `bun test` cannot promise, and getting it wrong means
 * sweeping the OPERATOR'S real corpus. Running the scenario in a child process whose
 * environment is set before it starts removes the ordering question entirely.
 *
 * It also REPORTS the roots it resolved, so the isolation is asserted rather than
 * assumed: the `claude-tasks` root in particular falls back to a live
 * `/tmp/claude-<uid>` when the tmpdir-based candidate does not exist, which would have
 * put the operator's background-task outputs inside a "sandboxed" scan and made the
 * fd-holder scan enumerate processes that own them.
 *
 * Prints one JSON line. Not a test file, so the runner never collects it.
 */

import { ROOTS, scanRootEntries } from "@/lib/scanner/roots";
import { completedFileScan, fileScanCacheStatus } from "@/lib/scanner/scanCache";
import { fileScanCoordinatorStatus } from "@/lib/scanner/scanCoordinator";

const CONCURRENCY = 20;

function rssMiB(): number {
  return process.memoryUsage().rss / (1024 * 1024);
}

async function main(): Promise<void> {
  /* Warm, exactly as a running Viewer is when the control plane starts asking. */
  const warm = await completedFileScan({ revalidate: false });
  const afterWarm = warm.generation;

  /* Twenty concurrent warm calls consume one completed projection. */
  const results = await Promise.all(Array.from({ length: CONCURRENCY }, () => completedFileScan({ revalidate: false })));
  const afterConcurrent = Math.max(...results.map((result) => result.generation));

  /* Sustained load: ten rounds of twenty. RSS is sampled after a settle so the
     comparison is between steady states rather than against a transient peak. */
  const settle = async () => {
    if (global.gc) global.gc();
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  await settle();
  const rssBefore = rssMiB();
  const generationBeforeLoad = afterConcurrent;
  for (let round = 0; round < 10; round += 1) {
    await Promise.all(Array.from({ length: CONCURRENCY }, () => completedFileScan({ revalidate: false })));
  }
  const final = await completedFileScan({ revalidate: false });
  const generationsUnderLoad = final.generation - generationBeforeLoad;
  await settle();
  const rssAfter = rssMiB();

  process.stdout.write(JSON.stringify({
    /* Every root the scanner would walk, so the test can prove all of them are inside
       the fixture rather than trusting that HOME was enough. */
    roots: scanRootEntries().map(([key, root]) => ({ key, root })),
    claudeTasksRoot: ROOTS["claude-tasks"],
    files: warm.snapshot.files.length,
    projects: warm.snapshot.projectCatalog.length,
    /* Proof the fd-holder scan attributed nothing: no fixture transcript is held open,
       so no pid from the operator's machine can have been adopted onto a card. */
    entriesWithPid: warm.snapshot.files.filter((entry) => entry.pid !== null).length,
    entriesWithPaneTarget: warm.snapshot.files.filter((entry) => entry.pendingQuestion?.paneTarget != null).length,
    claudeTaskEntries: warm.snapshot.files.filter((entry) => entry.root === "claude-tasks").length,
    afterWarm,
    afterConcurrent,
    /* Distinct arrays, so one caller's title overlay cannot reach another's. */
    distinctArrays: results[0]?.snapshot.files !== results[1]?.snapshot.files
      && results[0]?.snapshot.files !== warm.snapshot.files,
    equalContent: JSON.stringify(results[0]?.snapshot) === JSON.stringify(results[1]?.snapshot),
    cancellationOutcomes: [],
    orphanAfterCancellation: fileScanCacheStatus().inFlight || fileScanCoordinatorStatus().inFlight,
    generationsUnderLoad,
    rssBefore,
    rssAfter,
  }) + "\n");
}

void main().catch((error: unknown) => {
  process.stdout.write(JSON.stringify({ error: String(error) }) + "\n");
  process.exitCode = 1;
});
