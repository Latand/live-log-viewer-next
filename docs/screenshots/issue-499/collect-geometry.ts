/**
 * Extract the browser harness's `#capture-geometry` record from a chrome
 * --dump-dom pass and append it to the geometry list capture.sh feeds
 * build-manifest.ts. Invoked by capture.sh only.
 *
 *   printf '%s' "$dom" | bun collect-geometry.ts <name> <width> <height>
 *
 * The record carries the getBoundingClientRect of Send, the model/reasoning
 * pill, and the opened reasoning + model picker surfaces. This step REFUSES a
 * capture whose controls are not nonzero and fully inside the CSS viewport —
 * the geometry acceptance gate — so a regression that collapses or pushes a
 * control off-screen fails the capture loudly rather than committing bad
 * evidence.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { GEOMETRY_CONTROLS, rectInViewport, type CaptureGeometry, type ControlRect } from "./generate-stills";

const DIR = dirname(new URL(import.meta.url).pathname);

const [name, widthRaw, heightRaw] = process.argv.slice(2);
if (!name || !widthRaw || !heightRaw) throw new Error("usage: bun collect-geometry.ts <name> <width> <height>");
const viewport = { width: Number(widthRaw), height: Number(heightRaw) };

const dom = readFileSync(0, "utf8");
const match = /<script id="capture-geometry" type="application\/json">([\s\S]*?)<\/script>/.exec(dom);
if (!match) throw new Error(`GEOMETRY FAILED [${name}]: harness emitted no #capture-geometry node`);

const emitted = JSON.parse(match[1]!) as {
  viewport: { width: number; height: number };
  controls: Record<string, ControlRect>;
};

if (emitted.viewport.width !== viewport.width || emitted.viewport.height !== viewport.height) {
  throw new Error(
    `GEOMETRY FAILED [${name}]: measured at ${emitted.viewport.width}×${emitted.viewport.height}, expected ${viewport.width}×${viewport.height}`,
  );
}

const controls: Record<string, ControlRect> = {};
for (const control of GEOMETRY_CONTROLS) {
  const rect = emitted.controls[control];
  if (!rect) throw new Error(`GEOMETRY FAILED [${name}]: no ${control} rect`);
  if (!rectInViewport(rect, viewport)) {
    throw new Error(
      `GEOMETRY FAILED [${name}]: ${control} ${JSON.stringify(rect)} is not nonzero and fully within ${viewport.width}×${viewport.height}`,
    );
  }
  controls[control] = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

const geometry: CaptureGeometry = {
  send: controls.send!,
  pill: controls.pill!,
  reasoningPicker: controls.reasoningPicker!,
  modelPicker: controls.modelPicker!,
};

appendFileSync(join(DIR, "geometry.list"), `${JSON.stringify({ name, geometry })}\n`);
process.stdout.write(`geometry ${name}: all controls nonzero and in-viewport.\n`);
