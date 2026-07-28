import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GithubEvidenceRow } from "./evidence";

/**
 * Pull requests and issues as correlation evidence (issue #741).
 *
 * Strictly read-only, and deliberately the one evidence source the run can do
 * without: a request the operator already opened an issue for must not be
 * materialized a second time, but a `gh` that is missing, unauthenticated or
 * rate-limited is a degraded run that says so — never a reason to skip the
 * board work.
 *
 * Nothing here ever creates an issue. That is an explicit operator decision,
 * and the monitor's job stops at surfacing the candidate.
 */

const execFileAsync = promisify(execFile);

export interface GithubRunner {
  (args: string[]): Promise<string>;
}

export interface GithubEvidenceOptions {
  cwd: string;
  limit?: number;
  run?: GithubRunner;
  timeoutMs?: number;
}

function defaultRunner(cwd: string, timeoutMs: number): GithubRunner {
  return async (args) => {
    const { stdout } = await execFileAsync("gh", args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  };
}

function parseRows(raw: string, kind: GithubEvidenceRow["kind"]): GithubEvidenceRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`gh returned no parsable JSON for ${kind === "pull-request" ? "pull requests" : "issues"}`);
  }
  if (!Array.isArray(parsed)) return [];
  const rows: GithubEvidenceRow[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as { number?: unknown; title?: unknown; state?: unknown; updatedAt?: unknown };
    if (typeof row.number !== "number" || !Number.isSafeInteger(row.number)) continue;
    rows.push({
      kind,
      number: row.number,
      title: typeof row.title === "string" ? row.title : "",
      state: typeof row.state === "string" ? row.state : "OPEN",
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
    });
  }
  return rows;
}

/** A `github` dependency for the run: open and recently closed work, both kinds. */
export function githubEvidenceSource(options: GithubEvidenceOptions): () => Promise<GithubEvidenceRow[]> {
  const limit = String(options.limit ?? 60);
  const run = options.run ?? defaultRunner(options.cwd, options.timeoutMs ?? 20_000);
  const fields = "number,title,state,updatedAt";
  return async () => {
    const [prs, issues] = await Promise.all([
      run(["pr", "list", "--state", "all", "--limit", limit, "--json", fields]),
      run(["issue", "list", "--state", "all", "--limit", limit, "--json", fields]),
    ]);
    return [...parseRows(prs, "pull-request"), ...parseRows(issues, "issue")];
  };
}
