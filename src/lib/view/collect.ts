import { agentRegistry, type RegistryFile } from "@/lib/agent/registry";
import { observeFiles } from "@/lib/scanner/observe";
import { overlaySessionTitles } from "@/lib/session/titleProjection";

import { composeSnapshot } from "./snapshot";
import { resolveSiblings } from "./siblings";
import type { SnapshotRequestV1 } from "./types";

/**
 * One completed observation and one registry projection per snapshot (#845).
 *
 * The observation is single-flight inside `observeFiles`, so twenty concurrent
 * callers join one corpus walk rather than starting twenty. What is left here is the
 * other half: the caller's `signal` reaches that walk, so a client that deadlines
 * out or disconnects stops being a reason to keep reading files, and the registry
 * projection is INJECTED rather than materialised inside — an MCP caller that
 * already holds a projection should not cause a second one.
 */
export async function collectSnapshot(
  body: SnapshotRequestV1,
  dependencies: {
    observeFiles: typeof observeFiles;
    resolveSiblings: typeof resolveSiblings;
    registrySnapshot?: () => RegistryFile;
    signal?: AbortSignal | null;
  } = { observeFiles, resolveSiblings },
): Promise<Awaited<ReturnType<typeof composeSnapshot>>> {
  const started = Date.now();
  const files = await dependencies.observeFiles({ signal: dependencies.signal ?? null });
  // Custom session titles (issue #33) are the last word on `title` for the agent
  // snapshot surface too — applied before siblings resolve and the snapshot
  // composes, so renamed conversations and their siblings show the human title.
  overlaySessionTitles(files);
  const siblings = await dependencies.resolveSiblings(body.caller, files);
  /* `observeFiles` never appends spawn placeholder cards (#342), so visible
     `spawn:` paths must resolve against the durable registry here. */
  const registry = (dependencies.registrySnapshot ?? (() => agentRegistry().readOnlySnapshot()))();
  return composeSnapshot({ request: body, files, siblings, registry, scannerDurationMs: Date.now() - started });
}
