/**
 * Invented conversations for the switching profile (issue #1432): three
 * transcripts of distinct shapes — short, long, tool-heavy — across two
 * projects, as Claude-format JSONL the real feed parser consumes. Shared by the
 * DOM timing test and the real-browser profile script so both measure the
 * same corpus. Nothing here names a person, an account, or a machine.
 */
import type { FileEntry } from "@/lib/types";

export const SWITCHING_PROJECTS = ["alpha", "beta"] as const;
export type SwitchingProject = (typeof SWITCHING_PROJECTS)[number];

export type SwitchingShape = "short" | "long" | "toolheavy";

export interface SwitchingConversation {
  project: SwitchingProject;
  shape: SwitchingShape;
  /** Stable id, so `#c=` links and history entries resolve it. */
  conversationId: string;
  /** Transcript path the scanner would report. Invented, absolute-looking. */
  path: string;
  title: string;
  lines: string[];
}

const STAMP = "2100-01-02T10:00:00.000Z";

function stamp(index: number): string {
  const base = Date.parse(STAMP);
  return new Date(base + index * 7_000).toISOString();
}

/** Record ids in the transcript's own shape, assembled from parts at runtime. */
function uuid(seed: string, index: number): string {
  const tail = (index + 1).toString(16).padStart(12, "0");
  return [`${seed}000000`.slice(0, 8), "0000", "4000", "8000", tail].join("-");
}

/** Where a corpus project's transcripts say they ran. The DOM test never
    reads it; the real-browser profile seeds a throwaway home and points it at
    that home's own project directories so the scanner groups them. */
export type CwdFor = (project: string) => string;
const defaultCwd: CwdFor = (project) => `/repos/${project}`;

function userLine(project: string, index: number, text: string, cwd: CwdFor = defaultCwd): string {
  return JSON.stringify({
    type: "user",
    uuid: uuid("a1", index),
    timestamp: stamp(index),
    cwd: cwd(project),
    message: { role: "user", content: text },
  });
}

function assistantText(project: string, index: number, text: string, cwd: CwdFor = defaultCwd): string {
  return JSON.stringify({
    type: "assistant",
    uuid: uuid("b2", index),
    timestamp: stamp(index),
    cwd: cwd(project),
    message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text }] },
  });
}

function toolUse(project: string, index: number, id: string, command: string, cwd: CwdFor = defaultCwd): string {
  return JSON.stringify({
    type: "assistant",
    uuid: uuid("c3", index),
    timestamp: stamp(index),
    cwd: cwd(project),
    message: {
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [{ type: "tool_use", id, name: "Bash", input: { command, description: "Run a repository check" } }],
    },
  });
}

function toolResult(project: string, index: number, id: string, output: string, cwd: CwdFor = defaultCwd): string {
  return JSON.stringify({
    type: "user",
    uuid: uuid("d4", index),
    timestamp: stamp(index),
    cwd: cwd(project),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output }] },
  });
}

const PROSE = [
  "The build finished and every focused test stayed green.",
  "I re-read the scanner contract before touching the cache, so the offsets stay contiguous.",
  "A switch must paint from what the tab already holds and refine when the fresh tail lands.",
  "Board membership converges through the shared store; nothing here writes prefs directly.",
];

/** ~12 records: a short exchange. */
export function shortLines(project: string, cwd: CwdFor = defaultCwd): string[] {
  const lines: string[] = [];
  for (let turn = 0; turn < 6; turn += 1) {
    lines.push(userLine(project, turn * 2, `Please check item ${turn + 1} of the release list.`, cwd));
    lines.push(assistantText(project, turn * 2 + 1, PROSE[turn % PROSE.length]!, cwd));
  }
  return lines;
}

/** ~1500 records of prose turns: the long conversation. */
export function longLines(project: string, records = 1500, cwd: CwdFor = defaultCwd): string[] {
  const lines: string[] = [];
  for (let index = 0; index < records; index += 1) {
    lines.push(index % 2 === 0
      ? userLine(project, index, `Continue with step ${index / 2 + 1}; keep the summary short.`, cwd)
      : assistantText(project, index, `${PROSE[index % PROSE.length]} (step ${(index - 1) / 2 + 1})`, cwd));
  }
  return lines;
}

/** ~900 records dominated by tool calls with multi-line outputs. */
export function toolHeavyLines(project: string, calls = 300, cwd: CwdFor = defaultCwd): string[] {
  const lines: string[] = [];
  let index = 0;
  lines.push(userLine(project, index++, "Audit every module and report what fails.", cwd));
  for (let call = 0; call < calls; call += 1) {
    const id = `tool-${call.toString(36).padStart(4, "0")}`;
    lines.push(toolUse(project, index++, id, `bun test src/module-${call}.test.ts`, cwd));
    const output = Array.from({ length: 6 }, (_, row) => `module-${call} case ${row}: ok (${(row * 3 + call) % 97} ms)`).join("\n");
    lines.push(toolResult(project, index++, id, `${output}\n6 pass\n0 fail`, cwd));
    if (call % 25 === 24) lines.push(assistantText(project, index++, `Batch ${(call + 1) / 25} of ${calls / 25} audited; no failures so far.`, cwd));
  }
  lines.push(assistantText(project, index++, "Every module passed. Nothing to fix.", cwd));
  return lines;
}

function conversation(project: SwitchingProject, shape: SwitchingShape, title: string, lines: string[]): SwitchingConversation {
  return {
    project,
    shape,
    conversationId: `conv-${project}-${shape}`,
    path: `/sessions/${project}/${shape}.jsonl`,
    title,
    lines,
  };
}

/** The whole corpus: three shapes in `alpha`, two short ones in `beta`. */
export function switchingCorpus(cwd: CwdFor = defaultCwd): SwitchingConversation[] {
  return [
    conversation("alpha", "short", "Short session", shortLines("alpha", cwd)),
    conversation("alpha", "long", "Long session", longLines("alpha", 1500, cwd)),
    conversation("alpha", "toolheavy", "Tool-heavy session", toolHeavyLines("alpha", 300, cwd)),
    conversation("beta", "short", "Beta first session", shortLines("beta", cwd)),
    conversation("beta", "long", "Beta second session", longLines("beta", 400, cwd)),
  ];
}

export function transcriptText(lines: readonly string[]): string {
  return lines.length ? lines.join("\n") + "\n" : "";
}

/** One more assistant record, appended to simulate the live tail moving. */
export function appendedLine(project: string, index: number, marker: string, cwd: CwdFor = defaultCwd): string {
  return assistantText(project, index, `Fresh tail record ${marker}.`, cwd);
}

/** The scanner-shaped entry for a corpus conversation. */
export function fileEntryFor(entry: SwitchingConversation, overrides: Partial<FileEntry> = {}): FileEntry {
  const text = transcriptText(entry.lines);
  return {
    path: entry.path,
    root: "claude-projects",
    name: `${entry.shape}.jsonl`,
    project: entry.project,
    cwd: `/repos/${entry.project}`,
    title: entry.title,
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 4_102_488_000 - (entry.shape === "short" ? 0 : entry.shape === "long" ? 60 : 120),
    size: new TextEncoder().encode(text).length,
    activity: "recent",
    proc: null,
    pid: null,
    model: "sonnet",
    pendingQuestion: null,
    waitingInput: null,
    conversationId: entry.conversationId,
    generation: 1,
    ...overrides,
  } as FileEntry;
}
