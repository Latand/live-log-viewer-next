import { expect, test } from "bun:test";
import path from "node:path";

test("the packed standalone server starts with every worker available", async () => {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "npm-package-smoke.mjs")], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode, `${stdout}\n${stderr}`.trim()).toBe(0);
}, 150_000);
