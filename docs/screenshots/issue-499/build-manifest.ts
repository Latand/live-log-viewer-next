/**
 * Assemble `capture-manifest.json` from the REAL chrome-headless captures a
 * capture.sh run just produced. Invoked by capture.sh only — never by hand —
 * so every committed manifest is the record of one actual browser run.
 *
 * For each capture the builder:
 *  - parses the PNG IHDR and REFUSES a capture whose pixel geometry is not
 *    exactly viewport × deviceScaleFactor (the mechanical viewport check);
 *  - records the capture's SHA-256.
 * It also digests the harness inputs (harness.tsx, capture.sh), stamps the git
 * revision AND its source-tree object, and attaches the geometry list's
 * getBoundingClientRect records to the picker-open captures. Each capture row
 * is then sealed with a SHA-256 over its canonical record (`captureDigest`),
 * so `evidence.test.ts` — and CI — can recompute every capture digest from the
 * committed manifest alone and prove the stills bind to these exact captures,
 * this exact harness, and the reviewed source-tree revision.
 *
 *   bun docs/screenshots/issue-499/build-manifest.ts <captures.list> <geometry.list>
 *
 * where each captures.list line is: `name view lang theme width height`, and
 * each geometry.list line is a JSON `{ name, geometry }` record.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { captureDigest, type CaptureEntry, type CaptureGeometry, type CaptureManifest } from "./generate-stills";

const DIR = dirname(new URL(import.meta.url).pathname);
const DEVICE_SCALE_FACTOR = 2;

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Width/height from the PNG IHDR (fails loudly on a non-PNG). */
function pngGeometry(bytes: Uint8Array, name: string): { width: number; height: number } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((byte, index) => bytes[index] !== byte)) {
    throw new Error(`${name}: not a PNG capture`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const listPath = process.argv[2];
const geometryPath = process.argv[3];
if (!listPath || !geometryPath) throw new Error("usage: bun build-manifest.ts <captures.list> <geometry.list>");

/** getBoundingClientRect records the geometry gate already collected, by name. */
const geometryByName = new Map<string, CaptureGeometry>();
const geometryRaw = readFileSync(geometryPath, "utf8").trim();
if (geometryRaw) {
  for (const line of geometryRaw.split("\n")) {
    const { name, geometry } = JSON.parse(line) as { name: string; geometry: CaptureGeometry };
    geometryByName.set(name, geometry);
  }
}

const captures: Record<string, CaptureEntry> = {};
const lines = readFileSync(listPath, "utf8").trim().split("\n");
for (const line of lines) {
  const [name, view, lang, theme, widthRaw, heightRaw] = line.trim().split(/\s+/);
  if (!name || !view || !lang || !theme || !widthRaw || !heightRaw) throw new Error(`malformed capture list line: ${line}`);
  const viewport = { width: Number(widthRaw), height: Number(heightRaw) };
  const bytes = readFileSync(join(DIR, `${name}.png`));
  const pixels = pngGeometry(bytes, name);
  const expected = { width: viewport.width * DEVICE_SCALE_FACTOR, height: viewport.height * DEVICE_SCALE_FACTOR };
  if (pixels.width !== expected.width || pixels.height !== expected.height) {
    throw new Error(`${name}: captured ${pixels.width}×${pixels.height}, expected ${expected.width}×${expected.height} for a ${viewport.width}×${viewport.height} viewport at scale ${DEVICE_SCALE_FACTOR}`);
  }
  const geometry = geometryByName.get(name);
  const record = { view, lang, theme, viewport, png: { ...pixels, sha256: sha256(bytes) }, ...(geometry ? { geometry } : {}) };
  // Seal the canonical record so CI can recompute this exact digest from the
  // committed manifest bytes alone.
  captures[name] = { ...record, sha256: captureDigest(record) };
}

const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: DIR }).toString().trim();
const manifest: CaptureManifest = {
  classification: "synthetic",
  generator: "docs/screenshots/issue-499/capture.sh",
  sourceRevision: revision,
  sourceTree: execFileSync("git", ["rev-parse", `${revision}^{tree}`], { cwd: DIR }).toString().trim(),
  deviceScaleFactor: DEVICE_SCALE_FACTOR,
  harness: Object.fromEntries(
    ["harness.tsx", "capture.sh"].map((name) => [name, sha256(readFileSync(join(DIR, name)))]),
  ),
  captures: Object.fromEntries(Object.entries(captures).sort(([a], [b]) => a.localeCompare(b))),
};

writeFileSync(join(DIR, "capture-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(
  `capture-manifest.json: ${lines.length} captures digested and geometry-verified (${geometryByName.size} with control geometry).\n`,
);
