import { githubRunner, type GithubRunner } from "@/lib/monitor/githubEvidence";

/**
 * Open issues as proposal material for the seat tick's proactive slot (#1245).
 *
 * The same `gh` seam `githubEvidence.ts` already uses, asked a different
 * question: correlation evidence wants everything recently touched, a proposal
 * wants what is still open and what it is labelled. Strictly read-only, and
 * degradable — a `gh` that is missing, unauthenticated or rate-limited returns
 * nothing and the seat ranks from the board alone, because a proposal slot that
 * failed outright would be a wake that said nothing.
 *
 * Nothing here ever creates an issue.
 */

export interface ProposalIssue {
  number: number;
  title: string;
  labels: string[];
  updatedAt: string | null;
}

const TITLE_LIMIT = 200;

function parseIssues(raw: string): ProposalIssue[] {
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
      title: typeof row.title === "string" ? row.title.slice(0, TITLE_LIMIT) : "",
      labels: (Array.isArray(row.labels) ? row.labels : []).flatMap((label) => {
        const name = (label as { name?: unknown } | null)?.name;
        return typeof name === "string" ? [name.slice(0, 60)] : [];
      }),
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
    });
  }
  return issues;
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
    return parseIssues(raw);
  } catch {
    return [];
  }
}
