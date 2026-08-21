import type { NextRequest } from "next/server";

import {
  mcpServersForScheduledReport,
  SCHEDULED_REPORT_SESSION_CLASS,
} from "@/lib/agent/mcpAllowlist";

/**
 * The launch path for a Daily Report run (issue #1086).
 *
 * It is the operator's own spawn lane — the same `executeSpawnRequest` the
 * Viewer's own UI goes through, so the run is a board-visible conversation
 * with a durable receipt and never a detached `codex exec` — with two
 * deliberate differences, both of which exist because NOBODY IS AT THE
 * KEYBOARD when this fires:
 *
 *  - `defer` does not go through Next's `after()`. `after()` is only legal
 *    inside a request scope; a timer tick has none, so the production
 *    dependency would throw there and every scheduled structured launch would
 *    settle `launch_failed`. The deferred work here is simply started, and its
 *    failures are terminalized by the same code that terminalizes them behind
 *    a request.
 *  - `internalGrant` names {@link SCHEDULED_REPORT_SESSION_CLASS}, so the
 *    grant comes from the report class rather than from the launch's session
 *    origin. It is resolved by admission, at the moment the receipt is
 *    written, which is what makes a logout during the (minute-long) source
 *    pass revoke the connector for the run it was planning.
 */

export interface ReportSpawnResult {
  status: number;
  body: Record<string, unknown>;
}

export interface ReportSpawnInput {
  body: Record<string, unknown>;
  /** Re-read of "reports enabled AND Telegram connected", called by admission. */
  grantActive(): boolean;
}

/**
 * Deferred launch work for a spawn nobody is waiting on.
 *
 * `executeSpawnRequest` hands its structured launch to `defer` and returns a
 * 202; behind a request Next keeps the response alive until that work settles.
 * A timer has nothing to keep alive, so starting the promise IS the contract.
 * The rejection path is deliberately silent: everything worth recording is
 * already recorded durably by the work itself (a failed receipt), and the
 * error object may carry connector or account text that has no business in a
 * log line.
 */
export function startDeferredSpawnWork(work: () => Promise<void>): void {
  void work().catch(() => undefined);
}

/**
 * The two dependency overrides a Viewer-timer launch replaces, as one value so
 * a test can exercise them without standing up the whole spawn lane.
 */
export function reportSpawnOverrides(grantActive: () => boolean): {
  defer: (work: () => Promise<void>) => void;
  internalGrant: () => { sessionClass: typeof SCHEDULED_REPORT_SESSION_CLASS; mcpServers: string[] };
} {
  return {
    defer: startDeferredSpawnWork,
    internalGrant: () => ({
      sessionClass: SCHEDULED_REPORT_SESSION_CLASS,
      mcpServers: mcpServersForScheduledReport({ grantActive: grantActive() }),
    }),
  };
}

/**
 * Runs one spawn request in process, outside any HTTP request scope.
 *
 * The request object is the minimum `executeSpawnRequest` reads: a same-origin
 * host and the operator capability header, which is the Viewer acting for the
 * operator rather than an agent asking. Everything else — admission, lineage,
 * grants, the durable receipt — is the ordinary path.
 */
export async function launchReportConversation(input: ReportSpawnInput): Promise<ReportSpawnResult> {
  const [{ executeSpawnRequest, productionSpawnCommandDependencies }, { ensureOperatorSpawnCapability }, { VIEWER_SPAWN_CAPABILITY_HEADER }] = await Promise.all([
    import("@/lib/agent/spawnCommand"),
    import("@/lib/agent/operatorCapability"),
    import("@/lib/agent/spawnPolicy"),
  ]);
  const request = {
    headers: new Headers({ host: "127.0.0.1", [VIEWER_SPAWN_CAPABILITY_HEADER]: ensureOperatorSpawnCapability() }),
    json: async () => input.body,
  } as unknown as NextRequest;
  const response = await executeSpawnRequest(request, {
    ...productionSpawnCommandDependencies,
    ...reportSpawnOverrides(input.grantActive),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
