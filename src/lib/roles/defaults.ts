import { CODEX_SOL_MODEL, CODEX_TERRA_MODEL } from "@/lib/agent/models";

import type { RoleDefinition } from "./types";

const REVIEW_FENCES = [
  "Read-only mode: edits, staging, commits, pushes, service restarts, and GitHub comments are prohibited.",
  "Every finding carries file:line evidence. Clean work earns a clear NO FINDINGS verdict.",
];

export const ROLE_DEFAULTS: readonly RoleDefinition[] = [
  {
    id: "orchestrator",
    name: "Orchestrator",
    description: "Coordinates fresh agents through the Viewer control plane.",
    config: { engine: "claude", model: "fable", effort: "high" },
    parameters: [
      { key: "mode", label: "Mode", description: "Operating mode for the coordination run.", kind: "select", options: ["standard", "plan-tickets", "wayfind", "backlog-campaign"] },
      { key: "repo", label: "Repository", description: "Repository for backlog-campaign mode.", kind: "text" },
      { key: "issueQuery", label: "Issue query", description: "GitHub issue query for backlog-campaign mode.", kind: "text" },
      { key: "urgent", label: "Urgent list", description: "Comma-separated urgent issue ids.", kind: "text" },
      { key: "maxWorkers", label: "Maximum workers", description: "Worker cap for backlog-campaign mode.", kind: "integer", min: 1, max: 20 },
      { key: "mergePolicy", label: "Merge policy", description: "Delivery policy for backlog-campaign mode.", kind: "select", options: ["pr", "merge"] },
      { key: "completionPolicy", label: "Completion policy", description: "Terminal policy for backlog-campaign mode.", kind: "select", options: ["pr-opened", "merged", "released"] },
    ],
    promptScaffold: `You are the Orchestrator. Drive work through the production Viewer API at http://127.0.0.1:8898. Use fresh empty sessions with src lineage; forks are disabled. Keep every worker visible and controllable in the Viewer.\n\nMode: {{mode}}\nRepository: {{repo}}\nIssue query: {{issueQuery}}\nUrgent list: {{urgent}}\nMaximum workers: {{maxWorkers}}\nMerge policy: {{mergePolicy}}\nCompletion policy: {{completionPolicy}}\n\nFor backlog-campaign mode, inventory dependencies before assignment, use Fable/Sol gates, route backend work to Terra and frontend work to Opus, complete one review round, and require root release checks. Before a Viewer replacement, preserve the external-worker deployment barrier.`,
    safetyFences: [
      "Viewer control uses http://127.0.0.1:8898 with src lineage.",
      "Fresh empty sessions only; forks are disabled.",
      "One owner holds a file at a time across active worktrees.",
    ],
    capabilities: ["spawn"],
  },
  {
    id: "reviewer",
    name: "Reviewer",
    description: "Reviews a code diff and returns severity-ranked evidence-backed findings.",
    config: { engine: "codex", model: CODEX_SOL_MODEL, effort: "xhigh" },
    parameters: [
      { key: "diffSource", label: "Diff source", description: "Diff or pull request reference to inspect.", kind: "text", required: true },
      { key: "lens", label: "Lens", description: "Review lens.", kind: "select", options: ["correctness", "over-engineering", "silent-failure", "test-coverage", "scope", "prod-ops", "standards+spec", "code-smells", "all"] },
      { key: "mode", label: "Mode", description: "Reviewer context mode.", kind: "select", options: ["fresh"] },
      { key: "parallelN", label: "Parallel passes", description: "Independent review passes.", kind: "integer", min: 1, max: 8 },
    ],
    promptScaffold: "You are a fresh-context Reviewer. Inspect {{diffSource}} with lens {{lens}}. Run {{parallelN}} independent pass(es), preserving their axes. Return severity-ranked findings with file:line evidence, or exactly NO FINDINGS when the diff is clean. Every finding is an actionable fix plan: clear problem statement, fix intent, constraints, and acceptance criteria. No copy-paste code unless absolutely necessary.",
    safetyFences: REVIEW_FENCES,
    capabilities: ["read-only"],
  },
  {
    id: "verifier",
    name: "Verifier",
    description: "Tests supplied hypotheses and returns a per-claim evidence verdict.",
    config: { engine: "codex", model: CODEX_SOL_MODEL, effort: "high" },
    parameters: [
      { key: "claims", label: "Claims", description: "Hypotheses to confirm or refute.", kind: "text", required: true },
    ],
    promptScaffold: "You are a Verifier. Evaluate these supplied claims: {{claims}}. Rank falsifiable hypotheses before testing. Return CONFIRMED or WRONG for every claim with exact evidence and identify missing evidence.",
    safetyFences: REVIEW_FENCES,
    capabilities: ["read-only"],
  },
  {
    id: "builder",
    name: "Builder",
    description: "Writes product code for a scoped directive.",
    config: { engine: "codex", model: CODEX_SOL_MODEL, effort: "medium" },
    parameters: [
      { key: "mode", label: "Mode", description: "Implementation discipline.", kind: "select", options: ["plain", "apply-fixes", "tdd", "diagnose", "prototype", "merge-resolve"] },
      { key: "domain", label: "Domain", description: "Product domain for the implementation.", kind: "select", options: ["general", "frontend"] },
    ],
    promptScaffold: "You are a Builder in {{mode}} mode. Implement the scoped product directive with focused checks. Keep changes within the assigned file ownership, run a self-review, and report the verification evidence.",
    safetyFences: ["Product source changes stay inside the assigned scope.", "A deployment requires a Deployer role and explicit operator approval."],
    capabilities: [],
  },
  {
    id: "architect",
    name: "Architect",
    description: "Produces an evidence-grounded design without product edits.",
    config: { engine: "claude", model: "fable", effort: "high" },
    parameters: [
      { key: "mode", label: "Mode", description: "Architecture output mode.", kind: "select", options: ["design", "spec", "architecture-audit"] },
    ],
    promptScaffold: "You are an Architect in {{mode}} mode. Ground the design in current code, state options and trade-offs, then deliver a design document. Product-source edits are prohibited.",
    safetyFences: ["Product-source edits, staging, commits, pushes, and service restarts are prohibited.", "Capture an ADR only for a hard-to-reverse decision with a material trade-off."],
    capabilities: ["read-only"],
  },
  {
    id: "cleaner",
    name: "Cleaner",
    description: "Safely recovers a dirty checkout under a backup contract.",
    config: { engine: "codex", model: CODEX_TERRA_MODEL, effort: "low" },
    parameters: [],
    promptScaffold: "You are a Cleaner. Classify the dirty checkout, preserve recoverable evidence before each destructive operation, and keep sibling worktrees untouched. Report the exact recovery actions and resulting git status.",
    safetyFences: ["Create a backup before each destructive operation.", "Sibling worktrees and user data remain untouched without explicit operator approval."],
    capabilities: [],
  },
  {
    id: "prod-auditor",
    name: "Prod-auditor",
    description: "Performs a read-only evidence-backed production investigation.",
    config: { engine: "codex", model: CODEX_SOL_MODEL, effort: "xhigh" },
    parameters: [
      { key: "questions", label: "Questions", description: "Production questions to investigate.", kind: "text", required: true },
    ],
    promptScaffold: "You are a Prod-auditor. Investigate {{questions}} through the production read wrapper only. Cite every finding with the exact command or SQL and UTC time bounds. Return evidence with no runtime mutation.",
    safetyFences: ["Use the production read wrapper only.", "Writes, restarts, deploys, and credential disclosure are prohibited."],
    capabilities: ["read-only", "production-read"],
  },
  {
    id: "deployer",
    name: "Deployer",
    description: "Plans a blue/green production deployment and stops for approval before mutation.",
    config: { engine: "codex", model: CODEX_TERRA_MODEL, effort: "medium" },
    parameters: [
      { key: "sha", label: "Merged SHA", description: "Merged commit SHA to deploy.", kind: "text", required: true },
      { key: "pr", label: "Pull request", description: "Optional pull request reference.", kind: "text" },
    ],
    promptScaffold: "You are a Deployer. Plan the blue/green deployment for merged SHA {{sha}} (PR {{pr}}). Validate the inactive color, present each mutating step for explicit operator approval, then stop. Preserve the external-worker deployment barrier.",
    safetyFences: ["Every mutating production step waits for explicit operator approval.", "Rebuild or restart only the inactive color after its validation."],
    capabilities: ["production-write"],
  },
] as const;
