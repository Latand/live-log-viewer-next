import type { Engine, EngineLimits, LimitWindow } from "@/lib/types";

/** Public, secret-free account representation. Keep paths and CLI output server-side. */
export type AccountSummary = {
  id: string;
  label: string;
  kind: "legacy" | "managed";
  active: boolean;
  auth: {
    state: "authenticated" | "signed_out" | "unknown" | "error";
    method: string | null;
    email: string | null;
    plan: string | null;
    checkedAt: string | null;
  };
  limits: {
    state: "fresh" | "stale" | "unavailable";
    session: LimitWindow | null;
    weekly: LimitWindow | null;
    checkedAt: string | null;
  };
  login: LoginOperationSummary | null;
};

export type LoginPhase = "idle" | "starting" | "awaiting_browser" | "awaiting_code" | "verifying" | "authenticated" | "canceling" | "canceled" | "timed_out" | "failed" | "interrupted";

export type LoginResult = {
  status: "success" | "failure" | "canceled";
  code: string;
  message: string;
};

export type LoginOperationSummary = {
  operationId: string;
  phase: LoginPhase;
  loginUrl: string | null;
  acceptsCode: boolean;
  deadlineAt: string;
  result: LoginResult | null;
};

export type AccountCatalog = { claude: { active: string; accounts: AccountSummary[] }; codex: { active: string; accounts: AccountSummary[] } };

export type AccountContext = {
  engine: Extract<Engine, "claude" | "codex">;
  accountId: string;
  kind: "legacy" | "managed";
  home: string;
  transcriptRoot: string;
  env: NodeJS.ProcessEnv;
};

export type HeadlessSpawnAvailability =
  | { kind: "available"; account: AccountContext }
  | { kind: "exhausted"; resetsAt: number | null }
  | { kind: "unavailable" };

/** What a project's account binding (#1279) does to one launch's selection. */
export type ProjectSpawnResolution =
  | { kind: "available"; account: AccountContext }
  /** The launch named an account the project does not permit. Never downgraded
      to a fallback: crossing the boundary silently is the failure the binding
      exists to prevent. */
  | { kind: "not_allowed"; accountId: string; allowedAccountIds: string[] }
  /** Every account the project permits has a fresh zero-capacity sample. The
      caller reports and parks; an account outside the set is not a fallback. */
  | { kind: "exhausted"; resetsAt: number | null; allowedAccountIds: string[] }
  | { kind: "unavailable"; allowedAccountIds: string[] };

export type ProjectSpawnRequest = {
  /** Project the work belongs to; null resolves exactly as an unbound one. */
  project: string | null;
  /** Account the caller named — a pipeline stage's `account`, say. */
  requestedId?: string | null;
  /** Accounts already attempted for this launch, deprioritized as before. */
  excludedIds?: string[];
};

export interface AccountManager {
  list(): Promise<AccountCatalog>;
  add(engine: "claude" | "codex", label: string): Promise<AccountSummary>;
  select(engine: "claude" | "codex", accountId: string): Promise<AccountSummary>;
  status(engine: "claude" | "codex", accountId: string, fresh: boolean): Promise<AccountSummary>;
  submitLoginInput(operationId: string, code: string): Promise<LoginOperationSummary>;
  cancelLogin(operationId: string): Promise<LoginOperationSummary>;
  resolveSpawn(engine: "claude" | "codex", requestedId?: string | null): AccountContext;
  /** `project` restricts the candidates to the project's allowed set (#1279);
      omitted or null it selects over every account, as it always did. */
  resolveHeadlessSpawn(engine: "claude" | "codex", requestedId?: string | null, excludedIds?: string[], project?: string | null): HeadlessSpawnAvailability;
  /** The one seam every project-owned launch resolves its account through. */
  resolveProjectSpawn(engine: "claude" | "codex", request: ProjectSpawnRequest): ProjectSpawnResolution;
  resolveTranscriptOwner(engine: "claude" | "codex", transcript: string): AccountContext | null;
}

export function unavailableLimits(): AccountSummary["limits"] {
  return { state: "unavailable", session: null, weekly: null, checkedAt: null };
}

export function limitsSummary(limits: EngineLimits | null, state: AccountSummary["limits"]["state"] = "unavailable"): AccountSummary["limits"] {
  return { state: limits ? state : "unavailable", session: limits?.session ?? null, weekly: limits?.weekly ?? null, checkedAt: limits?.capturedAt ? new Date(limits.capturedAt * 1000).toISOString() : null };
}
