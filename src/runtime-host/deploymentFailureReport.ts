import type {
  ViewerDeploymentStatus,
  ViewerHealthEvidence,
  ViewerHealthProbeObservation,
} from "@/lib/runtime/contracts";

/** The deploy driver prints one sentence for a terminal failure, and that
    sentence is all an operator gets. Everything the gate observed is already in
    the durable record, so the failure path renders it instead of leaving the
    next reader to open SQLite (#790). */
export function deploymentFailureReport(status: unknown): string[] {
  if (!status || typeof status !== "object" || Array.isArray(status)) return [];
  const deployment = status as Partial<ViewerDeploymentStatus>;
  const lines: string[] = [];
  const candidate = deployment.candidate;
  if (candidate) {
    lines.push(`candidate ${candidate.revision.slice(0, 12)} at ${candidate.endpoint} (container ${candidate.container})`);
  }
  const health = Array.isArray(deployment.health) ? deployment.health : [];
  const last = health[health.length - 1] as ViewerHealthEvidence | undefined;
  if (!last) {
    lines.push("no health evidence was recorded before the failure");
    return lines;
  }
  lines.push(`health at ${last.checkedAt}: ${readinessSummary(last)}`);
  for (const observation of last.observations ?? []) lines.push(`  ${observationLine(observation)}`);
  if (!last.observations) {
    lines.push(`  root ${last.rootStatus} authenticated ${last.authenticatedStatus ?? "n/a"} unauthorized ${last.unauthorizedStatus ?? "n/a"}`);
  }
  const assets = last.assets.filter((asset) => asset.status !== 200);
  lines.push(`  assets: ${last.assets.length} referenced, ${assets.length} not 200${assets[0] ? ` (${assets[0].path} -> ${assets[0].status})` : ""}`);
  for (const observation of last.observations ?? []) {
    if (observation.body) lines.push(`  ${observation.name} body: ${observation.body}`);
  }
  const mcp = last.mcpRuntime;
  if (mcp) {
    lines.push(`  mcp runtime: process ${mcp.processReady ? "ready" : "not ready"}, deployment_status ${mcp.calls.deploymentStatus}, board_snapshot ${mcp.calls.boardSnapshot}${mcp.detail ? ` - ${mcp.detail}` : ""}`);
  }
  const log = last.containerLog ?? [];
  if (log.length > 0) {
    lines.push(`candidate output (last ${log.length} lines):`);
    for (const line of log) lines.push(`  ${line}`);
  } else {
    lines.push("candidate output: none was captured before the candidate was retired");
  }
  return lines;
}

function readinessSummary(evidence: ViewerHealthEvidence): string {
  const readiness = evidence.readiness;
  if (!readiness) return "no readiness accounting was recorded";
  return `${readiness.attempts} of ${readiness.maxAttempts} attempts over ${(readiness.elapsedMs / 1_000).toFixed(1)}s, ${readiness.delayMs} ms apart${readiness.firstDetail ? `; first attempt: ${readiness.firstDetail}` : ""}`;
}

function observationLine(observation: ViewerHealthProbeObservation): string {
  const answered = observation.status === 0
    ? `no response (${observation.error ?? "transport failure"})`
    : `HTTP ${observation.status}`;
  return `${observation.ok ? "pass" : "FAIL"} ${observation.name} ${observation.url} -> ${answered} in ${observation.elapsedMs} ms, expected ${observation.expected}`;
}
