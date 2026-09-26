import { afterAll, beforeEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-login-route-test-"));
const oldState = process.env.LLV_STATE_DIR;
const oldHome = process.env.LLV_CLAUDE_HOME;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_CLAUDE_HOME = path.join(sandbox, "legacy");

const { ClaudeLoginSupervisor, setClaudeLoginSupervisorForTests } = await import("@/lib/accounts/claudeLogin");
const { claudeProjectRoots, claudeRegistryPath, createManagedClaudeAccount, listClaudeAccounts } = await import("@/lib/accounts/claude");
const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
const { resetAccountCollectionsForTests } = await import("@/lib/accounts/accountsStore");
const { seedAccountRegistry } = await import("@/lib/accounts/accountsStoreFixture");
const { SqliteStateCollection } = await import("@/lib/state/sqliteStateStore");
const { agentRegistry } = await import("@/lib/agent/registry");
const { retiredAccountArchive, setAccountRemovalCheckpointForTests } = await import("@/lib/accounts/removal");

function deleteRequest(body: unknown) {
  return new NextRequest("http://127.0.0.1/api/accounts/claude", {
    method: "DELETE", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
const { DELETE: remove, PATCH, POST } = await import("./route");
const { DELETE } = await import("./login/[operationId]/route");
const { POST: submitInput } = await import("./login/[operationId]/input/route");

class FakeChild extends EventEmitter {
  pid = 4312;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: () => true, end: () => undefined };
}

let child: FakeChild;

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  resetAccountCollectionsForTests();
  fs.rmSync(path.join(sandbox, "accounts"), { recursive: true, force: true });
  fs.rmSync(path.join(sandbox, "shared"), { recursive: true, force: true });
  child = new FakeChild();
  setClaudeLoginSupervisorForTests(new ClaudeLoginSupervisor({
    spawn: () => child as never,
    kill: () => undefined,
    pidStartToken: () => "start-4312",
    isExpectedClaude: () => true,
    waitForExit: async () => undefined,
    status: async () => ({ loggedIn: false, method: null, email: null, plan: null }),
    now: () => 1_000,
    setTimeout: (callback, ms) => { if (ms <= 2_000) callback(); return {} as NodeJS.Timeout; },
    clearTimeout: () => undefined,
  }));
});

afterAll(() => {
  setClaudeLoginSupervisorForTests(null);
  if (oldState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = oldState;
  if (oldHome === undefined) delete process.env.LLV_CLAUDE_HOME;
  else process.env.LLV_CLAUDE_HOME = oldHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("POST starts Claude login in a clean environment with the shared operation shape", async () => {
  const response = await POST(new NextRequest("http://127.0.0.1/api/accounts/claude", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ label: "Clean account" }),
  }));

  expect(response.status).toBe(202);
  await expect(response.json()).resolves.toEqual(expect.objectContaining({
    account: expect.objectContaining({ id: "clean-account", kind: "managed" }),
    login: expect.objectContaining({ phase: "awaiting_browser", result: null }),
    target: "claude-auth-login",
  }));
});

test("provider create and edit read a model catalogue and never return the token", async () => {
  const secret = ["local", "route", "fixture", "token"].join("-");
  let sawToken = false;
  let modelPath = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    sawToken = request.headers.get("authorization") === `Bearer ${secret}`;
    modelPath = new URL(request.url).pathname;
    return Response.json({ data: [{ id: "provider-large" }, { id: "provider-small" }] });
  } });
  const request = (method: "POST" | "PATCH", body: unknown) => new NextRequest("http://127.0.0.1/api/accounts/claude", {
    method, headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const config = { baseUrl: `http://127.0.0.1:${server.port}/zen/go`, model: "provider-large", smallFastModel: "provider-small", token: secret };
    const created = await POST(request("POST", { label: "Provider", provider: config }));
    expect(created.status).toBe(201);
    const body = await created.text();
    expect(body).not.toContain(secret);
    expect(JSON.parse(body).models).toEqual(["provider-large", "provider-small"]);
    expect(sawToken).toBe(true);
    expect(modelPath).toBe("/zen/go/v1/models");
    const id = JSON.parse(body).account.id as string;
    const edited = await PATCH(request("PATCH", { id, label: "Updated", provider: { ...config, token: undefined, smallFastModel: null } }));
    expect(edited.status).toBe(200);
    expect(await edited.text()).not.toContain(secret);
    expect(listClaudeAccounts().find((account) => account.id === id)?.label).toBe("Updated");
    const models = await POST(request("POST", { action: "provider-models", id, provider: { ...config, token: undefined } }));
    expect(models.status).toBe(200);
    expect(sawToken).toBe(true);
  } finally { server.stop(); }
});

test("provider authentication failure stays on the account form", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(null, { status: 401 }); } });
  try {
    const response = await POST(new NextRequest("http://127.0.0.1/api/accounts/claude", {
      method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ label: "Rejected", provider: { baseUrl: `http://127.0.0.1:${server.port}`, token: "fixture-token", model: "fixture-model" } }),
    }));
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("provider_auth_failed");
    expect(listClaudeAccounts().some((account) => account.label === "Rejected")).toBe(false);
  } finally { server.stop(); }
});

test("one login is admitted at a time, then cancel and retry create a fresh operation", async () => {
  const create = () => POST(new NextRequest("http://127.0.0.1/api/accounts/claude", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ label: "Retry account" }),
  }));
  const first = await create();
  const firstBody = await first.json() as { account: { id: string }; login: { operationId: string } };

  const busy = await create();
  expect(busy.status).toBe(409);
  await expect(busy.json()).resolves.toEqual({ error: "A Claude login operation is already running", code: "login_busy" });

  const canceled = await DELETE(new NextRequest(`http://127.0.0.1/api/accounts/claude/login/${firstBody.login.operationId}`, {
    method: "DELETE", headers: { host: "127.0.0.1" },
  }), { params: Promise.resolve({ operationId: firstBody.login.operationId }) });
  expect(canceled.status).toBe(200);
  const retry = await POST(new NextRequest("http://127.0.0.1/api/accounts/claude", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ action: "retry", id: firstBody.account.id }),
  }));
  const retryBody = await retry.json() as { login: { operationId: string }; target: string };

  expect(retry.status).toBe(202);
  expect(retryBody.target).toBe("claude-auth-login");
  expect(retryBody.login.operationId).not.toBe(firstBody.login.operationId);
});

test("retry reauthenticates legacy Main in place through the supervised flow (issue #470)", async () => {
  const retry = await POST(new NextRequest("http://127.0.0.1/api/accounts/claude", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ action: "retry", id: "default" }),
  }));

  expect(retry.status).toBe(202);
  const body = await retry.json() as { account: { id: string; kind: string }; login: { phase: string }; target: string };
  expect(body.account).toEqual(expect.objectContaining({ id: "default", kind: "legacy" }));
  expect(body.login.phase).toBe("awaiting_browser");
  expect(body.target).toBe("claude-auth-login");
});

test("a managed account erroring with credentials present retries in place, keeping its identity (issue #470)", async () => {
  const created = await POST(new NextRequest("http://127.0.0.1/api/accounts/claude", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ label: "Erroring managed" }),
  }));
  const createdBody = await created.json() as { account: { id: string }; login: { operationId: string } };
  // Cancel the create's live op, then write a safe credential file — the account
  // now looks like production's error case: credentials present but reauth needed.
  await DELETE(new NextRequest(`http://127.0.0.1/api/accounts/claude/login/${createdBody.login.operationId}`, {
    method: "DELETE", headers: { host: "127.0.0.1" },
  }), { params: Promise.resolve({ operationId: createdBody.login.operationId }) });
  fs.writeFileSync(path.join(sandbox, "accounts", "claude", createdBody.account.id, ".credentials.json"), "{}", { mode: 0o600 });

  const retry = await POST(new NextRequest("http://127.0.0.1/api/accounts/claude", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ action: "retry", id: createdBody.account.id }),
  }));

  expect(retry.status).toBe(202);
  const retryBody = await retry.json() as { account: { id: string; kind: string }; login: { phase: string; operationId: string } };
  expect(retryBody.account).toEqual(expect.objectContaining({ id: createdBody.account.id, kind: "managed" }));
  expect(retryBody.login.phase).toBe("awaiting_browser");
  expect(retryBody.login.operationId).not.toBe(createdBody.login.operationId);
});

test("a failed legacy retry returns a sanitized, retryable error and never leaks detail (issue #470)", async () => {
  setClaudeLoginSupervisorForTests(new ClaudeLoginSupervisor({
    spawn: () => child as never,
    kill: () => undefined,
    pidStartToken: () => null, // fails the launch fence
    isExpectedClaude: () => true,
    waitForExit: async () => undefined,
    status: async () => ({ loggedIn: false, method: null, email: null, plan: null }),
    now: () => 1_000,
    setTimeout: (callback, ms) => { if (ms <= 2_000) callback(); return {} as NodeJS.Timeout; },
    clearTimeout: () => undefined,
  }));

  const retry = await POST(new NextRequest("http://127.0.0.1/api/accounts/claude", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ action: "retry", id: "default" }),
  }));

  expect(retry.status).toBe(503);
  const body = await retry.json() as { error: string; code: string };
  expect(body.code).toBe("launch_unfenced");
  expect(JSON.stringify(body)).not.toContain("/proc/");
});

test("the authorization code is accepted through stdin and never appears in the response", async () => {
  const created = await POST(new NextRequest("http://127.0.0.1/api/accounts/claude", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ label: "Protocol account" }),
  }));
  const body = await created.json() as { login: { operationId: string } };
  child.stdout.emit("data", "Open https://claude.ai/authorize?state=browser-state");
  const code = "authorizationCode#state";

  const submitted = await submitInput(new NextRequest(`http://127.0.0.1/api/accounts/claude/login/${body.login.operationId}/input`, {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ code }),
  }), { params: Promise.resolve({ operationId: body.login.operationId }) });
  const submittedBody = await submitted.json();

  expect(submitted.status).toBe(200);
  expect(submittedBody).toEqual({ login: expect.objectContaining({ phase: "verifying", acceptsCode: false }) });
  expect(JSON.stringify(submittedBody)).not.toContain(code);
});

test("managed Claude removal cannot bypass a live login with force", async () => {
  const created = await POST(new NextRequest("http://127.0.0.1/api/accounts/claude", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ label: "Remove me" }),
  }));
  const { account } = await created.json() as { account: { id: string } };

  const blocked = await remove(new NextRequest("http://127.0.0.1/api/accounts/claude", {
    method: "DELETE",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ id: account.id }),
  }));
  expect(blocked.status).toBe(409);
  await expect(blocked.json()).resolves.toEqual(expect.objectContaining({ code: "account_removal_blocked", blockers: ["login_pending"] }));

  const forced = await remove(new NextRequest("http://127.0.0.1/api/accounts/claude", {
    method: "DELETE",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ id: account.id, force: true }),
  }));
  expect(forced.status).toBe(409);
  await expect(forced.json()).resolves.toEqual(expect.objectContaining({ code: "account_removal_blocked", blockers: ["login_pending"] }));
});

test("managed Claude removal reports pending cleanup when a credential stays in the archive", async () => {
  const account = createManagedClaudeAccount("Cleanup pending");
  fs.writeFileSync(path.join(account.home, ".credentials.json"), "{}", { mode: 0o600 });
  const originalUnlink = fs.unlinkSync;
  fs.unlinkSync = ((target: fs.PathLike) => {
    if (path.basename(String(target)) === ".credentials.json") throw Object.assign(new Error("denied"), { code: "EACCES" });
    return originalUnlink(target);
  }) as typeof fs.unlinkSync;
  try {
    const response = await remove(deleteRequest({ id: account.id }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ removed: { id: account.id }, cleanupPending: true });
    /* The clean-up names the account while its sign-in file is still stuck,
       so the dialog never says the file was deleted (#1857). */
    const stuck = await remove(deleteRequest({ cleanupOrphans: true }));
    await expect(stuck.json()).resolves.toMatchObject({ unresolved: [account.id] });
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  const finished = await remove(deleteRequest({ cleanupOrphans: true }));
  const report = await finished.json() as { unresolved: string[] };
  expect(report.unresolved).not.toContain(account.id);
  expect(fs.existsSync(path.join(retiredAccountArchive("claude", account.id), ".credentials.json"))).toBe(false);
});

test("managed Claude removal retires routing and migration intents targeting the account", async () => {
  const account = createManagedClaudeAccount("Routed removal");
  const registry = agentRegistry();
  registry.setEngineRouting("claude", account.id);
  const intent = registry.commitMigrationIntent({
    engine: "claude",
    targetId: account.id,
    origin: "manual",
    requestId: "remove-routed-claude",
    expectedRevision: registry.engineRouting("claude").revision,
  });

  const response = await remove(new NextRequest("http://127.0.0.1/api/accounts/claude", {
    method: "DELETE", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ id: account.id }),
  }));

  expect(response.status).toBe(200);
  expect(registry.engineRouting("claude").activeAccountId).toBe("default");
  expect(registry.snapshot().migrationIntents[intent.id]?.state).toBe("stopped");
});

test("managed Claude removal restores routing and the home when the accounts registry cannot commit", async () => {
  const account = createManagedClaudeAccount("Commit failure");
  const registry = agentRegistry();
  registry.setEngineRouting("claude", account.id);
  const before = registry.snapshot();
  /* Since #1870 the accounts registry commit is one SQLite transaction, so the
     write that can fail is that commit. */
  const originalPatch = SqliteStateCollection.prototype.patchSync;
  let retired = false;
  setAccountRemovalCheckpointForTests((reached) => { if (reached === "registry-retired") retired = true; });
  SqliteStateCollection.prototype.patchSync = function patchSync(this: { signature(): string }, ...args: unknown[]) {
    if (retired && this.signature().includes(":accounts:")) {
      retired = false;
      throw Object.assign(new Error("registry write denied"), { code: "EACCES" });
    }
    return (originalPatch as (...rest: unknown[]) => void).apply(this, args);
  } as typeof SqliteStateCollection.prototype.patchSync;

  try {
    const response = await remove(deleteRequest({ id: account.id }));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ code: "removal_failed", errno: "EACCES" }));
    expect(registry.snapshot().engineRouting).toEqual(before.engineRouting);
    expect(fs.existsSync(account.home)).toBe(true);
    expect(listClaudeAccounts().map((candidate) => candidate.id)).toContain(account.id);
  } finally {
    SqliteStateCollection.prototype.patchSync = originalPatch;
    setAccountRemovalCheckpointForTests(null);
  }
});

test("managed Claude removal stays blocked while a migration is in flight on the account", async () => {
  const account = createManagedClaudeAccount("Current history");
  const registry = agentRegistry();
  const conversation = registry.ensureConversation("claude", "/current-claude.jsonl", account.id);
  registry.setConversationMigration(conversation.id, {
    intentId: "intent-moving", phase: "preparing", targetId: "default", revision: 1, error: null, updatedAt: new Date().toISOString(),
  });

  const response = await remove(deleteRequest({ id: account.id, force: true }));

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual(expect.objectContaining({ code: "account_removal_blocked", blockers: ["current_conversations"] }));
  expect(fs.existsSync(account.home)).toBe(true);
});

test("force cannot bypass an in-flight spawn assigned to the account", async () => {
  const account = createManagedClaudeAccount("In-flight spawn");
  beginLegacySpawnFixture(agentRegistry(), { engine: "claude", cwd: "/repo", accountId: account.id });

  const response = await remove(new NextRequest("http://127.0.0.1/api/accounts/claude", {
    method: "DELETE", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ id: account.id, force: true }),
  }));

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual(expect.objectContaining({ blockers: ["live_sessions"] }));
  expect(fs.existsSync(account.home)).toBe(true);
  expect(listClaudeAccounts().map((candidate) => candidate.id)).toContain(account.id);
});

test("a launch queued for the account's capacity answers queued_pin, apart from a running agent (#1857)", async () => {
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const account = createManagedClaudeAccount("Queued launch");
  const store = agentRegistry();
  const launchProfile = emptyLaunchProfile({ cwd: "/repo", title: "Queued account work" });
  const begun = beginLegacySpawnFixture(store, { engine: "claude", cwd: "/repo", transport: "structured", accountId: account.id, accountPin: true, launchProfile });
  if (begun.kind !== "created") throw new Error("expected a queued receipt");
  store.queuePinnedSpawn(begun.receipt.launchId, {
    version: 1,
    retryAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    accountId: account.id,
    locale: "en",
    spec: { engine: "claude", command: "claude", cwd: "/repo", windowName: "queued-pin", launchProfile },
    ["prompt"]: "continue",
    imageRefs: [],
    parentArtifactPath: null,
    pipelineSourceConversationId: null,
  }, "queued for account capacity");
  store.releaseStartingStructuredSpawn(begun.receipt.launchId, begun.receipt.admissionOwner!);

  const response = await remove(deleteRequest({ id: account.id }));

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual(expect.objectContaining({ code: "account_removal_blocked", blockers: ["queued_pin"] }));
  expect(fs.existsSync(account.home)).toBe(true);
});

test("a Claude home with leftover history is removed and the answer says what moved (#1857)", async () => {
  const account = createManagedClaudeAccount("Unowned history");
  const transcript = path.join(account.projectsDir, "-repo", "unowned.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true, mode: 0o700 });
  fs.writeFileSync(transcript, "{}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(account.home, "history.jsonl"), "{}\n", { mode: 0o600 });
  const conversation = agentRegistry().ensureConversation("claude", transcript, account.id);
  agentRegistry().setConversationMigration(conversation.id, {
    intentId: "intent-parked", phase: "failed-recoverable", targetId: "default", revision: 1, error: "parked", updatedAt: new Date().toISOString(),
  });
  const archive = retiredAccountArchive("claude", account.id);

  const response = await remove(deleteRequest({ id: account.id, force: true }));

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    removed: { id: account.id },
    cleanupPending: false,
    moved: { archive, files: 2, bytes: 6 },
    conversationsRewritten: 1,
    pinsCleared: 0,
    deliveriesDropped: 0,
    migrationsSettled: 1,
  });
  expect(fs.readFileSync(path.join(archive, path.relative(account.home, transcript)), "utf8")).toBe("{}\n");
  expect(listClaudeAccounts().map((candidate) => candidate.id)).not.toContain(account.id);
});

test("an occupied Claude archive destination answers archive_unavailable", async () => {
  const account = createManagedClaudeAccount("Taken archive");
  const archive = retiredAccountArchive("claude", account.id);
  fs.mkdirSync(archive, { recursive: true, mode: 0o700 });

  const response = await remove(deleteRequest({ id: account.id }));

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual(expect.objectContaining({ code: "archive_unavailable", archive }));
  expect(fs.existsSync(account.home)).toBe(true);
});

test("an unsafe Claude home refuses removal and nothing moves", async () => {
  const account = createManagedClaudeAccount("Unsafe home");
  fs.chmodSync(account.home, 0o755);

  const response = await remove(deleteRequest({ id: account.id }));

  // An unsafe home already makes the accounts registry read-only.
  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual(expect.objectContaining({ code: "accounts_locked" }));
  expect(fs.existsSync(account.home)).toBe(true);
  expect(fs.existsSync(retiredAccountArchive("claude", account.id))).toBe(false);
});

test("managed Claude removal proceeds over dead history and keeps its transcripts readable (issue #643)", async () => {
  const account = createManagedClaudeAccount("Dead history");
  const registry = agentRegistry();
  const transcript = path.join(account.projectsDir, "-repo", "99999999-1234-1234-1234-123456789abc.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true, mode: 0o700 });
  fs.writeFileSync(transcript, "{\"cwd\":\"/repo\"}\n", { mode: 0o600 });
  const conversation = registry.ensureConversation("claude", transcript, account.id);
  fs.writeFileSync(path.join(account.home, ".credentials.json"), "{}", { mode: 0o600 });

  const response = await remove(deleteRequest({ id: account.id }));

  expect(response.status).toBe(200);
  // History survives the home: same bytes and conversation identity, in the archive.
  const archive = retiredAccountArchive("claude", account.id);
  const moved = path.join(archive, path.relative(account.home, transcript));
  expect(fs.readFileSync(moved, "utf8")).toBe("{\"cwd\":\"/repo\"}\n");
  expect(claudeProjectRoots()).toContain(path.join(archive, "projects"));
  expect(registry.conversationForPath(moved)?.id).toBe(conversation.id);
  expect(fs.existsSync(path.join(archive, ".credentials.json"))).toBe(false);
});

test("managed Claude removal reports a corrupt registry as locked", async () => {
  /* A record the store cannot turn into an account list; since #1870 that is a
     row it refuses on rather than bytes that will not parse. */
  seedAccountRegistry("claude", { version: 1, active: "default", accounts: [{ id: "phantom", label: "Phantom", kind: "managed" }], retired: [], removals: [] });

  const response = await remove(new NextRequest("http://127.0.0.1/api/accounts/claude", {
    method: "DELETE", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ id: "missing" }),
  }));

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual(expect.objectContaining({ code: "accounts_locked" }));
});
