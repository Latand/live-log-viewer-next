import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";

import type { ClaudeAccount } from "./claude";
import { NoHealthyClaudeAccountError, selectHealthyClaudeAccount } from "./spawnHealth";

const NOW = Date.parse("2026-07-14T09:00:00.000Z");
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function account(id: string, expiresAt: number, authPresent = true): ClaudeAccount {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `llv-spawn-health-${id}-`));
  homes.push(home);
  fs.writeFileSync(path.join(home, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: `${id}-token`, refreshToken: `${id}-refresh`, expiresAt },
  }), { mode: 0o600 });
  return { id, label: id, kind: "managed", home, projectsDir: path.join(home, "projects"), authPresent, createdAt: 0 };
}

test("spawn selection skips an expired preferred Claude account and probes a healthy fallback", async () => {
  const expired = account("expired", NOW - 1);
  const healthy = account("healthy", NOW + 60_000);
  const probed: string[] = [];

  const selected = await selectHealthyClaudeAccount([expired, healthy], "expired", {
    now: () => NOW,
    probe: async (candidate) => {
      probed.push(candidate.id);
      return "valid";
    },
  });

  expect(selected.id).toBe("healthy");
  expect(probed).toEqual(["healthy"]);
});

test("spawn selection ranks a live-valid account above a transiently unverifiable preferred account", async () => {
  const preferred = account("preferred", NOW + 60_000);
  const confirmed = account("confirmed", NOW + 60_000);

  const selected = await selectHealthyClaudeAccount([preferred, confirmed], "preferred", {
    now: () => NOW,
    probe: async (candidate) => candidate.id === "confirmed" ? "valid" : "unknown",
  });

  expect(selected.id).toBe("confirmed");
});

test("spawn selection reports every dead account when none can launch", async () => {
  const expired = account("expired", NOW - 1);
  const rejected = account("rejected", NOW + 60_000);

  try {
    await selectHealthyClaudeAccount([expired, rejected], "expired", {
      now: () => NOW,
      probe: async () => "invalid",
    });
    throw new Error("expected selection to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(NoHealthyClaudeAccountError);
    expect((error as Error).message).toContain("expired");
    expect((error as Error).message).toContain("rejected");
    expect((error as Error).message).toContain("Re-login");
  }
});
