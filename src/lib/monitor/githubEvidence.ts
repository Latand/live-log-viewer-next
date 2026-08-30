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

/** The one `gh` seam. Shared with the seat tick's proposal source (#1245), so
    there is a single place a command, a timeout or a buffer bound is chosen. */
export function githubRunner(cwd: string, timeoutMs: number): GithubRunner {
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
  const run = options.run ?? githubRunner(options.cwd, options.timeoutMs ?? 20_000);
  const fields = "number,title,state,updatedAt";
  return async () => {
    const [prs, issues] = await Promise.all([
      run(["pr", "list", "--state", "all", "--limit", limit, "--json", fields]),
      run(["issue", "list", "--state", "all", "--limit", limit, "--json", fields]),
    ]);
    return [...parseRows(prs, "pull-request"), ...parseRows(issues, "issue")];
  };
}

/* ------------------------------------------------------------------------- *
 * Open issues as proposal material for the seat tick's proactive slot (#1245).
 *
 * The same `gh` seam above, asked a different question: correlation evidence
 * wants everything recently touched, a proposal wants what is still open and
 * what it is labelled. Strictly read-only, and degradable — a `gh` that is
 * missing, unauthenticated or rate-limited returns nothing and the seat ranks
 * from the board alone, because a proposal slot that failed outright would be a
 * wake that said nothing.
 *
 * Nothing here ever creates an issue.
 * ------------------------------------------------------------------------- */

export interface ProposalIssue {
  number: number;
  title: string;
  labels: string[];
  updatedAt: string | null;
}

const PROPOSAL_TITLE_LIMIT = 200;

function parseProposalIssues(raw: string): ProposalIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const issues: ProposalIssue[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as { number?: unknown; title?: unknown; labels?: unknown; updatedAt?: unknown };
    if (typeof row.number !== "number" || !Number.isSafeInteger(row.number)) continue;
    issues.push({
      number: row.number,
      title: typeof row.title === "string" ? row.title.slice(0, PROPOSAL_TITLE_LIMIT) : "",
      labels: (Array.isArray(row.labels) ? row.labels : []).flatMap((label) => {
        const name = (label as { name?: unknown } | null)?.name;
        return typeof name === "string" ? [name.slice(0, 60)] : [];
      }),
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
    });
  }
  return issues;
}

/* ------------------------------------------------------------------------- *
 * Open pull requests as the seat tick's unmerged-merge evidence (#1289).
 *
 * The third question asked of the same `gh` seam, and the narrowest: which pull
 * requests are still open, and what branch each one is the head of. The branch
 * is the whole point — it is what ties a pull request back to the lane that
 * produced it, so a lane that finished with its work unmerged can be named
 * rather than merely counted.
 *
 * Unlike the two questions above, this one does NOT degrade to an empty list.
 * An empty list here is a claim — every pull request those lanes opened has
 * since been merged or closed — and a `gh` that is missing, unauthenticated,
 * rate-limited, killed at the timeout, or answering with anything but a JSON
 * array of rows that can be attributed to a branch has established no such
 * thing. Collapsing the two made a failed read indistinguishable from a
 * finished merge, and the tick then reported `nothing owed` on the strength of
 * it, which is the twelve-hour silence #1289 exists to end returning by a
 * slower route. So the failure is carried out as a failure and the caller
 * decides what it costs.
 *
 * Read-only. Nothing here merges, closes, comments on or opens a pull request.
 * ------------------------------------------------------------------------- */

export interface OpenPullRequest {
  number: number;
  title: string;
  /** The branch the pull request is the head of, which is what a lane's own
      branch is matched against. */
  headRefName: string;
  updatedAt: string | null;
}

/**
 * Why the question could not be answered.
 *
 * Coarse on purpose: this token travels into a published journal line, so it
 * names the class of the failure and never the command, the repository, the
 * account or `gh`'s own stderr.
 */
export type OpenPullRequestsUnavailable = "timed-out" | "command-failed" | "malformed-output";

/** Either the answer or the reason there is none — never both, and never an
    empty list standing in for the second. */
export type OpenPullRequestsResult =
  | { ok: true; pullRequests: OpenPullRequest[] }
  | { ok: false; unavailable: OpenPullRequestsUnavailable };

const PULL_REQUEST_TITLE_LIMIT = 200;

/**
 * Null means the read failed rather than answered, and there are two ways.
 *
 * Output that is not a JSON array at all is the obvious one. The other is a
 * well-formed array carrying a row that names no number or no head branch:
 * dropping that row quietly turns a nonempty answer into an empty one, and an
 * empty one here is a claim — every pull request those lanes opened has since
 * merged or closed. A single unusable row was therefore enough to buy the
 * quiet verdict this result type exists to make earnable, which is the
 * collapse the type was introduced to end taking a shorter route.
 *
 * The two fields that make a row usable are the number and the head branch:
 * one names the pull request, the other ties it to the lane that opened it, and
 * a `gh` answering the question it was asked carries both on every row. An
 * array whose rows do not is output nobody can attribute, so it is reported as
 * what it is. A missing title or timestamp is a different matter — neither is
 * load-bearing for the reason, so a row is still attributable without them.
 * Exactly the empty array stays the answer that nothing is open.
 */
function parseOpenPullRequests(raw: string): OpenPullRequest[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows: OpenPullRequest[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const row = entry as { number?: unknown; title?: unknown; headRefName?: unknown; updatedAt?: unknown };
    if (typeof row.number !== "number" || !Number.isSafeInteger(row.number)) return null;
    /* A row with no head branch cannot be attributed to a lane, and a pull
       request nobody can name is not evidence that nothing is open. */
    if (typeof row.headRefName !== "string" || !row.headRefName) return null;
    rows.push({
      number: row.number,
      title: typeof row.title === "string" ? row.title.slice(0, PULL_REQUEST_TITLE_LIMIT) : "",
      headRefName: row.headRefName,
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
    });
  }
  return rows;
}

/** A command that failed and a command that was killed at the timeout are
    different facts about the machine, and whoever reads the journal line is
    telling an outage from a misconfiguration. `execFile` reports its own
    timeout as a killed child. */
function unavailableFromError(error: unknown): OpenPullRequestsUnavailable {
  const detail = error as { killed?: unknown; code?: unknown; name?: unknown } | null | undefined;
  if (detail?.killed === true || detail?.code === "ETIMEDOUT" || detail?.name === "TimeoutError") return "timed-out";
  return "command-failed";
}

export async function openPullRequestsForRepo(options: {
  cwd: string;
  limit?: number;
  run?: GithubRunner;
  timeoutMs?: number;
}): Promise<OpenPullRequestsResult> {
  const run = options.run ?? githubRunner(options.cwd, options.timeoutMs ?? 20_000);
  let raw: string;
  try {
    raw = await run(["pr", "list", "--state", "open", "--limit", String(options.limit ?? 60), "--json", "number,title,headRefName,updatedAt"]);
  } catch (error) {
    return { ok: false, unavailable: unavailableFromError(error) };
  }
  const pullRequests = parseOpenPullRequests(raw);
  return pullRequests ? { ok: true, pullRequests } : { ok: false, unavailable: "malformed-output" };
}

export async function openIssuesForProposal(options: {
  cwd: string;
  limit?: number;
  run?: GithubRunner;
  timeoutMs?: number;
}): Promise<ProposalIssue[]> {
  const run = options.run ?? githubRunner(options.cwd, options.timeoutMs ?? 20_000);
  try {
    const raw = await run(["issue", "list", "--state", "open", "--limit", String(options.limit ?? 40), "--json", "number,title,labels,updatedAt"]);
    return parseProposalIssues(raw);
  } catch {
    return [];
  }
}
