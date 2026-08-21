import fs from "node:fs";

import { archiveSettledPipelines } from "./store";

const [readyFile, releaseFile, now] = process.argv.slice(2);
if (!readyFile || !releaseFile || !now) throw new Error("archive child arguments are required");

function waitFor(filename: string): void {
  while (!fs.existsSync(filename)) Bun.sleepSync(5);
}

await archiveSettledPipelines(Date.parse(now), {
  beforeCommit: () => {
    fs.writeFileSync(readyFile, "ready");
    waitFor(releaseFile);
  },
});
