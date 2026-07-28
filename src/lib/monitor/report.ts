import { stateLabel } from "./cards";
import { MONITOR_MARKER } from "./requests";
import type { ClassifiedRequest, MonitorCreation, MonitorRunRecord, RequestState } from "./types";

/**
 * The message the monitor delivers to the orchestrator (issue #741).
 *
 * It opens with {@link MONITOR_MARKER} for two reasons: the operator can tell
 * at a glance that no human wrote it, and the next run's extractor uses the
 * same marker to refuse to read this text back as an operator request.
 */

/** Order the states are reported in: the ones needing a decision first. */
const REPORT_ORDER: RequestState[] = ["untracked", "stalled", "awaiting-confirmation", "in-flight", "completed"];

export interface ReportInput {
  record: MonitorRunRecord;
  classified: readonly ClassifiedRequest[];
  createdByFingerprint: ReadonlyMap<string, MonitorCreation>;
}

function bullet(entry: ClassifiedRequest, created: MonitorCreation | undefined): string {
  const card = created ? ` → board card ${created.taskId}` : "";
  return `- ${entry.request.title}${card}\n  ${entry.reason}.`;
}

export function renderMonitorReport(input: ReportInput): string {
  const { record, classified, createdByFingerprint } = input;
  const lines: string[] = [
    `${MONITOR_MARKER} run ${record.runId}`,
    "",
    `Window ${record.window.from.slice(0, 16).replace("T", " ")} → ${record.window.to.slice(0, 16).replace("T", " ")} UTC (${record.window.hours}h), `
      + `${record.scanned.conversations} conversation(s), ${record.scanned.operatorMessages} operator message(s)`
      + `${record.scope.project ? `, project ${record.scope.project}` : ", all projects"}.`,
  ];

  if (classified.length === 0) {
    lines.push("", "No concrete operator request in this window. Nothing created, nothing outstanding.");
  } else {
    for (const state of REPORT_ORDER) {
      const entries = classified.filter((entry) => entry.state === state);
      if (entries.length === 0) continue;
      lines.push("", `${stateLabel(state).toUpperCase()} (${entries.length})`);
      for (const entry of entries) lines.push(bullet(entry, createdByFingerprint.get(entry.request.fingerprint)));
    }
  }

  if (record.created.length > 0) {
    lines.push("", `Created ${record.created.length} board card(s); no GitHub issue was created — the monitor never opens one from inferred intent.`);
  } else {
    lines.push("", "Created no board work this run; no GitHub issue was created — the monitor never opens one from inferred intent.");
  }
  const budgeted = record.skipped.filter((entry) => entry.reason === "card-budget").length;
  if (budgeted > 0) lines.push(`Held back ${budgeted} candidate(s) at this run's card budget; the next run picks them up.`);

  lines.push(
    "",
    `Run ${record.outcome}${record.detail ? ` — ${record.detail}` : ""}. Surfacing only: deciding and delegating stays with you.`,
  );
  return lines.join("\n");
}
