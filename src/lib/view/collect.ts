import { observeFiles } from "@/lib/scanner/observe";

import { composeSnapshot } from "./snapshot";
import { resolveSiblings } from "./siblings";
import type { SnapshotRequestV1 } from "./types";

export async function collectSnapshot(
  body: SnapshotRequestV1,
  dependencies = { observeFiles, resolveSiblings },
): Promise<Awaited<ReturnType<typeof composeSnapshot>>> {
  const started = Date.now();
  const files = await dependencies.observeFiles();
  const siblings = await dependencies.resolveSiblings(body.caller, files);
  return composeSnapshot({ request: body, files, siblings, scannerDurationMs: Date.now() - started });
}
