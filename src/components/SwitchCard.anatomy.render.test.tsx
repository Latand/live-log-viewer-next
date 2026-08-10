import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { FileEntry } from "@/lib/types";

import { SwitchCard } from "./SwitchCard";

/**
 * Issue #964: the switch card keeps a fixed three-row anatomy — identity/status,
 * content, ops — whatever mix of operational states the conversation is in.
 * Operational chips (switch, rate limit, wakeup) live in the ops row and never
 * crowd the identity row or the title.
 */

const NOW_MS = Date.now();

function file(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/tmp/state/accounts/claude/acct-a/projects/demo/s.jsonl",
    root: "claude-projects",
    name: "s.jsonl",
    project: "demo",
    title: "Session",
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

function card(entry: FileEntry, size: "large" | "small" = "large", descendants = 0): string {
  return renderToStaticMarkup(
    <SwitchCard
      file={entry}
      title="Session"
      project="demo"
      currentProject="demo"
      descendants={descendants}
      statusLine="working on the release"
      size={size}
      tone="working"
      onOpen={() => {}}
      onArchive={() => {}}
    />,
  );
}

function rowOrder(html: string): [number, number, number] {
  const identity = html.indexOf('data-card-row="identity"');
  const content = html.indexOf('data-card-row="content"');
  const ops = html.indexOf('data-card-row="ops"');
  expect(identity).toBeGreaterThan(-1);
  expect(content).toBeGreaterThan(-1);
  expect(ops).toBeGreaterThan(-1);
  return [identity, content, ops];
}

const MIXED = file({
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
});

test("the three rows hold their order on quiet and on mixed-state cards alike", () => {
  for (const html of [card(file()), card(MIXED)]) {
    const [identity, content, ops] = rowOrder(html);
    expect(identity).toBeLessThan(content);
    expect(content).toBeLessThan(ops);
  }
});

test("switch, rate-limit, and wakeup chips render in the ops row, after the title", () => {
  const html = card(MIXED);
  const [, content, ops] = rowOrder(html);
  for (const marker of ['data-card-switch="switching"', "data-rate-limited", "data-wakeup"]) {
    const at = html.indexOf(marker);
    expect(at).toBeGreaterThan(ops);
    expect(at).toBeGreaterThan(content);
  }
});

test("a quiet card's ops row carries no operational chips, only recency facts", () => {
  const html = card(file());
  expect(html).not.toContain("data-card-switch=\"pending\"");
  expect(html).not.toContain("data-rate-limited");
  expect(html).not.toContain("data-wakeup");
  /* The settled account identity stays visible — account A/B remains explicit
     after the switch completes. */
  expect(html).toContain('data-card-switch="settled"');
  expect(html).toContain("@ acct-a");
});

/** The opening tag that carries `marker` (as an attribute), for class checks. */
function tagWithMarker(html: string, marker: string): string {
  const at = html.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
}

function classTokens(tag: string): string[] {
  return (/class="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/);
}

/*
 * #964 review, finding 1: the ops row clips with overflow-hidden, so a
 * non-shrinking chip pushed past the card edge became unreachable in mixed
 * states. Every operational chip must participate in flex shrinking (it
 * truncates under pressure instead of leaving the row) and must carry its
 * complete fact on title/aria so the truncated face stays reachable. The
 * rendered-evidence driver asserts the resulting geometry in a real browser
 * at both card widths; this test pins the shrink contract itself.
 */
test("mixed-state ops chips shrink under pressure instead of clipping, at both card widths", () => {
  for (const size of ["large", "small"] as const) {
    const html = card(MIXED, size, 2);
    for (const marker of ['data-card-switch="switching"', "data-rate-limited"]) {
      const tokens = classTokens(tagWithMarker(html, marker));
      expect(tokens).toContain("min-w-0");
      expect(tokens).toContain("shrink");
      expect(tokens).not.toContain("shrink-0");
      expect(tagWithMarker(html, marker)).toMatch(/title="[^"]+"/);
    }
    /* The wakeup chip's shrink policy lives on its wrapper span, one tag out
       from the data-wakeup button; the full time + reason ride the button. */
    const wakeAt = html.indexOf("data-wakeup");
    expect(wakeAt).toBeGreaterThan(-1);
    const wrapper = html.slice(html.lastIndexOf("<span", wakeAt), wakeAt);
    const wrapperTokens = (/class="([^"]*)"/.exec(wrapper)?.[1] ?? "").split(/\s+/);
    expect(wrapperTokens).toContain("min-w-0");
    expect(wrapperTokens).toContain("shrink");
    expect(wrapperTokens).not.toContain("shrink-0");
    expect(tagWithMarker(html, "data-wakeup")).toMatch(/title="[^"]+"/);
  }
});

test("the identity row carries exactly one primary identity treatment", () => {
  const html = card(file());
  const [identity, content] = rowOrder(html);
  const identityRow = html.slice(identity, content);
  expect(identityRow).toContain("sonnet-4.5");
  /* The engine label lives in the chip tooltip, never as a second chip. */
  expect(identityRow).not.toContain(">Claude<");
});
