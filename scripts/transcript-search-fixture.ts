#!/usr/bin/env bun
/**
 * Synthetic transcript corpus for profiling the global message search (#1429).
 *
 * Writes Claude and Codex transcripts whose shape follows the production index
 * this search runs over (7.2k conversations, 250k indexed messages, ~780-byte
 * mean body with a long tail, one operator message per four agent messages,
 * resumed Codex rollouts replaying their whole history) without carrying a
 * byte of real content: every body is built from an invented vocabulary.
 * Deterministic under `--seed`, so two runs profile the same corpus.
 *
 *   bun scripts/transcript-search-fixture.ts <outDir> [--conversations 7200] [--messages 250000] [--seed 1429]
 *
 * Three probe words have a pinned frequency so the three issue-#1429 queries
 * are reproducible on any size:
 *   - `heliotrope` — rare: exactly three messages in the corpus;
 *   - `harbor granite` — two common words: ~20% and ~13% of messages, ~9% both;
 *   - `ledger` — one very common word: ~45% of messages.
 * `manifest.json` in <outDir> lists every file with its project and engine.
 * Only ever point it at a scratch directory.
 */
import fs from "node:fs";
import path from "node:path";

export interface TranscriptFixtureFile {
  /** Relative to the fixture root. */
  path: string;
  project: string;
  engine: "claude" | "codex";
  /** Seconds; resumed rollouts are newer than the rollout they replay. */
  mtime: number;
}

export interface TranscriptFixtureManifest {
  seed: number;
  conversations: number;
  /** Indexable messages the generator wrote, replays included. */
  messages: number;
  probes: { rare: string; commonPair: string; veryCommon: string };
  files: TranscriptFixtureFile[];
}

export const TRANSCRIPT_FIXTURE_PROBES = {
  rare: "heliotrope",
  commonPair: "harbor granite",
  veryCommon: "ledger",
} as const;

const VOCABULARY = (
  "cadence meadow signal orbit lantern quorum ripple saffron timber velvet willow zenith anchor basalt copper "
  + "drift ember fathom glacier hollow ingot juniper kestrel lumen marble nectar oriole pebble quartz reed summit "
  + "tundra umber vapor wander yarrow beacon cinder delta fjord gable heron isle keel loom mesa nimbus onyx "
  + "prism ridge sable talon vale wren aspen bramble cobalt dune estuary flint grove harrow inlet jetty knoll "
  + "larch moss nook orchard pine quay rill shale thicket upland verge wharf yew ashlar bower crag dell "
  + "eddy fen gorge heath islet karst lea moor ness oxbow pool rune spur tarn undertow vane weir"
).split(" ");
const CODE_WORDS = "return const await async export import function while break continue yield throw catch".split(" ");
const PROJECTS = Array.from({ length: 40 }, (_value, index) => `fixture-project-${String(index + 1).padStart(2, "0")}`);

function flag(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? Number(args[index + 1]) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

class Random {
  private state: number;
  constructor(seed: number) { this.state = seed >>> 0; }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number { return min + Math.floor(this.next() * (max - min + 1)); }
  pick<T>(items: readonly T[]): T { return items[Math.floor(this.next() * items.length)]!; }
  chance(probability: number): boolean { return this.next() < probability; }
  hex(length: number): string { let out = ""; while (out.length < length) out += Math.floor(this.next() * 16).toString(16); return out; }
}

/** Body lengths follow the production tail: most bodies are a sentence or
    two, a few percent are tool-output sized, a handful are enormous. */
function bodyWordCount(random: Random): number {
  const roll = random.next();
  if (roll < 0.65) return random.int(4, 30);
  if (roll < 0.92) return random.int(30, 220);
  if (roll < 0.985) return random.int(220, 900);
  return random.int(900, 9_000);
}

function sentence(random: Random, words: string[], count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push(random.chance(0.08) ? random.pick(CODE_WORDS) : random.pick(words));
  out[0] = out[0]![0]!.toUpperCase() + out[0]!.slice(1);
  return `${out.join(" ")}.`;
}

interface Planned { rare: boolean; harbor: boolean; granite: boolean; ledger: boolean }

function body(random: Random, planned: Planned): string {
  const total = bodyWordCount(random);
  const chunks: string[] = [];
  let remaining = total;
  while (remaining > 0) {
    const count = Math.min(remaining, random.int(4, 18));
    chunks.push(sentence(random, VOCABULARY, count));
    remaining -= count;
    if (random.chance(0.15)) chunks.push("\n");
  }
  const text = chunks.join(" ").replace(/ \n /g, "\n");
  const inserts: string[] = [];
  if (planned.ledger) inserts.push(TRANSCRIPT_FIXTURE_PROBES.veryCommon);
  if (planned.harbor) inserts.push("harbor");
  if (planned.granite) inserts.push("granite");
  if (planned.rare) inserts.push(TRANSCRIPT_FIXTURE_PROBES.rare);
  if (!inserts.length) return text;
  const words = text.split(" ");
  for (const word of inserts) words.splice(random.int(0, words.length), 0, word);
  return words.join(" ");
}

interface Message { speaker: "user" | "assistant"; body: string; at: number }

function isoAt(seconds: number, millis = 0): string {
  return new Date(seconds * 1_000 + millis).toISOString();
}

function claudeLines(messages: Message[]): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    lines.push(JSON.stringify(message.speaker === "user"
      ? { type: "user", timestamp: isoAt(message.at), message: { role: "user", content: message.body } }
      : { type: "assistant", timestamp: isoAt(message.at), message: { role: "assistant", content: [{ type: "text", text: message.body }] } }));
  }
  return lines;
}

/** Codex writes each turn twice (event and response item, milliseconds apart)
    and the index reader collapses that pair, so the fixture writes both. */
function codexLines(messages: Message[], replayed: Message[]): string[] {
  const lines: string[] = [JSON.stringify({ type: "session_meta", payload: { cwd: "/workspace/fixture" } })];
  for (const message of replayed) {
    lines.push(JSON.stringify({
      type: "response_item",
      timestamp: isoAt(message.at),
      payload: message.speaker === "user"
        ? { type: "message", role: "user", content: [{ type: "input_text", text: message.body }] }
        : { type: "message", role: "assistant", content: [{ type: "output_text", text: message.body }] },
    }));
  }
  for (const message of messages) {
    lines.push(JSON.stringify({
      type: "event_msg",
      timestamp: isoAt(message.at),
      payload: message.speaker === "user" ? { type: "user_message", message: message.body } : { type: "agent_message", message: message.body },
    }));
    lines.push(JSON.stringify({
      type: "response_item",
      timestamp: isoAt(message.at, 1),
      payload: message.speaker === "user"
        ? { type: "message", role: "user", content: [{ type: "input_text", text: message.body }] }
        : { type: "message", role: "assistant", content: [{ type: "output_text", text: message.body }] },
    }));
    if (message.speaker === "assistant") {
      lines.push(JSON.stringify({ type: "event_msg", timestamp: isoAt(message.at, 2), payload: { type: "token_count", info: { total_token_usage: { input_tokens: message.body.length } } } }));
    }
  }
  return lines;
}

export function writeTranscriptFixture(outDir: string, options: { conversations: number; messages: number; seed: number }): TranscriptFixtureManifest {
  const random = new Random(options.seed);
  const files: TranscriptFixtureFile[] = [];
  fs.mkdirSync(outDir, { recursive: true });
  const baseAt = Date.UTC(2026, 0, 1) / 1_000;
  /* Slots are counted over freshly produced messages, which replays never
     touch, so the last one lands before the budget fills with replayed rows. */
  const rareSlots = new Set([
    Math.floor(options.messages * 0.004),
    Math.floor(options.messages * 0.4),
    Math.floor(options.messages * 0.72),
  ]);
  let written = 0;
  let produced = 0;
  let conversation = 0;
  const perConversation = Math.max(1, Math.round(options.messages / options.conversations));
  while (written < options.messages && conversation < options.conversations) {
    const engine: "claude" | "codex" = random.chance(0.5) ? "claude" : "codex";
    const project = random.pick(PROJECTS);
    const count = Math.max(1, Math.round(perConversation * (0.4 + random.next() * 1.2)));
    const startAt = baseAt + Math.floor(random.next() * 240 * 86_400);
    const messages: Message[] = [];
    for (let index = 0; index < count && written < options.messages; index += 1) {
      const harbor = random.chance(0.2);
      const planned: Planned = {
        rare: rareSlots.has(produced),
        harbor,
        granite: harbor ? random.chance(0.45) : random.chance(0.05),
        ledger: random.chance(0.45),
      };
      const speaker: Message["speaker"] = index % 4 === 0 ? "user" : "assistant";
      messages.push({ speaker, body: body(random, planned), at: startAt + index * random.int(5, 240) });
      produced += 1;
      written += 1;
    }
    conversation += 1;
    const fileIndex = files.length;
    if (engine === "claude") {
      const relative = path.join("claude", "projects", `-workspace-${project}`, `${random.hex(8)}-${random.hex(4)}-4${random.hex(3)}-a${random.hex(3)}-${random.hex(12)}.jsonl`);
      writeLines(outDir, relative, claudeLines(messages));
      files.push({ path: relative, project, engine, mtime: baseAt + fileIndex * 60 });
      continue;
    }
    const day = new Date(startAt * 1_000);
    const stamp = `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, "0")}-${String(day.getUTCDate()).padStart(2, "0")}T00-00-00`;
    const threadId = `${random.hex(8)}-${random.hex(4)}-4${random.hex(3)}-a${random.hex(3)}-${random.hex(12)}`;
    const relative = path.join("codex", "sessions", String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, "0"), `rollout-${stamp}-${threadId}.jsonl`);
    writeLines(outDir, relative, codexLines(messages, []));
    files.push({ path: relative, project, engine, mtime: baseAt + fileIndex * 60 });
    /* A resumed rollout replays the whole prior history as response items and
       then continues; a third of Codex conversations resume once or twice. */
    let history = messages;
    let resumes = random.chance(0.34) ? random.int(1, 2) : 0;
    let generation = 1;
    while (resumes > 0 && written < options.messages) {
      resumes -= 1;
      const fresh: Message[] = [];
      const freshCount = Math.max(1, Math.round(perConversation * 0.5 * random.next()));
      const lastAt = history.at(-1)!.at;
      for (let index = 0; index < freshCount && written < options.messages; index += 1) {
        const harbor = random.chance(0.2);
        fresh.push({
          speaker: index % 4 === 0 ? "user" : "assistant",
          body: body(random, { rare: rareSlots.has(produced), harbor, granite: harbor ? random.chance(0.45) : random.chance(0.05), ledger: random.chance(0.45) }),
          at: lastAt + 3_600 + index * random.int(5, 240),
        });
        produced += 1;
        written += 1;
      }
      const resumedRelative = path.join("codex", "sessions", String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, "0"), `rollout-${stamp}-${threadId}-resume-${generation}.jsonl`);
      writeLines(outDir, resumedRelative, codexLines(fresh, history));
      files.push({ path: resumedRelative, project, engine, mtime: baseAt + files.length * 60 + generation });
      history = [...history, ...fresh];
      generation += 1;
      /* Replayed history counts as indexed messages, as it does in production. */
      written += history.length - fresh.length;
    }
  }
  for (const file of files) fs.utimesSync(path.join(outDir, file.path), file.mtime, file.mtime);
  const manifest: TranscriptFixtureManifest = {
    seed: options.seed,
    conversations: files.length,
    messages: written,
    probes: { ...TRANSCRIPT_FIXTURE_PROBES },
    files,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest));
  return manifest;
}

function writeLines(outDir: string, relative: string, lines: string[]): void {
  const target = path.join(outDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, lines.join("\n") + "\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outDir = args.find((arg) => !arg.startsWith("--") && !/^\d+$/.test(arg));
  if (!outDir) {
    console.error("usage: bun scripts/transcript-search-fixture.ts <outDir> [--conversations N] [--messages N] [--seed N]");
    process.exit(2);
  }
  const startedAt = performance.now();
  const manifest = writeTranscriptFixture(path.resolve(outDir), {
    conversations: flag(args, "conversations", 7_200),
    messages: flag(args, "messages", 250_000),
    seed: flag(args, "seed", 1_429),
  });
  console.log(`wrote ${manifest.conversations} transcripts / ${manifest.messages} indexable messages in ${((performance.now() - startedAt) / 1_000).toFixed(1)} s`);
}
