import { expect, test } from "bun:test";

import type { RuntimeHostClient } from "./client";
import { publishFilesRevision } from "./filesRevision";

test("serializes materialization bumps so concurrent transcripts receive distinct revisions", async () => {
  let filesRevision = 11;
  const published: number[] = [];
  const client = {
    snapshot: async () => ({ filesRevision }),
    append: async (event: { payload: { filesRevision: number } }) => {
      await Promise.resolve();
      filesRevision = event.payload.filesRevision;
      published.push(filesRevision);
    },
  } as unknown as RuntimeHostClient;

  await Promise.all([
    publishFilesRevision(client),
    publishFilesRevision(client),
  ]);

  expect(published).toEqual([12, 13]);
});
