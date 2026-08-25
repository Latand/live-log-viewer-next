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
