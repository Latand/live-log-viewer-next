import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ClaudeAccount } from "./claude";

const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const APPROVED_CUSTOM_OAUTH_ORIGINS = new Set([
  "https://beacon.claude-ai.staging.ant.dev",
  "https://claude.fedstart.com",
  "https://claude-staging.fedstart.com",
]);
const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REFRESH_TIMEOUT_MS = 8_000;
const REFRESH_LOCK_WAIT_MS = 8_000;
const REFRESH_LOCK_POLL_MS = 25;
const DEFAULT_SCOPES = ["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"];
const PRESERVABLE_EXPANSION_SCOPES = new Set(["user:projects:read", "user:projects:write"]);

export type ClaudeOauthRefreshResult = "refreshed" | "invalid" | "unknown";
type ClaudeOauthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ClaudeOauthRefreshDependencies {
  now(): number;
  fetch: ClaudeOauthFetch;
  lockWaitMs?: number;
}

type OauthRecord = Record<string, unknown> & {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresAt?: unknown;
  scopes?: unknown;
  clientId?: unknown;
};

type CredentialDocument = Record<string, unknown> & { claudeAiOauth?: OauthRecord };

function credentialPath(account: ClaudeAccount): string {
  return path.join(account.home, ".credentials.json");
}

function readCredentialDocument(account: ClaudeAccount): CredentialDocument | null {
  if (!account.authPresent) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialPath(account), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as CredentialDocument : null;
  } catch {
    return null;
  }
}

export function claudeOauthMetadata(account: ClaudeAccount): { expiresAt: number; refreshable: boolean } | null {
  const oauth = readCredentialDocument(account)?.claudeAiOauth;
  return typeof oauth?.accessToken === "string" && oauth.accessToken.length > 0
    && typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt)
    ? { expiresAt: oauth.expiresAt, refreshable: typeof oauth.refreshToken === "string" && oauth.refreshToken.length > 0 }
    : null;
}

function writeCredentialDocument(account: ClaudeAccount, document: CredentialDocument): void {
  const file = credentialPath(account);
  const temporary = path.join(account.home, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(document), "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, file);
    const directory = fs.openSync(account.home, "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

const productionDependencies: ClaudeOauthRefreshDependencies = {
  now: Date.now,
  fetch: globalThis.fetch,
};

function oauthTokenUrl(): string | null {
  const configured = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL;
  if (!configured) return CLAUDE_OAUTH_TOKEN_URL;
  const origin = configured.replace(/\/+$/, "");
  return APPROVED_CUSTOM_OAUTH_ORIGINS.has(origin) ? `${origin}/v1/oauth/token` : null;
}

function concurrentRotationIsCurrent(account: ClaudeAccount, originalAccessToken: string, now: number): boolean {
  const current = readCredentialDocument(account)?.claudeAiOauth;
  if (!current || current.accessToken === originalAccessToken) return false;
  const metadata = claudeOauthMetadata(account);
  return metadata !== null && metadata.expiresAt > now;
}

async function acquireDirectoryLock(lock: string, startedAt: number, waitMs: number): Promise<(() => void) | null> {
  for (;;) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      const descriptor = fs.openSync(lock, "r");
      const owned = fs.fstatSync(descriptor);
      return () => {
        try {
          const current = fs.statSync(lock);
          if (current.dev === owned.dev && current.ino === owned.ino) fs.rmdirSync(lock);
        } catch { /* Claude may have cleared or replaced the lock after the bounded refresh window. */ }
        finally { fs.closeSync(descriptor); }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
      const remaining = waitMs - (Date.now() - startedAt);
      if (remaining <= 0) return null;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(REFRESH_LOCK_POLL_MS, remaining)));
    }
  }
}

async function acquireRefreshLocks(account: ClaudeAccount, waitMs: number): Promise<(() => void) | null> {
  const startedAt = Date.now();
  const releaseCurrent = await acquireDirectoryLock(path.join(account.home, ".oauth_refresh.lock"), startedAt, waitMs);
  if (!releaseCurrent) return null;

  let realHome: string;
  try { realHome = fs.realpathSync(account.home); } catch { realHome = account.home; }
  const releaseLegacy = await acquireDirectoryLock(`${realHome}.lock`, startedAt, waitMs);
  if (!releaseLegacy) {
    releaseCurrent();
    return null;
  }

  return () => {
    releaseLegacy();
    releaseCurrent();
  };
}

async function rejectedRefreshResult(response: Response): Promise<ClaudeOauthRefreshResult> {
  try {
    const payload = await response.json() as { error?: unknown };
    return payload?.error === "invalid_grant" ? "invalid" : "unknown";
  } catch {
    return "unknown";
  }
}

async function isInvalidScopeResponse(response: Response): Promise<boolean> {
  if (response.status !== 400) return false;
  try {
    const payload = await response.clone().json() as { error?: unknown };
    return payload?.error === "invalid_scope";
  } catch {
    return false;
  }
}

/** Rotates an expired Claude OAuth credential without surfacing credential content. */
export async function refreshClaudeOauth(
  account: ClaudeAccount,
  dependencies: ClaudeOauthRefreshDependencies = productionDependencies,
): Promise<ClaudeOauthRefreshResult> {
  const release = await acquireRefreshLocks(account, dependencies.lockWaitMs ?? REFRESH_LOCK_WAIT_MS);
  if (!release) return "unknown";
  try {
    return await refreshClaudeOauthLocked(account, dependencies);
  } finally {
    release();
  }
}

async function refreshClaudeOauthLocked(
  account: ClaudeAccount,
  dependencies: ClaudeOauthRefreshDependencies,
): Promise<ClaudeOauthRefreshResult> {
  const original = readCredentialDocument(account);
  const oauth = original?.claudeAiOauth;
  if (!original || !oauth
    || typeof oauth.accessToken !== "string" || oauth.accessToken.length === 0
    || typeof oauth.refreshToken !== "string" || oauth.refreshToken.length === 0) return "invalid";
  if (typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt) && oauth.expiresAt > dependencies.now()) {
    return "refreshed";
  }

  const originalAccessToken = oauth.accessToken;
  const storedScopes = Array.isArray(oauth.scopes) && oauth.scopes.every((scope) => typeof scope === "string")
    ? oauth.scopes as string[]
    : [];
  const hasStoredClientId = typeof oauth.clientId === "string" && oauth.clientId.length > 0;
  const clientId = hasStoredClientId
    ? oauth.clientId as string
    : process.env.CLAUDE_CODE_OAUTH_CLIENT_ID || CLAUDE_CODE_CLIENT_ID;
  const isDefaultFirstPartyClient = !hasStoredClientId
    && (storedScopes.includes("user:inference") || Boolean(oauth.subscriptionType));
  let initialScopes = storedScopes.length > 0 ? storedScopes : DEFAULT_SCOPES;
  if (isDefaultFirstPartyClient) {
    initialScopes = [...new Set([
      ...DEFAULT_SCOPES,
      ...storedScopes.filter((scope) => PRESERVABLE_EXPANSION_SCOPES.has(scope)),
    ])];
  }
  const tokenUrl = oauthTokenUrl();
  if (!tokenUrl) return "unknown";

  const signal = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
  const requestRefresh = (requestedScopes: string[]) => dependencies.fetch(tokenUrl, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken,
      client_id: clientId,
      scope: requestedScopes.join(" "),
    }),
    signal,
  });

  let response: Response;
  try {
    response = await requestRefresh(initialScopes);
    if (isDefaultFirstPartyClient
      && storedScopes.length > 0
      && storedScopes.includes("user:inference")
      && await isInvalidScopeResponse(response)) {
      response = await requestRefresh(storedScopes);
    }
  } catch {
    return "unknown";
  }

  if (response.status === 400 || response.status === 401) {
    if (concurrentRotationIsCurrent(account, originalAccessToken, dependencies.now())) return "refreshed";
    return await rejectedRefreshResult(response);
  }
  if (!response.ok) return "unknown";

  let payload: Record<string, unknown>;
  try {
    const parsed = await response.json() as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "unknown";
    payload = parsed as Record<string, unknown>;
  } catch {
    return "unknown";
  }
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0
    || typeof payload.expires_in !== "number" || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0) return "unknown";

  const current = readCredentialDocument(account);
  const currentOauth = current?.claudeAiOauth;
  if (!current || !currentOauth) return "unknown";
  if (currentOauth.accessToken !== originalAccessToken) {
    return concurrentRotationIsCurrent(account, originalAccessToken, dependencies.now()) ? "refreshed" : "unknown";
  }

  const nextOauth: OauthRecord = {
    ...currentOauth,
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === "string" && payload.refresh_token.length > 0
      ? payload.refresh_token
      : oauth.refreshToken,
    expiresAt: dependencies.now() + payload.expires_in * 1_000,
  };
  if (typeof payload.scope === "string" && payload.scope.trim()) nextOauth.scopes = payload.scope.trim().split(/\s+/);
  if (typeof payload.refresh_token_expires_in === "number" && Number.isFinite(payload.refresh_token_expires_in)) {
    nextOauth.refreshTokenExpiresAt = dependencies.now() + payload.refresh_token_expires_in * 1_000;
  }

  try {
    writeCredentialDocument(account, { ...current, claudeAiOauth: nextOauth });
    return "refreshed";
  } catch {
    return "unknown";
  }
}
