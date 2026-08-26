import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import nextConfig from "./next.config";

test("every library worker is bundled and traced into standalone output", async () => {
  const workerFiles = fs.readdirSync(path.join(import.meta.dir, "src/lib"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".worker.ts"))
    .map((entry) => entry.name)
    .sort();

  if (!nextConfig.webpack) throw new Error("next config has no webpack hook");
  const configured = nextConfig.webpack(
    { entry: {} },
    { isServer: true, nextRuntime: "nodejs" } as Parameters<NonNullable<typeof nextConfig.webpack>>[1],
  );
  if (typeof configured.entry !== "function") throw new Error("webpack entries are not configurable");
  const entries = await configured.entry();
  const tracingIncludes = nextConfig.outputFileTracingIncludes?.["/*"] ?? [];

  expect(workerFiles.length).toBeGreaterThan(0);
  expect(tracingIncludes).toContain(".next/server/chunks/**");
  for (const workerFile of workerFiles) {
    const source = `./src/lib/${workerFile}`;
    const workerEntry = Object.entries(entries).find(([, entry]) => entry === source);
    if (!workerEntry) throw new Error(`${workerFile} has no webpack entry`);
    expect(
      tracingIncludes,
      `${workerFile} has no standalone tracing include`,
    ).toContain(`.next/server/${workerEntry[0]}.js`);
  }
});
