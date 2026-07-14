import { expect, test } from "bun:test";

import { invalidRouteExports } from "./routeExports";

test("rejects a route fixture with a stray value export", async () => {
  const fixture = new URL("./fixtures/route-exports/invalid/route.ts", import.meta.url);
  const source = await Bun.file(fixture).text();

  expect(invalidRouteExports(source, fixture.pathname)).toEqual([
    {
      file: fixture.pathname,
      line: 7,
      name: "strayHelper",
    },
  ]);
});

test("every application route exports only handlers and route config", async () => {
  const routeFiles = new Bun.Glob("src/app/**/route.ts");
  const invalid = [];

  for await (const file of routeFiles.scan({ cwd: process.cwd(), onlyFiles: true })) {
    const source = await Bun.file(file).text();
    invalid.push(...invalidRouteExports(source, file));
  }

  expect(invalid).toEqual([]);
});
