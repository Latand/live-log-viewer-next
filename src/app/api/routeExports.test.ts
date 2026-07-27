import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

/**
 * A route module may export ONLY the documented route fields.
 *
 * Next.js validates that list when it builds, and rejects anything else outright:
 *
 *   Type error: Route "src/app/api/…/route.ts" does not match the required types
 *   of a Next.js Route. "…" is not a valid Route export field.
 *
 * The trap is that `tsc --noEmit` accepts the offending file happily, and so do
 * unit tests — a test seam exported from a route passes every cheap check and then
 * breaks `next build` for everyone. That happened on this branch (#691), and a
 * two-minute build is too slow a feedback loop to be the only thing that catches it.
 *
 * So this reads the route files directly rather than importing them: importing a
 * route drags in its whole dependency graph, and the question here is purely about
 * what the module's surface says.
 */

/** Handlers and segment config, per `node_modules/next/dist/docs` (route.md and
    02-route-segment-config). Anything outside this belongs in a module the route
    imports. */
const LEGAL_ROUTE_EXPORTS = new Set([
  "GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS",
  "dynamic", "dynamicParams", "revalidate", "fetchCache", "runtime",
  "preferredRegion", "maxDuration", "generateStaticParams", "experimental_ppr",
]);

const APP_DIR = path.join(process.cwd(), "src", "app");

function routeFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...routeFiles(target));
    else if (entry.name === "route.ts" || entry.name === "route.tsx") found.push(target);
  }
  return found;
}

/** Named exports declared at the top level of a module, by their spelling in the
    source. Deliberately literal: this mirrors what Next.js reads off the module. */
function namedExports(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)) {
    names.push(match[1]!);
  }
  /* `export { a, b }` and `export type { … }` — the braced form reaches the module
     surface exactly the same way a declaration does. */
  for (const match of source.matchAll(/^export\s+(type\s+)?\{([^}]*)\}/gm)) {
    if (match[1]) continue;
    for (const part of match[2]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

test("every route module exports only the fields Next.js allows", () => {
  const routes = routeFiles(APP_DIR);
  /* A sanity floor: if the walk finds nothing, the assertion below is vacuous and
     this test would "pass" while checking no routes at all. */
  expect(routes.length).toBeGreaterThan(20);

  const offenders: string[] = [];
  for (const route of routes) {
    const source = fs.readFileSync(route, "utf8");
    for (const name of namedExports(source)) {
      if (LEGAL_ROUTE_EXPORTS.has(name)) continue;
      offenders.push(`${path.relative(process.cwd(), route)} exports ${name}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("the export reader sees the forms a route can actually use", () => {
  /* Guards the guard: a reader that silently matched nothing would make the test
     above pass against any file at all. */
  const source = [
    'import { NextResponse } from "next/server";',
    'export const runtime = "nodejs";',
    "export async function GET() { return NextResponse.json({}); }",
    "export function __setSomethingForTest(value: unknown): void { void value; }",
    "export type NotARouteField = { a: 1 };",
    "export { helper, other as alias };",
    "function helper() {}",
  ].join("\n");

  expect(namedExports(source).sort()).toEqual([
    "GET",
    "__setSomethingForTest",
    "alias",
    "helper",
    "runtime",
  ]);
  /* And a type-only re-export is not a runtime field, so it is not flagged. */
  expect(namedExports("export type { Foo };")).toEqual([]);
});
