import { expect, test } from "bun:test";
import path from "node:path";

test("the packed standalone server starts with every worker available", async () => {
  const nodeSearchPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((directory) => !path.basename(directory).startsWith("bun-node-"))
    .join(path.delimiter);
  const nodeExecutable = Bun.which("node", { PATH: nodeSearchPath });
  if (!nodeExecutable) throw new Error("the npm package smoke requires Node");
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "npm-package-smoke.mjs")], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { ...process.env, LLV_NODE_EXECUTABLE: nodeExecutable },
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
