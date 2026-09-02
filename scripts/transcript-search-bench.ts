#!/usr/bin/env bun
/**
 * End-to-end profile of the global message search (#1429) on the synthetic
 * corpus `transcript-search-fixture.ts` writes: the same three queries on every
 * surface the operator reaches it through.
 *
 *   LLV_STATE_DIR=<scratch> bun scripts/transcript-search-bench.ts <fixtureDir> [--repeat 5] [--json <file>] [--skip-mcp] [--skip-ui]
 *
 * Refuses to run without an explicit LLV_STATE_DIR so the index build can never
 * touch the operator's live `transcript-search.sqlite`, and the MCP host it
 * spawns keeps its receipts in that same scratch directory.
 *
 * Surfaces, from the inside out:
 *   - library — `searchTranscripts` in this process: the SQLite work alone;
 *   - route   — the exported route handler called in-process: library plus
 *               title lookup and JSON serialisation;
 *   - http    — the same handler served by a loopback Bun.serve and fetched:
 *               what the browser and the MCP host actually wait for;
 *   - mcp     — the packaged stdio server (`bin/mcp-server.mjs`, the release
 *               bundle under Bun, as on the host) pointed at that loopback
 *               Viewer, driven through the MCP SDK client: receipts, control
 *               HTTP, redaction and result serialisation on top of http;
 *   - ui      — the real palette (`GlobalSearch`) mounted in happy-dom with
 *               `fetch` routed to the loopback Viewer: from the last keystroke
 *               to the first rendered result row, debounce included. `fast`
 *               types the query with 120 ms between keys so only the final
 *               query is requested; `slow` leaves 300 ms after every key so
 *               each pause fires its own request, which is what stacks queries
 *               on the Viewer's event loop.
 * Each cell is the median of `--repeat` runs. Numbers only; nothing from the
 * corpus is printed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GET as searchRoute } from "@/app/api/search/transcripts/route";
import { replaceConversationCatalog } from "@/lib/scanner/conversationCatalog";
import { indexTranscriptSources, searchTranscripts, type TranscriptIndexSource, type TranscriptSpeaker } from "@/lib/search/transcriptSearch";
import { TRANSCRIPT_SEARCH_DEBOUNCE_MS } from "@/components/search/useTranscriptSearch";

import type { TranscriptFixtureManifest } from "./transcript-search-fixture";

interface Cell {
  surface: "library" | "route" | "http" | "mcp" | "ui-fast" | "ui-slow";
  query: string;
  speaker: string;
  runs: number[];
  median: number;
  /** Requests the Viewer answered for the cell's runs (ui surfaces only). */
  requests?: number;
  total?: number;
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const args = process.argv.slice(2);
const fixtureDir = args.find((arg) => !arg.startsWith("--") && !args.includes(`--${arg}`) && !/^\d+$/.test(arg) && !arg.endsWith(".json"));
const stateDir = process.env.LLV_STATE_DIR;
const defaultStateDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agent-log-viewer", "state");
if (!fixtureDir || !stateDir || path.resolve(stateDir) === defaultStateDir) {
  console.error("usage: LLV_STATE_DIR=<scratch> bun scripts/transcript-search-bench.ts <fixtureDir> [--repeat 5] [--json <file>] [--skip-mcp] [--skip-ui]");
  process.exit(2);
}
const repeat = Math.max(1, Number(flag(args, "repeat") ?? 5) || 5);
const jsonOut = flag(args, "json");
const root = path.resolve(fixtureDir);
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")) as TranscriptFixtureManifest;
const sources: TranscriptIndexSource[] = manifest.files.map((file) => {
  const absolute = path.join(root, file.path);
  const stat = fs.statSync(absolute);
  return { path: absolute, project: file.project, engine: file.engine, size: stat.size, mtimeMs: stat.mtimeMs };
});

const indexStartedAt = performance.now();
const indexed = await indexTranscriptSources(sources, { complete: true });
const indexMs = Math.round(performance.now() - indexStartedAt);
if (indexed.failures.length) throw new Error(`${indexed.failures.length} fixture transcript(s) failed to index`);
/* Titles come off the in-memory catalog in production; publish one of the
   same size so the route's per-page title lookup is part of the measurement. */
replaceConversationCatalog(manifest.files.map((file, index) => ({
  path: path.join(root, file.path),
  root: file.engine === "claude" ? "claude-projects" : "codex-sessions",
  name: path.basename(file.path),
  project: file.project,
  title: `Fixture conversation ${index + 1}`,
  firstPrompt: `Fixture conversation ${index + 1}`,
  engine: file.engine,
  kind: "session",
  fmt: file.engine,
  mtime: file.mtime,
  size: 0,
})));

const queries = [manifest.probes.rare, manifest.probes.commonPair, manifest.probes.veryCommon];
const speakers: Array<TranscriptSpeaker | undefined> = ["user", undefined];
const cells: Cell[] = [];
const stats = searchTranscripts({ query: manifest.probes.rare }).stats;
console.log(`corpus: ${stats.conversationsIndexed} conversations / ${stats.messagesIndexed} messages; index build ${indexMs} ms (${indexed.filesRead} read, ${indexed.filesSkipped} unchanged)`);

function url(origin: string, query: string, speaker: TranscriptSpeaker | undefined): string {
  const params = new URLSearchParams({ q: query, limit: "20" });
  if (speaker) params.set("speaker", speaker);
  return `${origin}/api/search/transcripts?${params}`;
}

let served = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => {
    served += 1;
    return searchRoute(request);
  },
});
const origin = server.url.origin;

for (const query of queries) {
  for (const speaker of speakers) {
    const label = speaker ?? "all";
    const library: number[] = [];
    let total = 0;
    for (let run = 0; run < repeat; run += 1) {
      const startedAt = performance.now();
      total = searchTranscripts({ query, speaker, limit: 20 }).total;
      library.push(performance.now() - startedAt);
    }
    cells.push({ surface: "library", query, speaker: label, runs: library, median: median(library), total });
    const route: number[] = [];
    for (let run = 0; run < repeat; run += 1) {
      const startedAt = performance.now();
      await (await searchRoute(new Request(url("http://127.0.0.1", query, speaker)))).json();
      route.push(performance.now() - startedAt);
    }
    cells.push({ surface: "route", query, speaker: label, runs: route, median: median(route), total });
    const http: number[] = [];
    for (let run = 0; run < repeat; run += 1) {
      const startedAt = performance.now();
      await (await fetch(url(origin, query, speaker))).json();
      http.push(performance.now() - startedAt);
    }
    cells.push({ surface: "http", query, speaker: label, runs: http, median: median(http), total });
  }
}

if (!args.includes("--skip-mcp")) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  environment.LLV_STATE_DIR = stateDir;
  environment.LLV_VIEWER_CONTROL_URL = origin;
  delete environment.LLV_VIEWER_DEPLOY_TARGET;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "bin", "mcp-server.mjs")],
    cwd: process.cwd(),
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({ name: "transcript-search-bench", version: "1.0.0" });
  await client.connect(transport);
  try {
    /* The tool has no speaker argument: it always searches both sides. */
    for (const query of queries) {
      const runs: number[] = [];
      let total = 0;
      for (let run = 0; run < repeat; run += 1) {
        const startedAt = performance.now();
        const result = await client.callTool({
          name: "search_transcripts",
          arguments: { clientRequestId: `bench-${Date.now()}-${run}-${Math.random().toString(36).slice(2)}`, query, limit: 20 },
        });
        runs.push(performance.now() - startedAt);
        const structured = result.structuredContent as { ok?: boolean; total?: number; error?: string } | undefined;
        if (!structured?.ok) throw new Error(`search_transcripts failed: ${structured?.error ?? "no structured content"}`);
        total = structured.total ?? 0;
      }
      cells.push({ surface: "mcp", query, speaker: "all", runs, median: median(runs), total });
    }
  } finally {
    await client.close().catch(() => {});
  }
}

if (!args.includes("--skip-ui")) {
  const { Window } = await import("happy-dom");
  const dom = new Window({ url: "http://localhost/" });
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    location: dom.location,
    history: dom.history,
    localStorage: dom.localStorage,
    Node: dom.Node,
    HTMLElement: dom.HTMLElement,
    HTMLInputElement: dom.HTMLInputElement,
    Element: dom.Element,
    Event: dom.Event,
    KeyboardEvent: dom.KeyboardEvent,
    MouseEvent: dom.MouseEvent,
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    realFetch(new URL(String(input), origin), init)) as typeof fetch;
  const { createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { GlobalSearch } = await import("@/components/search/GlobalSearch");
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const valueSetter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
  for (const query of queries) {
    for (const speaker of speakers) {
      for (const typing of ["fast", "slow"] as const) {
        const gap = typing === "fast" ? 120 : 300;
        const runs: number[] = [];
        let requests = 0;
        for (let run = 0; run < repeat; run += 1) {
          const mountNode = dom.document.createElement("div");
          dom.document.body.append(mountNode);
          const host = mountNode as unknown as HTMLElement;
          const mounted = createRoot(host);
          mounted.render(createElement(GlobalSearch, { mobile: false, onClose: () => {}, onOpen: () => {} }));
          await sleep(20);
          if (!speaker) {
            host.querySelector<HTMLElement>('[data-search-scope="everything"]')!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
            await sleep(20);
          }
          const input = host.querySelector<HTMLInputElement>("[data-search-input]")!;
          input.focus();
          const servedBefore = served;
          let lastKeyAt = 0;
          for (let length = 1; length <= query.length; length += 1) {
            valueSetter.call(input, query.slice(0, length));
            lastKeyAt = performance.now();
            input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
            input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: query[length - 1]!, bubbles: true }) as unknown as Event);
            if (length < query.length) await sleep(gap);
          }
          const deadline = lastKeyAt + 60_000;
          let resultAt: number | null = null;
          while (performance.now() < deadline) {
            /* The first row that answers the FINAL query: a held (stale) list
               from an earlier pause does not count. */
            const list = host.querySelector("[data-search-stale]");
            if (!list && host.querySelector("[data-search-result]") && !host.querySelector("[data-search-updating]")) { resultAt = performance.now(); break; }
            await sleep(2);
          }
          if (resultAt === null) throw new Error(`palette showed no result for ${query} (${speaker ?? "all"}, ${typing}) within 60 s`);
          runs.push(resultAt - lastKeyAt);
          /* Let every request the pauses fired settle before the next run. */
          await sleep(TRANSCRIPT_SEARCH_DEBOUNCE_MS + 50);
          requests += served - servedBefore;
          mounted.unmount();
          host.remove();
        }
        cells.push({ surface: typing === "fast" ? "ui-fast" : "ui-slow", query, speaker: speaker ?? "all", runs, median: median(runs), requests: Math.round(requests / repeat) });
      }
    }
  }
}

server.stop(true);

const label = (query: string) => query === manifest.probes.rare ? "rare word" : query === manifest.probes.commonPair ? "two common words" : "one very common word";
console.log("\n| surface | query | speaker | matches | median ms | runs (ms) |");
console.log("| --- | --- | --- | --- | --- | --- |");
for (const cell of cells) {
  const extra = cell.requests !== undefined ? ` (${cell.requests} req/run)` : "";
  console.log(`| ${cell.surface} | ${label(cell.query)} | ${cell.speaker} | ${cell.total ?? ""} | ${Math.round(cell.median)}${extra} | ${cell.runs.map((run) => Math.round(run)).join(" / ")} |`);
}
if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify({
    corpus: { conversations: stats.conversationsIndexed, messages: stats.messagesIndexed, indexMs, seed: manifest.seed },
    debounceMs: TRANSCRIPT_SEARCH_DEBOUNCE_MS,
    cells: cells.map((cell) => ({ ...cell, query: label(cell.query), runs: cell.runs.map((run) => Math.round(run * 10) / 10), median: Math.round(cell.median * 10) / 10 })),
  }, null, 2) + "\n");
  console.log(`\nwrote ${jsonOut}`);
}
process.exit(0);
