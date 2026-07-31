/**
 * Out-of-process probe for the shared corpus observation (#845).
 *
 * `ROOTS` is baked from `os.homedir()` at import time, so a test that points HOME at
 * a fixture only wins if it is the first thing in the process to load the scanner —
 * which `bun test` cannot promise, and getting it wrong means sweeping the
 * OPERATOR'S real corpus. Running the scenario in a child process whose HOME is set
 * before it starts removes the ordering question entirely.
 *
 * Prints one JSON line. Not a test file, so the runner never collects it.
 */

import {
  fileObservationGenerations,
  fileObservationInFlight,
  observeFiles,
  ObservationCancelledError,
} from "@/lib/scanner/observe";

const CONCURRENCY = 20;

function rssMiB(): number {
  return process.memoryUsage().rss / (1024 * 1024);
}

async function main(): Promise<void> {
  /* Warm, exactly as a running Viewer is when the control plane starts asking. */
  const warm = await observeFiles();
  const afterWarm = fileObservationGenerations();

  /* Twenty concurrent warm calls — the shape the acceptance criterion names. */
  const results = await Promise.all(Array.from({ length: CONCURRENCY }, () => observeFiles()));
  const afterConcurrent = fileObservationGenerations();

  /* Cancellation: every caller walks away mid-walk. Nothing may be left running. */
  const controller = new AbortController();
  const cancelled = Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    try {
      await observeFiles({ signal: controller.signal });
      return "resolved";
    } catch (error) {
      return error instanceof ObservationCancelledError ? "cancelled" : `unexpected:${String(error)}`;
    }
  }));
  controller.abort();
  const cancellationOutcomes = await cancelled;
  /* Let the abort unwind the walk the joiners just abandoned. */
  await new Promise((resolve) => setTimeout(resolve, 50));
  const orphanAfterCancellation = fileObservationInFlight();

  /* Sustained load: ten rounds of twenty. RSS is sampled after a settle so the
     comparison is between steady states rather than against a transient peak. */
  const settle = async () => {
    if (global.gc) global.gc();
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  await settle();
  const rssBefore = rssMiB();
  let generationsUnderLoad = fileObservationGenerations();
  for (let round = 0; round < 10; round += 1) {
    await Promise.all(Array.from({ length: CONCURRENCY }, () => observeFiles()));
  }
  generationsUnderLoad = fileObservationGenerations() - generationsUnderLoad;
  await settle();
  const rssAfter = rssMiB();

  process.stdout.write(JSON.stringify({
    files: warm.length,
    afterWarm,
    afterConcurrent,
    /* Distinct arrays, so one caller's title overlay cannot reach another's. */
    distinctArrays: results[0] !== results[1] && results[0] !== warm,
    equalContent: JSON.stringify(results[0]) === JSON.stringify(results[1]),
    cancellationOutcomes: [...new Set(cancellationOutcomes)],
    orphanAfterCancellation,
    generationsUnderLoad,
    rssBefore,
    rssAfter,
  }) + "\n");
}

void main().catch((error: unknown) => {
  process.stdout.write(JSON.stringify({ error: String(error) }) + "\n");
  process.exitCode = 1;
});
