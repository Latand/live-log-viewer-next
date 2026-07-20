/**
 * Assemble `capture-manifest.json` from the REAL chrome-headless captures a
 * capture.sh run just produced. Invoked by capture.sh only — never by hand —
 * so every committed manifest is the record of one actual browser run.
 *
 * For each capture the builder:
 *  - parses the PNG IHDR and REFUSES a capture whose pixel geometry is not
 *    exactly viewport × deviceScaleFactor (the mechanical viewport check);
 *  - records the capture's SHA-256.
 * It also digests the harness inputs (harness.tsx, capture.sh) and stamps the
 * git revision, so `evidence.test.ts` can prove the committed stills bind to
 * these exact captures and this exact harness.
 *
 *   bun docs/screenshots/issue-499/build-manifest.ts <captures.list>
 *
 * where each list line is: `name view lang theme width height`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { CaptureEntry, CaptureManifest } from "./generate-stills";

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
if (!listPath) throw new Error("usage: bun build-manifest.ts <captures.list>");

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
  captures[name] = { view, lang, theme, viewport, png: { ...pixels, sha256: sha256(bytes) } };
}

const manifest: CaptureManifest = {
  classification: "synthetic",
  generator: "docs/screenshots/issue-499/capture.sh",
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: DIR }).toString().trim(),
  deviceScaleFactor: DEVICE_SCALE_FACTOR,
  harness: Object.fromEntries(
    ["harness.tsx", "capture.sh"].map((name) => [name, sha256(readFileSync(join(DIR, name)))]),
  ),
  captures: Object.fromEntries(Object.entries(captures).sort(([a], [b]) => a.localeCompare(b))),
};

writeFileSync(join(DIR, "capture-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`capture-manifest.json: ${lines.length} captures digested and geometry-verified.\n`);
