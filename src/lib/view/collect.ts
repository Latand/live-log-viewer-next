import { observeFiles } from "@/lib/scanner/observe";
import { overlaySessionTitles } from "@/lib/session/titleProjection";

import { composeSnapshot } from "./snapshot";
import { resolveSiblings } from "./siblings";
import type { SnapshotRequestV1 } from "./types";

export async function collectSnapshot(
  body: SnapshotRequestV1,
  dependencies = { observeFiles, resolveSiblings },
): Promise<Awaited<ReturnType<typeof composeSnapshot>>> {
  const started = Date.now();
  const files = await dependencies.observeFiles();
  // Custom session titles (issue #33) are the last word on `title` for the agent
  // snapshot surface too — applied before siblings resolve and the snapshot
  // composes, so renamed conversations and their siblings show the human title.
  overlaySessionTitles(files);
  const siblings = await dependencies.resolveSiblings(body.caller, files);
  return composeSnapshot({ request: body, files, siblings, scannerDurationMs: Date.now() - started });
}
