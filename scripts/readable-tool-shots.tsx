/**
 * Privacy-safe screenshots for the readable tool block (issue #475).
 *
 *   bun scripts/readable-tool-shots.tsx
 *
 * Server-renders the real feed cards (collapsed aggregate + expanded readable
 * blocks) against the production Tailwind stylesheet emitted by `bun run build`,
 * then captures desktop and 390px stills with local headless Chrome. Every
 * value is synthetic — no real path, secret, or host is rendered.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";

import { CmdGroupCard } from "@/components/feed/cards/CmdGroupCard";
import { ToolCard } from "@/components/feed/cards/ToolCard";
import { execSuccess, toolEvent } from "@/components/feed/__fixtures__/readableTools";
import type { CmdGroupItem, ToolEvent } from "@/components/feed/parse";

const OUT_DIR = path.join(import.meta.dir, "..", "docs", "media", "readable-tools");
const CHROME = process.env.CHROME_BIN || "google-chrome-stable";

function group(calls: ToolEvent[], hasErr: boolean, active = false): CmdGroupItem {
  const byTool: Record<string, number> = {};
  for (const c of calls) byTool[c.tool] = (byTool[c.tool] ?? 0) + 1;
  return {
    kind: "cmd-group",
    ids: calls.map((c) => c.id),
    calls,
    t0: calls[0].ts,
    t1: "2100-01-02T12:00:20Z",
    byTool,
    okCount: calls.filter((c) => c.status === "ok").length,
    errCount: calls.filter((c) => c.status === "err").length,
    hasErr,
    active,
  };
}

// The exec run the group folds: a clean status, an interactive dev-server with a
// wait tail and stdin poll, and a failing test with split stdout/stderr.
const ts = "2100-01-02T12:00:00Z";
const gitStatus = toolEvent({ ...execSuccess, ts, id: "g1", cwd: "/workspace/app", endTs: "2100-01-02T12:00:00.240Z" });
const npmDev = toolEvent({ id: "e2", tool: "exec_command", ts, summary: "npm run dev", command: "npm run dev", cwd: "/workspace/app", outputPreview: "starting dev server on :3000" });
const wait = toolEvent({ id: "w2", tool: "wait", ts, summary: "wait · 8479", statusLabel: "waiting 10s", durationMs: 10_000, outputPreview: "compiled successfully" });
const poll = toolEvent({ id: "s2", tool: "write_stdin", ts, summary: "stdin → 8479 · poll", statusLabel: "waiting 5s", durationMs: 5_000, outputPreview: "" });
const bunTest = toolEvent({
  id: "e3", tool: "exec_command", ts, summary: "bun test", command: "bun test ./src/components/feed", cwd: "/workspace/app",
  status: "err", statusLabel: "exit 1", exitCode: 1, durationMs: 1830, endTs: "2100-01-02T12:00:01.830Z", open: true,
  outputPreview: "src/feed.test.ts:\n 41 pass\n 1 fail",
  stderr: "error: expected true to be false\n  at feed.test.ts:88", stderrTruncated: false,
});

const okCalls = [gitStatus, npmDev, wait, poll, toolEvent({ id: "r1", tool: "Read", family: "read", icon: "file", ts, summary: "Read config.ts" })];
const errCalls = [gitStatus, npmDev, wait, poll, bunTest];

function page(): string {
  const collapsed = renderToStaticMarkup(<CmdGroupCard item={group(okCalls, false)} />);
  // The live trailing aggregate renders expanded with every command and output
  // shown inline — no per-call disclosure (issue #475).
  const expanded = renderToStaticMarkup(<CmdGroupCard item={group(errCalls, true, true)} />);
  const single = renderToStaticMarkup(<ToolCard event={{ ...execSuccess, ts, endTs: "2100-01-02T12:00:00.240Z", open: true }} />);
  const css = fs.readdirSync(path.join(import.meta.dir, "..", ".next", "static", "css"))
    .filter((f) => f.endsWith(".css"))
    .map((f) => fs.readFileSync(path.join(import.meta.dir, "..", ".next", "static", "css", f), "utf8"))
    .join("\n");
  const section = (title: string, body: string) =>
    `<div class="mb-4"><div class="mb-1 text-caption font-semibold uppercase tracking-wide text-muted">${title}</div><div class="text-secondary">${body}</div></div>`;
  return `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><style>${css}
    html,body{margin:0;background:var(--color-canvas)}
    #shot{padding:20px}
  </style></head><body><div id="shot">
    ${section("Compact aggregate (collapsed)", collapsed)}
    ${section("Readable blocks (expanded)", expanded)}
    ${section("Standalone tool block", single)}
  </div></body></html>`;
}

function capture(html: string, width: number, name: string): void {
  const htmlPath = path.join(OUT_DIR, `${name}.html`);
  fs.writeFileSync(htmlPath, html);
  const out = path.join(OUT_DIR, `${name}.png`);
  const res = spawnSync(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--force-device-scale-factor=1",
    `--window-size=${width},1400`, `--screenshot=${out}`, `file://${htmlPath}`,
  ], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`chrome failed for ${name}: ${res.stderr}`);
  fs.rmSync(htmlPath);
  const bytes = fs.statSync(out).size;
  process.stdout.write(`${name}.png ${bytes} bytes @ ${width}px\n`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const html = page();
capture(html, 1280, "readable-tools-desktop");
capture(html, 390, "readable-tools-390");
