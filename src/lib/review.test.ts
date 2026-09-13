import { expect, test } from "bun:test";

import { countFindingBlocks, parseReview } from "./review";

const HEADING_FIELDS = `VERDICT: REQUEST_CHANGES

### Finding 1
**Severity:** High
**File:** src/example/alpha.ts
**Line:** 42
**Title:** Retry loop drops the deadline
**Explanation:** The helper rebuilds the deadline on every attempt, so a slow call never aborts.

### Finding 2
**Severity:** Medium
**File:** src/example/beta.ts
**Title:** Missing null guard
**Explanation:** The lookup assumes the map always holds the key.
`;

const PLAIN_BULLET_FIELDS = `VERDICT: REQUEST_CHANGES

Findings

- Severity: Medium
- File: src/example/alpha.ts
- Line: 42
- Title: Retry loop drops the deadline
- Explanation: The deadline is recomputed per attempt.

- Severity: Low
- File: src/example/beta.ts
- Title: Missing null guard
- Explanation: The lookup assumes the map always holds the key.
`;

const PROSE_BULLETS = `VERDICT: REQUEST_CHANGES

- **HIGH — src/example/alpha.ts:42 — Retry loop drops the deadline.** The helper recomputes the deadline on every attempt.
- **MEDIUM — src/example/beta.ts:17 — Missing null guard.** The lookup assumes the map always holds the key.
`;

test("parses field lines that carry the label without a leading bullet", () => {
  expect(parseReview(HEADING_FIELDS, null)?.findings).toMatchObject([
    { severity: "High", file: "src/example/alpha.ts", line: 42, title: "Retry loop drops the deadline" },
    { severity: "Medium", file: "src/example/beta.ts", title: "Missing null guard" },
  ]);
});

test("parses bulleted field lines that are not bold", () => {
  expect(parseReview(PLAIN_BULLET_FIELDS, null)?.findings).toMatchObject([
    { severity: "Medium", file: "src/example/alpha.ts", line: 42, title: "Retry loop drops the deadline" },
    { severity: "Low", file: "src/example/beta.ts", title: "Missing null guard" },
  ]);
});

test("keeps parsing the bulleted-and-bold field contract", () => {
  const review = parseReview(
    "VERDICT: REQUEST_CHANGES\n\n- **Severity:** Critical\n- **File:** src/example/alpha.ts\n- **Title:** Unsafe cast\n- **Explanation:** The cast hides a null.\n",
    null,
  );
  expect(review?.findings).toMatchObject([{ severity: "Critical", file: "src/example/alpha.ts", title: "Unsafe cast" }]);
});

test("strips the trailing marker of a whole-line bold field label", () => {
  const review = parseReview(
    "VERDICT: REQUEST_CHANGES\n\n**Severity: High**\n**File: src/example/alpha.ts**\n**Title: Unsafe cast**\n**Explanation: The cast hides a null.**\n",
    null,
  );
  expect(review?.findings).toMatchObject([
    { severity: "High", file: "src/example/alpha.ts", title: "Unsafe cast", body: "The cast hides a null." },
  ]);
});

test("counts finding blocks from headings, severity bullets, or nothing at all", () => {
  expect(countFindingBlocks(HEADING_FIELDS)).toBe(2);
  expect(countFindingBlocks(PROSE_BULLETS)).toBe(2);
  expect(countFindingBlocks("VERDICT: APPROVE\n\nThe change is scoped and the tests cover it.\n")).toBe(0);
});

const verdictOf = (text: string) => parseReview(text, null)?.verdict ?? null;

test("reads a verdict line wrapped in Markdown emphasis or led by a heading (#1682)", () => {
  expect(verdictOf("Summary.\n\n**VERDICT: APPROVE**\n")).toBe("APPROVE");
  expect(verdictOf("Summary.\n\n__VERDICT: APPROVE__\n")).toBe("APPROVE");
  expect(verdictOf("Summary.\n\n***VERDICT: COMMENT***\n")).toBe("COMMENT");
  expect(verdictOf("## VERDICT: APPROVE\n\nSummary.\n")).toBe("APPROVE");
  expect(verdictOf("### **Verdict:** REQUEST_CHANGES\n")).toBe("REQUEST_CHANGES");
  expect(verdictOf("**VERDICT:** COMMENT\n")).toBe("COMMENT");
  expect(verdictOf("**Verdict**: APPROVE\n")).toBe("APPROVE");
  expect(verdictOf("Verdict: **REQUEST_CHANGES**\n")).toBe("REQUEST_CHANGES");
  expect(verdictOf("Summary.\r\n\r\n**VERDICT: APPROVE**\r\n")).toBe("APPROVE");
});

test("keeps the trailing notes reviewers put after an emphasized verdict (#1682)", () => {
  expect(verdictOf("**VERDICT: APPROVE** at `a1b2c3d`\n")).toBe("APPROVE");
  expect(verdictOf("## VERDICT: APPROVE — NO FINDINGS\n")).toBe("APPROVE");
  expect(verdictOf("**VERDICT: APPROVE — NO FINDINGS**\n")).toBe("APPROVE");
  expect(verdictOf("**VERDICT: REQUEST_CHANGES** for reviewed SHA `a1b2c3d`\n")).toBe("REQUEST_CHANGES");
  expect(verdictOf("**VERDICT: APPROVE** — only cosmetic notes remain\n")).toBe("APPROVE");
});

test("keeps the plain verdict lines the parser already accepted", () => {
  expect(verdictOf("VERDICT: REQUEST_CHANGES\n")).toBe("REQUEST_CHANGES");
  expect(verdictOf("VERDICT: REQUEST_CHANGES — 3 HIGH, 2 MEDIUM, 1 LOW\n")).toBe("REQUEST_CHANGES");
  expect(verdictOf("VERDICT: APPROVE  \n")).toBe("APPROVE");
  expect(verdictOf("APPROVE — NO FINDINGS\n")).toBe("APPROVE");
  expect(verdictOf("REQUEST_CHANGES\n\n1. High — src/example/alpha.ts:4 — broken\n")).toBe("REQUEST_CHANGES");
  expect(verdictOf("REQUEST_CHANGES at `a1b2c3d`.\n")).toBe("REQUEST_CHANGES");
  expect(verdictOf("APPROVE for this stage: the deliverable is complete.\n")).toBe("APPROVE");
  expect(verdictOf("VERDICT: APPROVE\n\nDetails.\n\n**VERDICT: APPROVE**\n")).toBe("APPROVE");
});

test("a verdict word inside prose, a finding heading or a longer token is not a verdict", () => {
  expect(verdictOf("I would approve this once tests pass.\n")).toBeNull();
  expect(verdictOf("The reviewer ends with **VERDICT: APPROVE** when the diff is clean.\n")).toBeNull();
  expect(verdictOf("Example: **VERDICT: APPROVE**\n")).toBeNull();
  expect(verdictOf("- **VERDICT: APPROVE**\n")).toBeNull();
  expect(verdictOf("**APPROVE**\n")).toBeNull();
  expect(verdictOf("### COMMENT — the cache key ignores the locale\n")).toBeNull();
  expect(verdictOf("**Verdict: APPROVED.**\n")).toBeNull();
  expect(verdictOf("- Verdict: `APPROVE_DECISION`\n")).toBeNull();
  expect(verdictOf("COMMENT-level notes only.\n")).toBeNull();
  expect(verdictOf("VERDICT: REQUEST_CHANGES\n\n### COMMENT — the cache key ignores the locale\n**COMMENT — `src/example/alpha.ts:4`** — naming\n"))
    .toBe("REQUEST_CHANGES");
});

test("a quoted prior review or a code snippet never supplies the verdict", () => {
  expect(verdictOf("Round 1 said:\n\n> **VERDICT: APPROVE**\n> VERDICT: APPROVE\n")).toBeNull();
  expect(verdictOf("Format:\n\n```\nVERDICT: APPROVE\n```\n")).toBeNull();
  expect(verdictOf("Format:\n\n~~~markdown\n**VERDICT: APPROVE**\n~~~\n")).toBeNull();
  expect(verdictOf("````md\n```\nVERDICT: APPROVE\n```\n````\n")).toBeNull();
  expect(verdictOf("`VERDICT: APPROVE`\n")).toBeNull();
  expect(verdictOf("Format:\n\n    VERDICT: APPROVE\n")).toBeNull();
  expect(verdictOf("Previous round:\n\n> **VERDICT: APPROVE**\n\nThe fix regressed.\n\n**VERDICT: REQUEST_CHANGES**\n"))
    .toBe("REQUEST_CHANGES");
  expect(verdictOf("```\nVERDICT: REQUEST_CHANGES\n```\n\n**VERDICT: APPROVE**\n")).toBe("APPROVE");
});

test("an embedded prompt, a negated or conditional verdict, or a question is not a verdict", () => {
  expect(verdictOf("Output exactly this format:\nVERDICT: APPROVE | REQUEST_CHANGES | COMMENT\n")).toBeNull();
  expect(verdictOf("**VERDICT: APPROVE or REQUEST_CHANGES**\n")).toBeNull();
  expect(verdictOf("APPROVE requires findings to be empty.\n")).toBeNull();
  expect(verdictOf("APPROVE received. No findings require changes.\n")).toBeNull();
  expect(verdictOf("REQUEST_CHANGES is not the right verdict here.\n")).toBeNull();
  expect(verdictOf("APPROVE: no blocking issues remain\nREQUEST_CHANGES: required fixes\nCOMMENT: non-blocking notes\n")).toBeNull();
  expect(verdictOf("**VERDICT: NOT APPROVE**\n")).toBeNull();
  expect(verdictOf("VERDICT: ~~APPROVE~~\n")).toBeNull();
  expect(verdictOf("**VERDICT: APPROVE** once tests pass\n")).toBeNull();
  expect(verdictOf("VERDICT: APPROVE if CI stays green\n")).toBeNull();
  expect(verdictOf("## VERDICT: APPROVE — not yet\n")).toBeNull();
  expect(verdictOf("**VERDICT: APPROVE** only if CI stays green\n")).toBeNull();
  expect(verdictOf("VERDICT: APPROVE?\n")).toBeNull();
});

test("conflicting verdict lines yield no verdict instead of the first one", () => {
  expect(verdictOf("VERDICT: APPROVE\n\nOn a second look the migration drops rows.\n\nVERDICT: REQUEST_CHANGES\n")).toBeNull();
  expect(verdictOf("**VERDICT: REQUEST_CHANGES**\n\nActually fine.\n\n**VERDICT: APPROVE**\n")).toBeNull();
});

test("words after a change request describe the code and never make room for a later approval (review round 1)", () => {
  expect(verdictOf("VERDICT: REQUEST_CHANGES — cannot merge: the migration drops rows.\n\n1. HIGH — src/example/alpha.ts:4 — drops rows\n\nAfter the fix, I expect:\n\nVERDICT: APPROVE\n"))
    .toBeNull();
  expect(verdictOf("VERDICT: REQUEST_CHANGES if the lock is intended to be reentrant.\n\nAPPROVE — NO FINDINGS on the docs part\n"))
    .toBe("REQUEST_CHANGES");
  expect(verdictOf("**VERDICT: REQUEST_CHANGES** — not ready to merge\n")).toBe("REQUEST_CHANGES");
  expect(verdictOf("VERDICT: REQUEST_CHANGES — would break prod\n")).toBe("REQUEST_CHANGES");
  expect(verdictOf("**VERDICT: REQUEST_CHANGES** — APPROVE once the guard lands\n\nVERDICT: APPROVE\n")).toBeNull();
});

test("an approval must be unanimous across the reviewer's own verdict lines (review round 1)", () => {
  expect(verdictOf("VERDICT: APPROVE if CI stays green\n\n**VERDICT: APPROVE**\n")).toBeNull();
  expect(verdictOf("Output exactly this format:\nVERDICT: APPROVE | REQUEST_CHANGES | COMMENT\n\nVERDICT: APPROVE\n")).toBeNull();
  expect(verdictOf("**VERDICT: APPROVE**\n\nREQUEST_CHANGES — none left\n")).toBeNull();
  expect(verdictOf("Output exactly this format:\nVERDICT: APPROVE | REQUEST_CHANGES | COMMENT\n\nVERDICT: REQUEST_CHANGES\n"))
    .toBe("REQUEST_CHANGES");
});

test("a labelled verdict line outranks bare finding lines (review round 1)", () => {
  expect(verdictOf("VERDICT: REQUEST_CHANGES\n\nCOMMENT — src/example/beta.ts:9 — naming\n")).toBe("REQUEST_CHANGES");
  expect(verdictOf("**VERDICT: COMMENT**\n\nREQUEST_CHANGES — the guard is optional\n")).toBe("COMMENT");
});

test("a conditional clause after an approval takes it back (review round 1)", () => {
  expect(verdictOf("**VERDICT: APPROVE** (after fixes)\n")).toBeNull();
  expect(verdictOf("Verdict: APPROVE should be withheld until CI\n")).toBeNull();
  expect(verdictOf("VERDICT: APPROVE when the flake is fixed\n")).toBeNull();
  expect(verdictOf("VERDICT: APPROVE, assuming the migration was dry-run\n")).toBeNull();
  expect(verdictOf("VERDICT: APPROVE provided CI stays green\n")).toBeNull();
  expect(verdictOf("**VERDICT: APPROVE** (NO FINDINGS)\n")).toBe("APPROVE");
});
