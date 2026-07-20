import { expect, test } from "bun:test";
import path from "node:path";

import { WAKATIME_CREDENTIAL_ENV, withoutWakatimeCredential } from "./credential";

test("fresh outer Bun process keeps ambient credentials outside runtime and public evidence", async () => {
  const credentialPlaceholder = ["ambient", "outer", "fixture"].join("-");
  const child = Bun.spawn([
    process.execPath,
    "test",
    path.join(import.meta.dir, "ambientStartIsolation.child.test.ts"),
  ], {
    cwd: path.resolve(import.meta.dir, "../../.."),
    env: {
      ...withoutWakatimeCredential(process.env),
      LLV_WAKATIME_AMBIENT_CHILD: "1",
      [WAKATIME_CREDENTIAL_ENV]: credentialPlaceholder,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const publicEvidence = `${stdout}${stderr}`;
  if (publicEvidence.includes(WAKATIME_CREDENTIAL_ENV) || publicEvidence.includes(credentialPlaceholder)) {
    throw new Error("ambient child emitted unsafe public evidence");
  }
  if (exitCode !== 0) throw new Error("ambient isolation child failed");
  expect(exitCode).toBe(0);
});
