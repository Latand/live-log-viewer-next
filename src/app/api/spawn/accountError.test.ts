import { expect, test } from "bun:test";

import { NoHealthyClaudeAccountError } from "@/lib/accounts/spawnHealth";

import { spawnAccountErrorResponse } from "./accountError";

test("the no-healthy-account path returns a retry-safe actionable 503", async () => {
  const response = spawnAccountErrorResponse(new NoHealthyClaudeAccountError(["botfatherdev-2"]));

  expect(response?.status).toBe(503);
  expect(await response?.json()).toEqual({
    error: "No healthy Claude account is available. Re-login account botfatherdev-2 in Accounts and retry.",
    retrySafe: true,
  });
});
