import { expect, test } from "bun:test";

import { ROLE_DEFAULTS } from "./defaults";
import { defaultRoleParameterValues } from "./parameters";

test("orchestrator draft parameters default omitted maxWorkers to three", () => {
  const orchestrator = ROLE_DEFAULTS.find((role) => role.id === "orchestrator");
  if (!orchestrator) throw new Error("expected orchestrator role");

  expect(defaultRoleParameterValues(orchestrator)).toMatchObject({ maxWorkers: 3 });
});

test("unrelated integer draft parameters retain their minimum-based default", () => {
  const reviewer = ROLE_DEFAULTS.find((role) => role.id === "reviewer");
  if (!reviewer) throw new Error("expected reviewer role");

  expect(defaultRoleParameterValues(reviewer)).toMatchObject({ parallelN: 1 });
});
