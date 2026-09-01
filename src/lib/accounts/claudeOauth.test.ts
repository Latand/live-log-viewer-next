import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";

import type { ClaudeAccount } from "./claude";
import { claudeOauthMetadata, refreshClaudeOauth } from "./claudeOauth";

const NOW = Date.parse("2026-07-17T09:00:00.000Z");
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(`${home}.lock`, { recursive: true, force: true });
  }
});

function account(id: string): ClaudeAccount {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `llv-claude-oauth-${id}-`));
  homes.push(home);
  fs.writeFileSync(path.join(home, ".credentials.json"), JSON.stringify({
    claudeAiOauth: {
      accessToken: crypto.randomUUID(),
      refreshToken: crypto.randomUUID(),
      expiresAt: NOW - 1,
      scopes: ["user:inference"],
      subscriptionType: "max",
    },
  }), { mode: 0o600 });
  return { id, label: id, kind: "managed", home, projectsDir: path.join(home, "projects"), authPresent: true, createdAt: 0 };
}

test("a successful bounded OAuth refresh persists current launch metadata", async () => {
  const candidate = account("refreshable");
  let signal: AbortSignal | null = null;

  const result = await refreshClaudeOauth(candidate, {
    now: () => NOW,
    fetch: async (_input, init) => {
      signal = init?.signal ?? null;
      return Response.json({
        access_token: crypto.randomUUID(),
        refresh_token: crypto.randomUUID(),
        expires_in: 3_600,
        scope: "user:inference",
      });
    },
  });

  expect(result).toBe("refreshed");
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(claudeOauthMetadata(candidate)).toEqual({ expiresAt: NOW + 3_600_000, refreshable: true });
  expect(fs.statSync(path.join(candidate.home, ".credentials.json")).mode & 0o777).toBe(0o600);
});

test("an OAuth redirect cannot forward refresh credentials to another origin", async () => {
  const candidate = account("redirect-exfiltration");
  let redirectedRequests = 0;
  const destination = Bun.serve({
    port: 0,
    fetch: () => {
      redirectedRequests += 1;
      return new Response(null, { status: 204 });
    },
  });
  const upstream = Bun.serve({
    port: 0,
    fetch: () => new Response(null, {
      status: 307,
      headers: { location: new URL("/collect-sensitive-request", destination.url).href },
    }),
  });

  try {
    const result = await refreshClaudeOauth(candidate, {
      now: () => NOW,
      fetch: async (_input, init) => await fetch(upstream.url, init),
    });

    expect(result).toBe("unknown");
    expect(redirectedRequests).toBe(0);
    expect(claudeOauthMetadata(candidate)?.expiresAt).toBe(NOW - 1);
  } finally {
    await upstream.stop(true);
    await destination.stop(true);
  }
});

test("only positive invalid_grant evidence is fenced while other failures remain transient", async () => {
  const unclassified401 = account("unclassified-401");
  const invalidGrant = account("invalid-grant");
  const invalidGrant401 = account("invalid-grant-401");
  const unauthorizedClient = account("unauthorized-client");
  const invalidScope = account("invalid-scope");
  const transient = account("transient");

  await expect(refreshClaudeOauth(unclassified401, {
    now: () => NOW,
    fetch: async () => new Response(null, { status: 401 }),
  })).resolves.toBe("unknown");
  await expect(refreshClaudeOauth(transient, {
    now: () => NOW,
    fetch: async () => new Response(null, { status: 503 }),
  })).resolves.toBe("unknown");
  await expect(refreshClaudeOauth(invalidGrant, {
    now: () => NOW,
    fetch: async () => Response.json({ error: "invalid_grant" }, { status: 400 }),
  })).resolves.toBe("invalid");
  await expect(refreshClaudeOauth(invalidGrant401, {
    now: () => NOW,
    fetch: async () => Response.json({ error: "invalid_grant" }, { status: 401 }),
  })).resolves.toBe("invalid");
  await expect(refreshClaudeOauth(unauthorizedClient, {
    now: () => NOW,
    fetch: async () => Response.json({ error: "unauthorized_client" }, { status: 401 }),
  })).resolves.toBe("unknown");
  await expect(refreshClaudeOauth(invalidScope, {
    now: () => NOW,
    fetch: async () => Response.json({ error: "invalid_scope" }, { status: 400 }),
  })).resolves.toBe("unknown");

  expect(claudeOauthMetadata(unclassified401)?.expiresAt).toBe(NOW - 1);
  expect(claudeOauthMetadata(transient)?.expiresAt).toBe(NOW - 1);
});

test("HTTP 401 invalid_client remains a transient compatibility failure", async () => {
  const candidate = account("invalid-client");

  const result = await refreshClaudeOauth(candidate, {
    now: () => NOW,
    fetch: async () => Response.json({ error: "invalid_client" }, { status: 401 }),
  });

  expect(result).toBe("unknown");
  expect(claudeOauthMetadata(candidate)?.expiresAt).toBe(NOW - 1);
});

test("a first-party invalid_scope response retries with the stored inference scopes", async () => {
  const candidate = account("invalid-scope-fallback");
  const requestedScopes: string[] = [];

  const result = await refreshClaudeOauth(candidate, {
    now: () => NOW,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { scope: string };
      requestedScopes.push(body.scope);
      if (requestedScopes.length === 1) {
        return Response.json({ error: "invalid_scope" }, { status: 400 });
      }
      return Response.json({ access_token: crypto.randomUUID(), expires_in: 3_600, scope: body.scope });
    },
  });

  expect(result).toBe("refreshed");
  expect(requestedScopes).toEqual([
    "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    "user:inference",
  ]);
});

test("a late refresh rejection observes a concurrent native credential rotation", async () => {
  const candidate = account("native-race");

  const result = await refreshClaudeOauth(candidate, {
    now: () => NOW,
    fetch: async () => {
      fs.writeFileSync(path.join(candidate.home, ".credentials.json"), JSON.stringify({
        claudeAiOauth: {
          accessToken: crypto.randomUUID(),
          refreshToken: crypto.randomUUID(),
          expiresAt: NOW + 60_000,
          scopes: ["user:inference"],
        },
      }), { mode: 0o600 });
      return new Response(null, { status: 401 });
    },
  });

  expect(result).toBe("refreshed");
  expect(claudeOauthMetadata(candidate)?.expiresAt).toBe(NOW + 60_000);
});

test("a native refresh lock bounds Viewer admission without starting duplicate refresh work", async () => {
  const candidate = account("native-lock");
  fs.mkdirSync(path.join(candidate.home, ".oauth_refresh.lock"), { mode: 0o700 });
  let fetchCalls = 0;

  const result = await refreshClaudeOauth(candidate, {
    now: () => NOW,
    lockWaitMs: 1,
    fetch: async () => {
      fetchCalls += 1;
      return new Response(null, { status: 503 });
    },
  });

  expect(result).toBe("unknown");
  expect(fetchCalls).toBe(0);
  expect(fs.existsSync(path.join(candidate.home, ".oauth_refresh.lock"))).toBeTrue();
});

test("a legacy native refresh lock bounds Viewer admission without starting duplicate refresh work", async () => {
  const candidate = account("legacy-native-lock");
  const legacyLock = `${fs.realpathSync(candidate.home)}.lock`;
  fs.mkdirSync(legacyLock, { mode: 0o700 });
  let fetchCalls = 0;

  const result = await refreshClaudeOauth(candidate, {
    now: () => NOW,
    lockWaitMs: 1,
    fetch: async () => {
      fetchCalls += 1;
      return new Response(null, { status: 503 });
    },
  });

  expect(result).toBe("unknown");
  expect(fetchCalls).toBe(0);
  expect(fs.existsSync(legacyLock)).toBeTrue();
  expect(fs.existsSync(path.join(candidate.home, ".oauth_refresh.lock"))).toBeFalse();
});

test("Viewer release preserves native lock directories replaced by another owner", async () => {
  const candidate = account("replaced-native-locks");
  const currentLock = path.join(candidate.home, ".oauth_refresh.lock");
  const legacyLock = `${fs.realpathSync(candidate.home)}.lock`;

  const result = await refreshClaudeOauth(candidate, {
    now: () => NOW,
    fetch: async () => {
      fs.rmdirSync(legacyLock);
      fs.rmdirSync(currentLock);
      fs.mkdirSync(currentLock, { mode: 0o700 });
      fs.mkdirSync(legacyLock, { mode: 0o700 });
      return new Response(null, { status: 503 });
    },
  });

  expect(result).toBe("unknown");
  expect(fs.existsSync(currentLock)).toBeTrue();
  expect(fs.existsSync(legacyLock)).toBeTrue();
});

test("Viewer reuses a native rotation completed while waiting for the refresh lock", async () => {
  const candidate = account("native-winner");
  const lock = path.join(candidate.home, ".oauth_refresh.lock");
  fs.mkdirSync(lock, { mode: 0o700 });
  let fetchCalls = 0;
  setTimeout(() => {
    fs.writeFileSync(path.join(candidate.home, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: crypto.randomUUID(),
        refreshToken: crypto.randomUUID(),
        expiresAt: NOW + 60_000,
        scopes: ["user:inference"],
      },
    }), { mode: 0o600 });
    fs.rmdirSync(lock);
  }, 5);

  const result = await refreshClaudeOauth(candidate, {
    now: () => NOW,
    lockWaitMs: 100,
    fetch: async () => {
      fetchCalls += 1;
      return new Response(null, { status: 503 });
    },
  });

  expect(result).toBe("refreshed");
  expect(fetchCalls).toBe(0);
});

test("custom OAuth credentials stay on a CLI-approved issuer", async () => {
  const candidate = account("custom-origin");
  const previous = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL;
  process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = "https://claude.fedstart.com";
  let requestedUrl = "";
  try {
    const result = await refreshClaudeOauth(candidate, {
      now: () => NOW,
      fetch: async (input) => {
        requestedUrl = String(input);
        return Response.json({ access_token: crypto.randomUUID(), expires_in: 3_600 });
      },
    });

    expect(result).toBe("refreshed");
    expect(requestedUrl).toBe("https://claude.fedstart.com/v1/oauth/token");
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL;
    else process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = previous;
  }
});

test("an unapproved custom OAuth origin never receives credential content", async () => {
  const candidate = account("unapproved-origin");
  const previous = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL;
  process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = "https://example.test";
  let fetchCalls = 0;
  try {
    const result = await refreshClaudeOauth(candidate, {
      now: () => NOW,
      fetch: async () => {
        fetchCalls += 1;
        return new Response(null, { status: 503 });
      },
    });

    expect(result).toBe("unknown");
    expect(fetchCalls).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL;
    else process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = previous;
  }
});
