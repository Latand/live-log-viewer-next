import { expect, test } from "bun:test";

import { GET } from "./route";

test("roles route returns all merged role definitions with scaffold previews", async () => {
  const response = await GET();
  const body = await response.json() as { schemaVersion: number; roles: { id: string; promptPreview: string }[] };

  expect(body.schemaVersion).toBe(1);
  expect(body.roles).toHaveLength(8);
  expect(body.roles[0]).toMatchObject({ id: "orchestrator" });
  expect(body.roles.find((role) => role.id === "deployer")?.promptPreview).toContain("blue/green");
});
