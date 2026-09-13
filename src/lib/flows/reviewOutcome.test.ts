import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { reviewOutcomeFor } from "./reviewOutcome";

/*
 * Issue #325: direct one-shot reviewers have no flow engine watching them, so
 * the files projection derives their terminal verdict straight from the
 * reviewer transcript's last assistant message — the same fallback contract the
 * flow engine already uses (findings.ts). Fixtures mirror real CLI transcripts.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-review-outcome-"));

function writeTranscript(name: string, lines: object[]): { path: string; root: "claude-projects" | "codex-sessions"; size: number; mtime: number } {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const stat = fs.statSync(file);
  return {
    path: file,
    root: name.startsWith("codex") ? "codex-sessions" : "claude-projects",
    size: stat.size,
    mtime: stat.mtimeMs / 1000,
  };
}

const claudeAssistant = (text: string, timestamp = "2026-07-10T02:00:00.000Z") => ({
  type: "assistant",
  timestamp,
  message: { content: [{ type: "text", text }] },
});

describe("reviewOutcomeFor", () => {
  test("reads a REQUEST_CHANGES verdict with findings from a claude reviewer tail", () => {
    const entry = writeTranscript("claude-request-changes.jsonl", [
      { type: "user", timestamp: "2026-07-10T01:00:00.000Z", message: { content: "review this diff" } },
      claudeAssistant([
        "VERDICT: REQUEST_CHANGES",
        "### Finding 1",
        "- **Severity:** High",
        "- **File:** src/app.ts",
        "- **Line:** 12",
        "- **Title:** Broken null guard",
        "- **Explanation:** The guard inverts the check.",
      ].join("\n")),
    ]);

    const outcome = reviewOutcomeFor(entry);
    expect(outcome).not.toBeNull();
    expect(outcome!.verdict).toBe("REQUEST_CHANGES");
    expect(outcome!.findingsCount).toBe(1);
    expect(outcome!.observedAt).toBe("2026-07-10T02:00:00.000Z");
  });

  test("treats an exact NO FINDINGS reply as a clean APPROVE with zero findings", () => {
    const entry = writeTranscript("codex-no-findings.jsonl", [
      { timestamp: "2026-07-10T03:00:00.000Z", payload: { type: "agent_message", message: "NO FINDINGS" } },
    ]);

    const outcome = reviewOutcomeFor(entry);
    expect(outcome).not.toBeNull();
    expect(outcome!.verdict).toBe("APPROVE");
    expect(outcome!.findingsCount).toBe(0);
    expect(outcome!.observedAt).toBe("2026-07-10T03:00:00.000Z");
  });

  test("a bold verdict beside NO FINDINGS projects as a clean APPROVE (#1682)", () => {
    const entry = writeTranscript("claude-bold-verdict.jsonl", [
      claudeAssistant("Every acceptance item holds.\n\n---\n\n**VERDICT: APPROVE**\n\nNO FINDINGS"),
    ]);
    expect(reviewOutcomeFor(entry)).toMatchObject({ verdict: "APPROVE", findingsCount: 0 });
  });

  test("a bold change request is read from the verdict line itself, with its finding (#1682)", () => {
    const entry = writeTranscript("claude-bold-request-changes.jsonl", [
      claudeAssistant([
        "**VERDICT: REQUEST_CHANGES**",
        "### Finding 1",
        "- **Severity:** High",
        "- **File:** src/app.ts",
        "- **Title:** Broken null guard",
        "- **Explanation:** The guard inverts the check.",
      ].join("\n")),
    ]);
    expect(reviewOutcomeFor(entry)).toMatchObject({ verdict: "REQUEST_CHANGES", findingsCount: 1 });
  });

  test("NO FINDINGS cannot approve a reply whose verdict lines conflict or only restate the template (#1682)", () => {
    const conflicting = writeTranscript("claude-conflicting-verdicts.jsonl", [
      claudeAssistant("VERDICT: REQUEST_CHANGES\n\nOn a second look it is fine.\n\n**VERDICT: APPROVE**\n\nNO FINDINGS"),
    ]);
    const template = writeTranscript("claude-template-verdict.jsonl", [
      claudeAssistant("VERDICT: APPROVE | REQUEST_CHANGES | COMMENT\n\nNO FINDINGS"),
    ]);
    expect(reviewOutcomeFor(conflicting)).toBeNull();
    expect(reviewOutcomeFor(template)).toBeNull();
  });

  test("a reviewer that produced no verdict yields no outcome", () => {
    const entry = writeTranscript("claude-no-verdict.jsonl", [
      claudeAssistant("Still reading the diff, hold on."),
    ]);
    expect(reviewOutcomeFor(entry)).toBeNull();
  });

  test("a growing transcript is re-read once its size changes", () => {
    const entry = writeTranscript("claude-growing.jsonl", [claudeAssistant("Analyzing…")]);
    expect(reviewOutcomeFor(entry)).toBeNull();

    fs.appendFileSync(entry.path, JSON.stringify(claudeAssistant("VERDICT: APPROVE\nClean work.")) + "\n");
    const stat = fs.statSync(entry.path);
    const grown = { ...entry, size: stat.size, mtime: stat.mtimeMs / 1000 };
    expect(reviewOutcomeFor(grown)?.verdict).toBe("APPROVE");
  });
});
