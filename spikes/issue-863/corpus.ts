/* Production-shaped pipeline registry for issue #863 profiling. Requires
   LLV_STATE_DIR to already point at an isolated sandbox. The builder itself now
   lives with the suite that asserts against it
   (`src/lib/pipelines/fixtures/corpus.ts`), so the measured shape and the tested
   shape cannot drift apart. */
import fs from "node:fs";
import path from "node:path";

import { pipelineCorpus } from "@/lib/pipelines/fixtures/corpus";
import { savePipelines } from "@/lib/pipelines/store";

export { pipelineCorpus };

/** Seeds the sandbox registry and returns its on-disk size in bytes. */
export function seedPipelineCorpus(count: number, attemptsPerStage = 6): number {
  savePipelines(pipelineCorpus(count, attemptsPerStage));
  return fs.statSync(path.join(process.env.LLV_STATE_DIR!, "pipelines.json")).size;
}
