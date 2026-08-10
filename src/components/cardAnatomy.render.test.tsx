import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { FileEntry } from "@/lib/types";

import { AccountSwitchChip, accountSwitchFacts } from "./cardAnatomy";

/**
 * Issue #964: the compact account/switch chip keeps account A → account B
 * explicit through every phase, and stays silent when everything is default —
 * a quiet card's ops row never fills with placeholder chips.
 */

const MANAGED_PATH = "/tmp/state/accounts/claude/acct-a/projects/demo/s.jsonl";

function file(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: MANAGED_PATH,
    root: "claude-projects",
    name: "s.jsonl",
    project: "demo",
    title: "Session",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1_000,
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

function migrating(phase: string, extra: Partial<NonNullable<FileEntry["migration"]>> = {}): FileEntry {
  return file({
    migration: {
      intentId: "intent-1",
      trigger: "manual",
      phase,
      targetAccountId: "acct-b",
      targetLabel: "account B",
      sourceLabel: "account A",
      failure: null,
      ...extra,
    } as FileEntry["migration"],
  });
}

const chip = (entry: FileEntry) => renderToStaticMarkup(<AccountSwitchChip file={entry} />);

test("preflight, switching, and recovery phases each name the switch", () => {
  const pending = chip(migrating("waiting-turn"));
  expect(pending).toContain('data-card-switch="pending"');
  expect(pending).toContain("account B");

  const switching = chip(migrating("preparing"));
  expect(switching).toContain('data-card-switch="switching"');
  expect(switching).toContain("account B");

  const failed = chip(migrating("failed-recoverable", { failure: "quota" }));
  expect(failed).toContain('data-card-switch="failed"');
});

test("the chip title carries the full account A → account B route", () => {
  expect(chip(migrating("preparing"))).toContain("«account A» → «account B»");
});

test("an unnamed target switches without inventing a label", () => {
  const unnamed = chip(migrating("preparing", { targetAccountId: "", targetLabel: "" }));
  expect(unnamed).toContain('data-card-switch="switching"');
  expect(unnamed).not.toContain("«»");
});

test("settled: the card names the account it runs under; the default account stays silent", () => {
  const settled = chip(file());
  expect(settled).toContain('data-card-switch="settled"');
  expect(settled).toContain("@ acct-a");

  expect(chip(file({ path: "/home/user/.claude/projects/demo/s.jsonl" }))).toBe("");
});

test("a leftover annotation whose target already owns the card reads as settled", () => {
  /* Level rule (activeCardMigration): the switch committed and the transcript
     already rotated under acct-a — the stale hold must not resurrect. */
  const leftover = chip(migrating("waiting-turn", { targetAccountId: "acct-a", targetLabel: "account A" }));
  expect(leftover).toContain('data-card-switch="settled"');
  expect(leftover).not.toContain('data-card-switch="pending"');
});

test("shell tasks carry no account facts at all", () => {
  expect(accountSwitchFacts(file({ engine: "shell" }))).toBeNull();
  expect(chip(file({ engine: "shell" }))).toBe("");
});

test("showSettled=false keeps live switches and drops the settled identity", () => {
  expect(renderToStaticMarkup(<AccountSwitchChip file={file()} showSettled={false} />)).toBe("");
  expect(renderToStaticMarkup(<AccountSwitchChip file={migrating("preparing")} showSettled={false} />)).toContain(
    'data-card-switch="switching"',
  );
});
