/**
 * Recurring conversation monitor — CLI entry (issue #741).
 *
 * This is what the half-hourly schedule runs. It resolves the current
 * orchestrator through the Viewer's durable record, reads operator-authored
 * messages over a bounded window, correlates each concrete request against the
 * board, pipelines, flows and (when `gh` can answer) pull requests and issues,
 * materializes the gaps as board cards, delivers one report to the
 * orchestrator, and appends exactly one line to its audit journal.
 *
 * Read-only with respect to conversations and worktrees. It spawns nothing,
 * resumes nothing, kills nothing, and never opens a GitHub issue.
 *
 *   bun scripts/conversation-monitor.ts --window-hours 6
 *   bun scripts/conversation-monitor.ts --dry-run --json
 *   bun scripts/conversation-monitor.ts --status 5
 *
 * Exit status: 0 for a clean or skipped run, 1 for a failed one — so the
 * schedule's own log distinguishes the three without reading the journal.
 */

import { githubEvidenceSource } from "../src/lib/monitor/githubEvidence";
import { runConversationMonitor, type MonitorOptions } from "../src/lib/monitor/run";
import { httpViewerApi } from "../src/lib/monitor/viewerApi";

const DEFAULT_BASE_URL = "http://127.0.0.1:8898";

export interface MonitorCliArgs extends MonitorOptions {
  baseUrl: string;
  json: boolean;
  status: number | null;
  github: boolean;
  repoDir: string;
}

class CliError extends Error {}

function numeric(name: string, raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new CliError(`${name} needs a positive number`);
  return value;
}

export function parseMonitorArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): MonitorCliArgs {
  const args: MonitorCliArgs = {
    baseUrl: env.LLV_VIEWER_CONTROL_URL?.trim() || DEFAULT_BASE_URL,
    json: false,
    status: null,
    github: true,
    repoDir: cwd,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--base-url":
        args.baseUrl = argv[++index] ?? "";
        if (!args.baseUrl) throw new CliError("--base-url needs a URL");
        break;
      case "--window-hours":
        args.windowHours = numeric("--window-hours", argv[++index]);
        break;
      case "--project":
        args.project = argv[++index] ?? null;
        break;
      case "--max-conversations":
        args.maxConversations = numeric("--max-conversations", argv[++index]);
        break;
      case "--max-cards":
        args.maxCards = numeric("--max-cards", argv[++index]);
        break;
      case "--stall-hours":
        args.stallAfterMs = numeric("--stall-hours", argv[++index]) * 60 * 60 * 1000;
        break;
      case "--repo-dir":
        args.repoDir = argv[++index] ?? cwd;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--deliver-when-empty":
        args.deliverWhenEmpty = true;
        break;
      case "--no-github":
        args.github = false;
        break;
      case "--json":
        args.json = true;
        break;
      case "--status":
        args.status = /^\d+$/.test(argv[index + 1] ?? "") ? numeric("--status", argv[++index]) : 5;
        break;
      default:
        throw new CliError(`unknown flag ${flag}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseMonitorArgs(process.argv.slice(2));

  const api = httpViewerApi({ baseUrl: args.baseUrl });

  if (args.status !== null) {
    /* Read back through the API too: the journal is the viewer's file, and the
       monitor process has no business opening it. */
    for (const record of await api.readRuns(args.status)) {
      console.log(JSON.stringify(record));
    }
    return;
  }

  const report = await runConversationMonitor(
    { api, now: () => new Date(), ...(args.github ? { github: githubEvidenceSource({ cwd: args.repoDir }) } : {}) },
    args,
  );

  /* The record is the publication-safe projection: fingerprints and counts,
     no transcript text and no paths. The classified requests carry operator
     wording and stay out of stdout. */
  if (args.json) {
    console.log(JSON.stringify(report.record, null, 2));
  } else {
    const { record } = report;
    console.log(
      `run ${record.runId} ${record.outcome}${record.detail ? ` — ${record.detail}` : ""}\n`
        + `window ${record.window.hours}h, ${record.scanned.conversations} conversation(s), ${record.scanned.operatorMessages} operator message(s)\n`
        + `orchestrator ${record.orchestrator.resolution}, delivered ${record.orchestrator.delivered}\n`
        + `found ${record.found.total} (${Object.entries(record.found.byState).filter(([, count]) => count > 0).map(([state, count]) => `${state}: ${count}`).join(", ") || "nothing"})\n`
        + `created ${record.created.length} card(s), skipped ${record.skipped.length}`,
    );
  }
  /* An unaudited run is indistinguishable from one that never ran, so it exits
     the same way a failed one does. */
  if (report.record.outcome === "failed" || !report.audited) process.exit(1);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "conversation monitor failed");
    process.exit(1);
  }
}
