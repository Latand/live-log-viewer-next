import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { identityAlive, livenessProbe } from "@/lib/agent/accountLiveness";
import type { AgentRegistryEntry } from "@/lib/agent/registry";
import { projectRateLimitReadModel } from "@/lib/rateLimit";
import type { FileEntry } from "@/lib/types";

import { formatRateLimitTime } from "./rateLimit";
import { providerThrottleStatusLine, SwitchCard, type SwitchCardTone } from "./SwitchCard";

/**
 * Issue #961: the switch card carries the same status vocabulary as the board
 * cards — one projected word, quiet cards none — beside its existing free-text
 * status line, which stays untouched.
 */

const NOW_S = Date.now() / 1000;

function file(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/sessions/a.jsonl",
    root: "claude-projects",
    name: "a.jsonl",
    project: "demo",
    title: "Session",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: NOW_S - 30,
    size: 1,
    activity: "recent",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  } as unknown as FileEntry;
}

function card(entry: FileEntry, tone: SwitchCardTone = "working", statusLine = "working on the release"): string {
  return renderToStaticMarkup(
    <SwitchCard
      file={entry}
      title="Session"
      project="demo"
      currentProject="demo"
      descendants={0}
      statusLine={statusLine}
      size="large"
      tone={tone}
      onOpen={() => {}}
      onArchive={() => {}}
    />,
  );
}

test("a blocked switch card carries the needs-you word; a quiet one carries none", () => {
  const blocked = card(file({ waitingInput: { since: NOW_S - 40 } as FileEntry["waitingInput"] }));
  expect(blocked).toContain('data-card-status="needs-you"');
  expect(blocked).toContain("needs you");
  expect(card(file())).not.toContain("data-card-status");
});

test("the existing status line survives beside the projected word", () => {
  const blocked = card(file({ waitingInput: { since: NOW_S - 40 } as FileEntry["waitingInput"] }));
  expect(blocked).toContain("working on the release");
});

test("a provider-throttled card names its resume time in English and Ukrainian", () => {
  const resetAt = NOW_S + 60 * 60;
  const retryAt = new Date(resetAt * 1000).toISOString();
  const throttled = {
    ...file({
      activity: "stalled",
      authoritativeTurn: { state: "busy", source: "lifecycle", terminalAt: null },
    }),
    providerThrottle: { reason: "provider_throttled" as const, retryAt },
  };

  expect(providerThrottleStatusLine(throttled, "en")).toBe(
    `provider is throttling — resumes at ${formatRateLimitTime(resetAt, "en")}`,
  );
  expect(providerThrottleStatusLine(throttled, "uk")).toBe(
    `провайдер обмежує частоту — продовжить о ${formatRateLimitTime(resetAt, "uk")}`,
  );
  const html = card(throttled);
  expect(html).toContain("provider is throttling");
  expect(html).toContain('data-card-status="queued"');
  expect(html).toContain('data-tone="waiting"');
  expect(html).not.toContain("working on the release");
  expect(html).not.toContain("rate-limited until");
  expect(html).not.toContain("data-rate-limit-reseat");
});

test("dead and reused structured-host identities keep stalled card rendering", () => {
  const accountId = "account-a";
  const retryAt = new Date((NOW_S + 60 * 60) * 1000).toISOString();
  const registryEntry = (pathName: string, pid: number, startIdentity: string): AgentRegistryEntry => ({
    key: { engine: "codex", sessionId: `session-${pid}` },
    artifactPath: pathName,
    cwd: "/workspace",
    accountId,
    status: "live",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:owned",
      process: { pid, startIdentity },
      eventCursor: 1,
      protocolVersion: null,
      writerClaimEpoch: 1,
      activeTurnRef: "turn-1",
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: null,
    pendingAction: null,
    updatedAt: new Date((NOW_S - 10 * 60) * 1000).toISOString(),
  });
  const paths = ["/sessions/dead.jsonl", "/sessions/reused.jsonl"];
  const snapshot = {
    entries: {
      dead: registryEntry(paths[0]!, 502, "start-dead"),
      reused: registryEntry(paths[1]!, 503, "start-original"),
    },
    conversations: {
      conversation_impl: {
        id: "conversation_impl",
        engine: "codex" as const,
        generations: paths.map((pathName) => ({ path: pathName, accountId })),
      },
    },
    quotaObservations: { claude: {}, codex: {} },
  };
  const probe = livenessProbe({
    now: () => NOW_S * 1000,
    pidAlive: (pid) => pid === 503,
    processIdentity: (pid) => pid === 503 ? "start-replacement" : null,
  });
  const projected = projectRateLimitReadModel(
    paths.map((pathName) => file({
      path: pathName,
      engine: "codex",
      root: "codex-sessions",
      fmt: "codex",
      activity: "stalled",
      proc: null,
      pid: null,
      authoritativeTurn: { state: "busy", source: "lifecycle", terminalAt: null },
    })),
    [],
    snapshot,
    NOW_S * 1000,
    () => ({ source: "cache", reason: "oauth-rate-limited", staleSince: null, retryAt }),
    (entry) => {
      const fullEntry = entry as AgentRegistryEntry;
      return identityAlive(fullEntry.host?.agent, probe)
        || identityAlive(fullEntry.host?.panePid, probe)
        || identityAlive(fullEntry.structuredHost?.process, probe);
    },
  );

  for (const projectedFile of projected.files) {
    const html = card(projectedFile, "stalled", "host is silent");
    expect(projectedFile).not.toHaveProperty("providerThrottle");
    expect(html).toContain('data-tone="stalled"');
    expect(html).toContain("host is silent");
    expect(html).not.toContain("provider is throttling");
  }
});
