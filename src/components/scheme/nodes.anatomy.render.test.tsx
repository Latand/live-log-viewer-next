import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { FileEntry } from "@/lib/types";

import type { MiniStack, SchemeNode } from "./layout";
import { FarLabel, LiteNodeShell, MiniStackShell } from "./nodes";

/**
 * Issue #964: the map (lite) card, the collapsed stack rows, and the far-zoom
 * label follow the fixed card anatomy — identity/status leads, content holds
 * its own row/slot, operational facts trail — across quiet and mixed states.
 */

const NOW_MS = Date.now();

function file(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/tmp/state/accounts/claude/acct-a/projects/demo/s.jsonl",
    root: "claude-projects",
    name: "s.jsonl",
    project: "demo",
    title: "Rework the delivery fence",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: NOW_MS / 1000 - 30,
    size: 1,
    activity: "recent",
    proc: null,
    pid: null,
    model: "sonnet-4.5",
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  } as unknown as FileEntry;
}

const MIXED_OVERRIDES: Partial<FileEntry> = {
  rateLimit: { source: "account", accountId: "acct-a", window: "session", resetAt: NOW_MS / 1000 + 3600 } as FileEntry["rateLimit"],
  pendingWakeup: { fireAt: NOW_MS + 20 * 60_000, reason: "poll" } as FileEntry["pendingWakeup"],
  migration: {
    intentId: "intent-1",
    trigger: "manual",
    phase: "preparing",
    targetAccountId: "acct-b",
    targetLabel: "account B",
    sourceLabel: "account A",
    failure: null,
  } as FileEntry["migration"],
};

function node(entry: FileEntry): SchemeNode {
  return { file: entry, tasks: [], under: [], isRoot: true, x: 0, y: 0, w: 340, h: 220 };
}

const lite = (entry: FileEntry) =>
  renderToStaticMarkup(<LiteNodeShell node={node(entry)} ringed={false} dimmed={false} flow={null} />);

test("lite card: the three rows hold their order on quiet and mixed cards", () => {
  for (const html of [lite(file()), lite(file(MIXED_OVERRIDES))]) {
    const identity = html.indexOf('data-card-row="identity"');
    const content = html.indexOf('data-card-row="content"');
    const ops = html.indexOf('data-card-row="ops"');
    expect(identity).toBeGreaterThan(-1);
    expect(identity).toBeLessThan(content);
    expect(content).toBeLessThan(ops);
  }
});

test("lite card: operational chips live in the ops row, after the title", () => {
  const html = lite(file(MIXED_OVERRIDES));
  const ops = html.indexOf('data-card-row="ops"');
  for (const marker of ['data-card-switch="switching"', "data-rate-limited", "data-wakeup"]) {
    expect(html.indexOf(marker)).toBeGreaterThan(ops);
  }
});

test("lite card: one primary identity treatment, engine folded into its tooltip", () => {
  const html = lite(file());
  const identityRow = html.slice(html.indexOf('data-card-row="identity"'), html.indexOf('data-card-row="content"'));
  expect(identityRow).toContain("sonnet-4.5");
  expect(identityRow).not.toContain(">Claude<");
});

test("collapsed stack row: status leads the identity line; a live switch shows on the ops line", () => {
  const stack: MiniStack = {
    key: "mini::p",
    parent: "/tmp/p",
    items: [{ file: file({ ...MIXED_OVERRIDES, waitingInput: { since: NOW_MS / 1000 - 40 } as FileEntry["waitingInput"] }), branches: 2 }],
    x: 0,
    y: 0,
    w: 260,
    h: 120,
  };
  const html = renderToStaticMarkup(<MiniStackShell stack={stack} dimmed={false} onSelect={() => {}} />);
  const identity = html.indexOf('data-card-row="identity"');
  const ops = html.indexOf('data-card-row="ops"');
  const status = html.indexOf("data-card-status");
  /* The row's visible title (the outer button repeats it as a tooltip attr). */
  const title = html.indexOf("Rework the delivery fence", identity);
  expect(identity).toBeLessThan(ops);
  expect(status).toBeGreaterThan(identity);
  expect(status).toBeLessThan(title);
  expect(html.indexOf('data-card-switch="switching"')).toBeGreaterThan(ops);
  /* The settled account never repeats on every quiet branch. */
  const quiet = renderToStaticMarkup(
    <MiniStackShell stack={{ ...stack, items: [{ file: file(), branches: 0 }] }} dimmed={false} onSelect={() => {}} />,
  );
  expect(quiet).not.toContain("data-card-switch");
});

test("far label: identity and status precede the title; operational chips trail it", () => {
  const html = renderToStaticMarkup(<FarLabel file={file(MIXED_OVERRIDES)} />);
  const title = html.indexOf("Rework the delivery fence");
  expect(html.indexOf("data-card-status")).toBeLessThan(title);
  for (const marker of ['data-card-switch="switching"', "data-rate-limited", "data-wakeup"]) {
    expect(html.indexOf(marker)).toBeGreaterThan(title);
  }
});
