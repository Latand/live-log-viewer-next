import { expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TRANSCRIPT_FIXTURE_PROBES, writeTranscriptFixture, type TranscriptFixtureManifest } from "./transcript-search-fixture";

function digest(root: string, manifest: TranscriptFixtureManifest): string {
  const hash = crypto.createHash("sha256");
  for (const file of manifest.files) hash.update(fs.readFileSync(path.join(root, file.path)));
  return hash.digest("hex");
}

/** Every message the index would hold: Claude records, and Codex response
    items (the event twin of each fresh Codex turn is what the reader collapses). */
function indexedMessages(root: string, manifest: TranscriptFixtureManifest): Array<{ speaker: string; body: string }> {
  const messages: Array<{ speaker: string; body: string }> = [];
  for (const file of manifest.files) {
    for (const line of fs.readFileSync(path.join(root, file.path), "utf8").split("\n")) {
      if (!line) continue;
      const parsed = JSON.parse(line) as { type: string; message?: { content: unknown }; payload?: { type?: string; role?: string; content?: Array<{ text?: string }> } };
      if (file.engine === "claude" && (parsed.type === "user" || parsed.type === "assistant")) {
        const content = parsed.message?.content;
        messages.push({
          speaker: parsed.type,
          body: typeof content === "string" ? content : (content as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n"),
        });
      } else if (parsed.type === "response_item" && parsed.payload?.type === "message") {
        messages.push({ speaker: parsed.payload.role!, body: parsed.payload.content!.map((part) => part.text ?? "").join("\n") });
      }
    }
  }
  return messages;
}

test("the corpus is deterministic under a seed and keeps the probe frequencies it promises", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-search-fixture-"));
  try {
    const options = { conversations: 80, messages: 3_000, seed: 7 };
    const first = writeTranscriptFixture(path.join(sandbox, "first"), options);
    const second = writeTranscriptFixture(path.join(sandbox, "second"), options);

    expect(first.files.map((file) => file.path)).toEqual(second.files.map((file) => file.path));
    expect(digest(path.join(sandbox, "first"), first)).toBe(digest(path.join(sandbox, "second"), second));

    const messages = indexedMessages(path.join(sandbox, "first"), first);
    const count = (predicate: (body: string) => boolean) => messages.filter((message) => predicate(message.body)).length;
    const word = (value: string) => new RegExp(`\\b${value}\\b`);
    const [harbor, granite] = TRANSCRIPT_FIXTURE_PROBES.commonPair.split(" ");

    expect(messages).toHaveLength(first.messages);
    /* Three placed hits; a resumed rollout may replay one of them. */
    expect(count((body) => word(TRANSCRIPT_FIXTURE_PROBES.rare).test(body))).toBeGreaterThanOrEqual(3);
    expect(count((body) => word(TRANSCRIPT_FIXTURE_PROBES.rare).test(body))).toBeLessThanOrEqual(5);
    const veryCommon = count((body) => word(TRANSCRIPT_FIXTURE_PROBES.veryCommon).test(body)) / messages.length;
    expect(veryCommon).toBeGreaterThan(0.38);
    expect(veryCommon).toBeLessThan(0.52);
    const pair = count((body) => word(harbor!).test(body) && word(granite!).test(body)) / messages.length;
    expect(pair).toBeGreaterThan(0.05);
    expect(pair).toBeLessThan(0.13);
    const operator = messages.filter((message) => message.speaker === "user").length / messages.length;
    expect(operator).toBeGreaterThan(0.2);
    expect(operator).toBeLessThan(0.33);
    /* Replays make the duplicate groups the search collapses. */
    const distinct = new Set(messages.map((message) => `${message.speaker}\0${message.body.trim().replace(/\s+/gu, " ")}`)).size;
    expect(distinct).toBeLessThan(messages.length * 0.95);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
