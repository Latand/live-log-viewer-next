import { expect, test } from "bun:test";

import { McpHealthProbeAdmissions } from "./mcpHealthProbeAdmission";

test("host health capabilities are single-use, expiring, and explicitly revocable", () => {
  let now = 100;
  const admissions = new McpHealthProbeAdmissions(() => now, 10);

  const consumed = admissions.issue();
  expect(admissions.consume(consumed)).toBe(true);
  expect(admissions.consume(consumed)).toBe(false);

  const expired = admissions.issue();
  now = 110;
  expect(admissions.consume(expired)).toBe(false);

  const revoked = admissions.issue();
  admissions.revoke(revoked);
  expect(admissions.consume(revoked)).toBe(false);

  expect(admissions.consume(undefined)).toBe(false);
  expect(admissions.consume("self-selected")).toBe(false);
});
