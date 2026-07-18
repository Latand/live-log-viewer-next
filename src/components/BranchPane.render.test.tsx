import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { FileEntry } from "@/lib/types";

import { BranchPane } from "./BranchPane";

/*
 * Integration-level regression for the unified strip's actual mount point
 * (issue #241 finding 7). The prior suites rendered the *View* components in
 * isolation; this exercises the real `BranchPane` wiring so the strip is proven
 * to appear on every surface a conversation renders on — including the
 * `noComposer` review round, which still needs Stop — and the composer is
 * present exactly when it should be.
 */

function file(over: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/root.jsonl", root: "claude-projects", name: "root.jsonl", project: "viewer", title: "root",
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1, size: 1, activity: "live",
    proc: "running", pid: 5, model: "sonnet", effort: "high", fast: false, pendingQuestion: null, waitingInput: null,
    ...over,
  } as FileEntry;
}

const strip = (html: string) => html.includes("data-agent-control-strip");
const surface = (html: string) => html.match(/data-strip-surface="([a-z-]+)"/)?.[1] ?? null;
const hasComposer = (html: string) => html.includes("<textarea");

test("a running root mounts the strip (live-root) above a live composer", () => {
  const html = renderToStaticMarkup(<BranchPane file={file()} tasks={[]} isRoot />);
  expect(strip(html)).toBe(true);
  expect(surface(html)).toBe("live-root");
  expect(hasComposer(html)).toBe(true);
});

test("a noComposer review round still mounts the strip but drops the composer", () => {
  const html = renderToStaticMarkup(<BranchPane file={file()} tasks={[]} isRoot noComposer />);
  expect(strip(html)).toBe(true);
  expect(surface(html)).toBe("live-root");
  expect(hasComposer(html)).toBe(false);
});

test("a running subagent surfaces as live-subagent (enabled root-interrupt Stop lives here)", () => {
  const html = renderToStaticMarkup(<BranchPane file={file({ kind: "subagent", parent: "/root.jsonl" })} tasks={[]} isRoot={false} />);
  expect(surface(html)).toBe("live-subagent");
  // the Stop is enabled with the root-agent note (never a dead button)
  expect(html).toContain("interrupts the root agent");
});

test("a finished conversation surfaces as resume with an on-resume runtime slot", () => {
  const html = renderToStaticMarkup(<BranchPane file={file({ engine: "codex", root: "codex-sessions", proc: null })} tasks={[]} isRoot />);
  expect(surface(html)).toBe("resume");
  expect(strip(html)).toBe(true);
});

test("a gated scanner-shaped subagent (inert) mounts no composer — no Send/quick-ack/mic/image path", () => {
  // proc:null/pid:null child with no live runtime root resolves to `inert`
  // (Send hidden). The composer must not render at all, so nothing can POST to
  // /api/tmux against a subagent whose host is unconfirmed (issue #241 finding 2).
  const html = renderToStaticMarkup(
    <BranchPane file={file({ kind: "subagent", parent: "/root.jsonl", proc: null, pid: null })} tasks={[]} isRoot={false} />,
  );
  // Every strip-own control is hidden on an inert subagent, so the strip itself
  // stands down and the composer never mounts.
  expect(strip(html)).toBe(false);
  expect(hasComposer(html)).toBe(false);
});

test("the full-window overlay (expanded) mounts the strip the same way", () => {
  const html = renderToStaticMarkup(<BranchPane file={file()} tasks={[]} isRoot expanded />);
  expect(strip(html)).toBe(true);
  expect(surface(html)).toBe("live-root");
});
