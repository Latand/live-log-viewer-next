import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";

/*
 * Clicking a row in «All conversations» runs `board.restore(path)`, which asks
 * `/api/files?path=<pin>` for that one record. The board is a bounded window —
 * the scheme cap publishes the newest projects only — so most catalog rows have
 * no scan entry, and the pin is the ONLY thing that puts the record in the
 * payload. When the pin answers with the unpinned corpus, the click produces no
 * card and no feedback at all (#950).
 *
 * The fixture is generated, never copied from a real session: a synthetic Codex
 * corpus with more projects than the scheme project cap, whose oldest projects
 * hold oversized transcripts.
 */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pin-ride-along-"));
const previous = {
  state: process.env.LLV_STATE_DIR,
  codex: process.env.LLV_CODEX_HOME,
  claude: process.env.LLV_CLAUDE_HOME,
  tmp: process.env.TMPDIR,
};
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_CODEX_HOME = path.join(sandbox, "codex");
process.env.LLV_CLAUDE_HOME = path.join(sandbox, "claude");
process.env.TMPDIR = fs.mkdtempSync(path.join(sandbox, "tmp-"));

const { GET } = await import("./route");
const { DEFAULT_SCHEME_PROJECT_CAP } = await import("@/lib/scanner/schemeWindow");

const day = path.join(process.env.LLV_CODEX_HOME, "sessions", "2026", "07", "16");
fs.mkdirSync(day, { recursive: true });

/** A synthetic Codex rollout of the requested size, aged the requested days. */
function rollout(name: string, cwd: string, bytes: number, ageDays: number): string {
  const pathname = path.join(day, `rollout-${name}.jsonl`);
  const head = [
    JSON.stringify({ type: "session_meta", payload: { id: name, cwd, timestamp: "2026-07-16T00:00:00.000Z" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `title ${name}` }] } }),
  ].join("\n") + "\n";
  const filler = JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(900) }] },
  }) + "\n";
  let body = head;
  while (Buffer.byteLength(body) < bytes) body += filler;
  fs.writeFileSync(pathname, body);
  const when = new Date(Date.now() - ageDays * 86_400_000);
  fs.utimesSync(pathname, when, when);
  return pathname;
}

/* One project per rollout, two more than the scheme project cap, oldest last:
   the tail projects fall outside the published window. */
const corpus: string[] = [];
for (let index = 0; index < DEFAULT_SCHEME_PROJECT_CAP + 2; index += 1) {
  const slug = String(index).padStart(2, "0");
  corpus.push(rollout(`session-${slug}`, `/repo/project-${slug}`, index % 2 === 0 ? 700_000 : 200_000, 21 + index / 100));
}
/* Larger than every dropped transcript and newer than all of them: size never
   decides membership, recency does. */
rollout("recent", "/repo/recent", 5_600_000, 0.001);

afterAll(() => {
  for (const [key, value] of [["LLV_STATE_DIR", previous.state], ["LLV_CODEX_HOME", previous.codex], ["LLV_CLAUDE_HOME", previous.claude], ["TMPDIR", previous.tmp]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

async function files(pin?: string): Promise<FileEntry[]> {
  const url = "http://127.0.0.1/api/files" + (pin ? `?path=${encodeURIComponent(pin)}` : "");
  const response = await GET(new Request(url, { headers: { host: "127.0.0.1" } }));
  expect(response.status).toBe(200);
  return ((await response.json()) as { files: FileEntry[] }).files;
}

test("an explicit ?path= pin answers with the record on the first request, whatever the window published", async () => {
  const published = new Set((await files()).map((file) => file.path));
  const elided = corpus.filter((pathname) => !published.has(pathname));
  /* The window really does shed whole projects — otherwise this test proves
     nothing about the pin. */
  expect(elided.length).toBeGreaterThan(0);

  const target = elided[0]!;
  const pinned = (await files(target)).find((file) => file.path === target);

  /* Identity, not payload detail: enough to create the card and click it. */
  expect(pinned).toBeDefined();
  expect(pinned!.project).toBeTruthy();
  expect(pinned!.project).not.toBe("other");
  expect(pinned!.size).toBe(fs.statSync(target).size);
  expect(pinned!.activity).toBeTruthy();
  expect(pinned!.engine).toBe("codex");
});

test("the oversized elided transcript rides along by identity, not by being small enough to read", async () => {
  const published = new Set((await files()).map((file) => file.path));
  const oversized = corpus.find((pathname) => !published.has(pathname) && fs.statSync(pathname).size > 512 * 1024);
  expect(oversized).toBeDefined();

  const pinned = (await files(oversized!)).find((file) => file.path === oversized);
  expect(pinned).toBeDefined();
  expect(pinned!.title).toBeTruthy();
});
