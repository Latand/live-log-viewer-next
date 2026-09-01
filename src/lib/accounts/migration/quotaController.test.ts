import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CodexAccount } from "@/lib/accounts/codex";

import type { QuotaProbePort } from "./quotaController";

const QUOTA_SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-quota-controller-suite-"));
const PREVIOUS_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(QUOTA_SANDBOX, "state");

const { AgentRegistry } = await import("@/lib/agent/registry");
const { withAccountMutationLockAsync } = await import("@/lib/accounts/accountMutation");
const { QuotaController } = await import("./quotaController");

afterAll(() => {
  if (PREVIOUS_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = PREVIOUS_STATE;
  fs.rmSync(QUOTA_SANDBOX, { recursive: true, force: true });
});

test("quota probes wait behind account deletion mutations", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-quota-fence-"));
  try {
    const registry = new AgentRegistry(path.join(root, "registry.json"));
    const account: CodexAccount = { id: "managed", label: "Managed", kind: "managed", home: "/homes/managed", sessionsDir: "/homes/managed/sessions", authPresent: true, loginPane: null, createdAt: 1 };
    let probes = 0;
    const controller = new QuotaController(registry, {
      list: () => [account],
      active: () => account.id,
      async probe(engine, candidate, now) {
        probes += 1;
        return { engine, accountId: candidate.id, authenticated: true, authCheckedAt: now, limits: null, provenance: { source: "live", reason: null, staleSince: null }, observedAt: now };
      },
    });
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const acquired = new Promise<void>((resolve) => { entered = resolve; });
    const holder = withAccountMutationLockAsync(async () => { entered(); await held; });
    await acquired;

    const tick = controller.tick("codex");
    await Bun.sleep(10);
    expect(probes).toBe(0);
    release();
    await holder;
    await tick;
    expect(probes).toBe(1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("quota visibility remains fresh when automatic balancing is disabled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-quota-controller-"));
  try {
    const registry = new AgentRegistry(path.join(root, "registry.json"));
    let listed = 0;
    let current = Date.parse("2026-07-10T12:00:00.000Z");
    const accounts: CodexAccount[] = [
      { id: "default", label: "Main", kind: "legacy", home: "/homes/main", sessionsDir: "/homes/main/sessions", authPresent: true, loginPane: null, createdAt: 0 },
      { id: "managed", label: "Managed", kind: "managed", home: "/homes/managed", sessionsDir: "/homes/managed/sessions", authPresent: true, loginPane: null, createdAt: 1 },
    ];
    const probe: QuotaProbePort = {
      list() { listed += 1; return accounts; },
      active() { return "default"; },
      async probe(engine, candidate, now) {
        return {
          engine,
          accountId: candidate.id,
          authenticated: true,
          authCheckedAt: now,
          limits: {
            session: { usedPercent: candidate.id === "default" ? 100 : 10, resetsAt: Math.floor(now / 1000) + 3_600 },
            weekly: null,
            plan: "pro",
            capturedAt: Math.floor(now / 1000),
          },
          provenance: { source: "live", reason: null, staleSince: null },
          observedAt: now,
        };
      },
    };
    const controller = new QuotaController(registry, probe, "boot-visibility-test", () => current);

    registry.setAutoBalancePolicy("codex", false);
    await controller.tick("codex");
    current += 60_000;
    await controller.tick("codex");
    expect(listed).toBe(2);
    expect(registry.snapshot().quotaObservations.codex.default).toMatchObject({
      authenticated: true,
      limits: { session: { usedPercent: 100 } },
    });
    expect(registry.snapshot().quotaObservations.codex.managed).toMatchObject({
      authenticated: true,
      limits: { session: { usedPercent: 10 } },
    });
    expect(Object.values(registry.snapshot().migrationIntents)).toHaveLength(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed probe keeps the last known limits instead of blanking them", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-quota-carry-"));
  try {
    const registry = new AgentRegistry(path.join(root, "registry.json"));
    const accounts: CodexAccount[] = [
      { id: "default", label: "Main", kind: "legacy", home: "/homes/main", sessionsDir: "/homes/main/sessions", authPresent: true, loginPane: null, createdAt: 0 },
    ];
    let current = Date.parse("2026-07-10T12:00:00.000Z");
    let fail = false;
    const controller = new QuotaController(registry, {
      list: () => accounts,
      active: () => "default",
      async probe(engine, account, now) {
        if (fail) throw new Error("provider down");
        return {
          engine,
          accountId: account.id,
          authenticated: true,
          authCheckedAt: now,
          limits: { session: { usedPercent: 30, resetsAt: null }, weekly: null, plan: "pro", capturedAt: Math.floor(now / 1000) },
          provenance: { source: "live" as const, reason: null, staleSince: null },
          observedAt: now,
        };
      },
    }, "boot-carry-forward-test", () => current);
    await controller.tick("codex");
    const firstObservedAt = registry.snapshot().quotaObservations.codex.default!.observedAt;
    fail = true;
    current += 120_000;
    await controller.tick("codex");
    const carried = registry.snapshot().quotaObservations.codex.default!;
    expect(carried.limits?.session?.usedPercent).toBe(30);
    expect(carried.authenticated).toBeTrue();
    expect(carried.provenance).toMatchObject({ source: "cache", reason: "quota-probe-failed" });
    expect(carried.provenance.staleSince).toBe(firstObservedAt);
    expect(carried.observedAt).toBe(firstObservedAt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a hung probe times out without delaying or blanking the other accounts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-quota-hang-"));
  try {
    const registry = new AgentRegistry(path.join(root, "registry.json"));
    const accounts: CodexAccount[] = [
      { id: "default", label: "Main", kind: "legacy", home: "/homes/main", sessionsDir: "/homes/main/sessions", authPresent: true, loginPane: null, createdAt: 0 },
      { id: "managed", label: "Managed", kind: "managed", home: "/homes/managed", sessionsDir: "/homes/managed/sessions", authPresent: true, loginPane: null, createdAt: 1 },
    ];
    const controller = new QuotaController(registry, {
      list: () => accounts,
      active: () => "default",
      async probe(engine, account, now) {
        if (account.id === "default") return await new Promise<never>(() => { /* wedged provider */ });
        return {
          engine,
          accountId: account.id,
          authenticated: true,
          authCheckedAt: now,
          limits: { session: { usedPercent: 40, resetsAt: null }, weekly: null, plan: "pro", capturedAt: Math.floor(now / 1000) },
          provenance: { source: "live" as const, reason: null, staleSince: null },
          observedAt: now,
        };
      },
    }, "boot-hung-probe-test", () => Date.parse("2026-07-10T12:00:00.000Z"), 50);
    await controller.tick("codex");
    expect(registry.snapshot().quotaObservations.codex.default?.provenance).toMatchObject({ source: "unavailable", reason: "quota-probe-timeout" });
    expect(registry.snapshot().quotaObservations.codex.managed?.limits?.session?.usedPercent).toBe(40);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a live sign-out answer replaces the cached limits instead of hiding behind them", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-quota-signout-"));
  try {
    const registry = new AgentRegistry(path.join(root, "registry.json"));
    const accounts: CodexAccount[] = [
      { id: "default", label: "Main", kind: "legacy", home: "/homes/main", sessionsDir: "/homes/main/sessions", authPresent: true, loginPane: null, createdAt: 0 },
    ];
    let current = Date.parse("2026-07-10T12:00:00.000Z");
    let signedOut = false;
    const controller = new QuotaController(registry, {
      list: () => accounts,
      active: () => "default",
      async probe(engine, account, now) {
        if (signedOut) {
          return {
            engine,
            accountId: account.id,
            authenticated: false,
            authCheckedAt: now,
            limits: null,
            provenance: { source: "live" as const, reason: null, staleSince: null },
            observedAt: now,
          };
        }
        return {
          engine,
          accountId: account.id,
          authenticated: true,
          authCheckedAt: now,
          limits: { session: { usedPercent: 25, resetsAt: null }, weekly: null, plan: "pro", capturedAt: Math.floor(now / 1000) },
          provenance: { source: "live" as const, reason: null, staleSince: null },
          observedAt: now,
        };
      },
    }, "boot-signout-test", () => current);
    await controller.tick("codex");
    signedOut = true;
    current += 120_000;
    await controller.tick("codex");
    const observation = registry.snapshot().quotaObservations.codex.default!;
    expect(observation.authenticated).toBeFalse();
    expect(observation.limits).toBeNull();
    expect(observation.provenance.source).toBe("live");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed home records a closed code while the controller sweeps later homes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-quota-sweep-"));
  try {
    const registry = new AgentRegistry(path.join(root, "registry.json"));
    const accounts: CodexAccount[] = [
      { id: "default", label: "Main", kind: "legacy", home: "/homes/main", sessionsDir: "/homes/main/sessions", authPresent: true, loginPane: null, createdAt: 0 },
      { id: "managed", label: "Managed", kind: "managed", home: "/homes/managed", sessionsDir: "/homes/managed/sessions", authPresent: true, loginPane: null, createdAt: 1 },
    ];
    const visited: string[] = [];
    const controller = new QuotaController(registry, {
      list: () => accounts,
      active: () => "default",
      async probe(engine, account, now) {
        visited.push(account.id);
        if (account.id === "default") throw new Error("access_token=secret");
        return {
          engine,
          accountId: account.id,
          authenticated: true,
          authCheckedAt: now,
          limits: { session: { usedPercent: 20, resetsAt: null }, weekly: null, plan: "pro", capturedAt: Math.floor(now / 1000) },
          provenance: { source: "live" as const, reason: null, staleSince: null },
          observedAt: now,
        };
      },
    }, "boot-sweep-test", () => Date.parse("2026-07-10T12:00:00.000Z"));
    await controller.tick("codex");
    expect(visited.sort()).toEqual(["default", "managed"]);
    expect(registry.snapshot().quotaObservations.codex.default?.provenance.reason).toBe("quota-probe-failed");
    expect(JSON.stringify(registry.snapshot())).not.toContain("secret");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the controller records the probe's reset credits and carries them through a failed tick (#1373)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-quota-reset-credits-"));
  try {
    const registry = new AgentRegistry(path.join(root, "registry.json"));
    const account: CodexAccount = { id: "credited", label: "Account A", kind: "managed", home: "/homes/credited", sessionsDir: "/homes/credited/sessions", authPresent: true, loginPane: null, createdAt: 1 };
    let fail = false;
    const controller = new QuotaController(registry, {
      list: () => [account],
      active: () => account.id,
      async probe(engine, candidate, now) {
        if (fail) throw new Error("offline");
        return {
          engine,
          accountId: candidate.id,
          authenticated: true,
          authCheckedAt: now,
          limits: { session: null, weekly: { usedPercent: 100, resetsAt: Math.floor(now / 1000) + 86_400, windowMinutes: 10_080 }, plan: "pro", capturedAt: Math.floor(now / 1000) },
          provenance: { source: "live", reason: null, staleSince: null },
          observedAt: now,
          resetCredits: { availableCount: 1, expiresAt: Math.floor(now / 1000) + 20 * 86_400 },
        };
      },
    }, "boot-reset-credits");
    await controller.tick("codex");
    expect(registry.quotaObservations("codex")[0]).toMatchObject({ accountId: "credited", resetCredits: { availableCount: 1 } });

    fail = true;
    await controller.tick("codex");
    const carried = registry.quotaObservations("codex")[0]!;
    expect(carried.provenance.source).toBe("cache");
    expect(carried.resetCredits).toMatchObject({ availableCount: 1 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
