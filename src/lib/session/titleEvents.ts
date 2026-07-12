import { runtimeHostClient } from "@/lib/runtime/client";
import type { RuntimeEventInput } from "@/lib/runtime/contracts";

/**
 * The runtime-journal events a title mutation publishes so other tabs/devices
 * converge even when healthy SSE has disabled the fallback `/api/files` poll:
 *
 * 1. `title.updated` — an identity-based set/clear signal (the stable key and
 *    whether it was cleared, deliberately WITHOUT the title text, keeping user
 *    content out of the operational journal).
 * 2. `files.revision` — the monotonic files bump every client already reacts to
 *    by refetching `/api/files`, which carries the overlaid title.
 *
 * Pure so the wire contract is unit-testable without a live host.
 */
export function titleUpdateEvents(identity: string, cleared: boolean, currentFilesRevision: number): RuntimeEventInput[] {
  return [
    {
      scope: { type: "system", id: "session-title" },
      kind: "title.updated",
      payload: { identity, cleared },
      producer: { kind: "session-title" },
    },
    {
      scope: { type: "system", id: "files" },
      kind: "files.revision",
      payload: { filesRevision: currentFilesRevision + 1 },
      producer: { kind: "session-title" },
    },
  ];
}

/**
 * Best-effort publish through the runtime host. A missing host (runtime UI off →
 * clients already poll) or any host error is a silent no-op: the durable rename
 * already committed and the poll still converges.
 */
export async function publishTitleUpdate(identity: string, cleared: boolean): Promise<void> {
  const client = runtimeHostClient();
  if (!client) return;
  try {
    const snapshot = await client.snapshot();
    for (const event of titleUpdateEvents(identity, cleared, snapshot.filesRevision)) {
      await client.append(event);
    }
  } catch {
    /* host unavailable mid-request; fallback poll still converges */
  }
}
