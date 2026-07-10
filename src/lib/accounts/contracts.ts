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

export type LoginOperationSummary = {
  operationId: string;
  phase: LoginPhase;
  loginUrl: string | null;
  acceptsCode: boolean;
  deadlineAt: string;
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

export interface AccountManager {
  list(): Promise<AccountCatalog>;
  add(engine: "claude" | "codex", label: string): Promise<AccountSummary>;
  select(engine: "claude" | "codex", accountId: string): Promise<AccountSummary>;
  status(engine: "claude" | "codex", accountId: string, fresh: boolean): Promise<AccountSummary>;
  submitLoginInput(operationId: string, code: string): Promise<LoginOperationSummary>;
  cancelLogin(operationId: string): Promise<LoginOperationSummary>;
  resolveSpawn(engine: "claude" | "codex", requestedId?: string | null): AccountContext;
  resolveTranscriptOwner(engine: "claude" | "codex", transcript: string): AccountContext | null;
}

export function unavailableLimits(): AccountSummary["limits"] {
  return { state: "unavailable", session: null, weekly: null, checkedAt: null };
}

export function limitsSummary(limits: EngineLimits | null, state: AccountSummary["limits"]["state"] = "unavailable"): AccountSummary["limits"] {
  return { state: limits ? state : "unavailable", session: limits?.session ?? null, weekly: limits?.weekly ?? null, checkedAt: limits?.capturedAt ? new Date(limits.capturedAt * 1000).toISOString() : null };
}
