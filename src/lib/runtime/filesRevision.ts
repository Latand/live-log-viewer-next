import type { RuntimeHostClient } from "./client";
import type { RuntimeEventInput } from "./contracts";

let publicationQueue: Promise<void> = Promise.resolve();

export function filesRevisionEvent(currentFilesRevision: number): RuntimeEventInput {
  return {
    scope: { type: "system", id: "files" },
    kind: "files.revision",
    payload: { filesRevision: currentFilesRevision + 1 },
    producer: { kind: "structured-spawn-materialized" },
  };
}

/**
 * Publish one filesystem read-model invalidation after a structured transcript
 * materializes. Calls from concurrent launches serialize the snapshot and bump
 * so each launch advances the monotonic revision observed by connected clients.
 */
export function publishFilesRevision(client: RuntimeHostClient): Promise<void> {
  const publication = publicationQueue.catch(() => undefined).then(async () => {
    const snapshot = await client.snapshot();
    await client.append(filesRevisionEvent(snapshot.filesRevision));
  });
  publicationQueue = publication;
  return publication;
}
