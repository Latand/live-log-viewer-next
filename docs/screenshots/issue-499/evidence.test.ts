/**
 * Issue #499 (repair round) — the committed immutable evidence must be
 * MECHANICALLY bound to the real browser harness run it re-renders:
 *
 *  1. `capture-manifest.json` is written by capture.sh from the actual
 *     chrome-headless captures: per-capture SHA-256 digests and pixel-verified
 *     viewport geometry, plus digests of the harness inputs themselves.
 *  2. Every committed `still-*.svg` regenerates byte-identically from that
 *     committed manifest, embeds the manifest's capture digest, and carries
 *     the capture's exact viewport geometry.
 *  3. The harness digests in the manifest match the CURRENT harness.tsx and
 *     capture.sh bytes — editing the harness without recapturing invalidates
 *     the evidence loudly.
 *  4. Each frame's depicted capability set (Send / model-reasoning pill /
 *     images / recovery) equals what the PRODUCTION capability matrix
 *     resolves for that state — computed here from `capabilitiesFor`, never
 *     trusted from the frame.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { capabilitiesFor } from "@/components/agentCapabilities";
import { translate, type MessageKey } from "@/lib/i18n";

import {
  GEOMETRY_CONTROLS,
  STILLS,
  captureDigest,
  evidenceFixtures,
  loadManifest,
  rectInViewport,
  stillSvg,
  type StillState,
} from "./generate-stills";

const DIR = import.meta.dir;
const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const manifest = loadManifest();

/* ------------------------------------------------------------------ *
 * 1. The manifest is a real, self-consistent capture record            *
 * ------------------------------------------------------------------ */

test("the committed capture manifest exists and records the harness run", () => {
  expect(existsSync(join(DIR, "capture-manifest.json"))).toBe(true);
  expect(manifest.classification).toBe("synthetic");
  expect(manifest.generator).toBe("docs/screenshots/issue-499/capture.sh");
  expect(manifest.sourceRevision).toMatch(/^[0-9a-f]{40}$/);
  expect(manifest.deviceScaleFactor).toBe(2);
  expect(Object.keys(manifest.captures).length).toBeGreaterThanOrEqual(STILLS.length);
});

test("the manifest's harness digests match the harness files as reviewed — a harness edit without a recapture fails here", () => {
  for (const name of ["harness.tsx", "capture.sh"] as const) {
    expect(manifest.harness[name]).toBe(sha256(readFileSync(join(DIR, name))));
  }
});

test("every manifest capture records digest + pixel geometry consistent with its viewport", () => {
  for (const [name, capture] of Object.entries(manifest.captures)) {
    expect(capture.png.sha256).toMatch(/^[0-9a-f]{64}$/);
    // chrome ran at --force-device-scale-factor=2: the capture's real pixel
    // dimensions must be exactly twice the requested CSS viewport.
    expect({ name, width: capture.png.width, height: capture.png.height })
      .toEqual({ name, width: capture.viewport.width * manifest.deviceScaleFactor, height: capture.viewport.height * manifest.deviceScaleFactor });
  }
});

/* ------------------------------------------------------------------ *
 * 1b. Every capture digest is RECOMPUTABLE from the committed manifest *
 *     — the privacy-safe canonical capture payload CI can re-derive    *
 * ------------------------------------------------------------------ */

test("every capture's sealing digest recomputes from its committed canonical record — a tampered row fails here", () => {
  for (const [name, capture] of Object.entries(manifest.captures)) {
    const { sha256, ...record } = capture;
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    // CI re-derives the digest from the committed manifest bytes alone; the
    // record commits to the captured PNG's SHA-256 and the measured geometry,
    // so no capture digest is a hand-declared number.
    expect({ name, sha256 }).toEqual({ name, sha256: captureDigest(record) });
  }
});

/* ------------------------------------------------------------------ *
 * 1c. The manifest binds to the EXACT reviewed source-tree revision    *
 * ------------------------------------------------------------------ */

const git = (...args: string[]): string => execFileSync("git", args, { cwd: DIR }).toString().trim();

test("the manifest's sourceTree is the git tree of its sourceRevision — recomputable, and binds to the reviewed source tree", () => {
  expect(manifest.sourceRevision).toMatch(/^[0-9a-f]{40}$/);
  expect(manifest.sourceTree).toMatch(/^[0-9a-f]{40}$/);
  // Recompute the tree object of the recorded revision: the manifest names the
  // exact source-tree revision, not a free-form string.
  expect(git("rev-parse", `${manifest.sourceRevision}^{tree}`)).toBe(manifest.sourceTree);
  // The recorded revision is part of this branch's history (an ancestor of the
  // reviewed HEAD), so the evidence cannot cite a stray commit.
  expect(() => git("merge-base", "--is-ancestor", manifest.sourceRevision, "HEAD")).not.toThrow();
});

test("the harness bytes committed AT sourceRevision are byte-identical to the reviewed harness — the manifest binds to that tree's harness", () => {
  for (const name of ["harness.tsx", "capture.sh"] as const) {
    const atRevision = execFileSync("git", ["show", `${manifest.sourceRevision}:docs/screenshots/issue-499/${name}`], { cwd: DIR });
    expect({ name, digest: sha256(atRevision) }).toEqual({ name, digest: manifest.harness[name] });
  }
});

/* ------------------------------------------------------------------ *
 * 1d. Control geometry: nonzero, fully in-viewport getBoundingClientRect
 *     for Send, the pill, and the opened reasoning + model pickers      *
 *     at 1440×900, 390×844 and 390×600                                  *
 * ------------------------------------------------------------------ */

const GEOMETRY_CAPTURES: Record<string, { width: number; height: number }> = {
  "popover-desktop-en-light": { width: 1440, height: 900 },
  "sheet-390-en-light": { width: 390, height: 844 },
  "sheet-390x600-en-light": { width: 390, height: 600 },
};

test("the harness recorded control geometry at all three viewports — 1440×900, 390×844 and 390×600", () => {
  const measured = Object.entries(manifest.captures)
    .filter(([, capture]) => capture.geometry)
    .map(([, capture]) => `${capture.viewport.width}x${capture.viewport.height}`)
    .sort();
  expect(measured).toEqual(["1440x900", "390x600", "390x844"]);
});

for (const [name, viewport] of Object.entries(GEOMETRY_CAPTURES)) {
  test(`Send, the model/reasoning pill, and the opened reasoning + model picker surfaces have nonzero in-viewport bounds at ${viewport.width}×${viewport.height}`, () => {
    const capture = manifest.captures[name];
    expect(capture).toBeDefined();
    expect(capture!.viewport).toEqual(viewport);
    const geometry = capture!.geometry;
    expect(geometry).toBeDefined();
    for (const control of GEOMETRY_CONTROLS) {
      const rect = geometry![control];
      expect({ control, rect }).toEqual({ control, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
      // Nonzero, and drawn fully within the CSS viewport it was measured at.
      expect({ control, inViewport: rectInViewport(rect, viewport) }).toEqual({ control, inViewport: true });
      expect({ control, nonzero: rect.width > 0 && rect.height > 0 }).toEqual({ control, nonzero: true });
    }
  });
}

/* ------------------------------------------------------------------ *
 * 2. Committed stills regenerate byte-identically from the manifest    *
 * ------------------------------------------------------------------ */

test("each committed still is byte-identical to its deterministic regeneration from the committed manifest", () => {
  for (const spec of STILLS) {
    const committed = readFileSync(join(DIR, spec.name), "utf8");
    expect({ still: spec.name, bytes: committed }).toEqual({ still: spec.name, bytes: stillSvg(spec, manifest) });
  }
});

test("each still embeds its capture's digest and exact viewport geometry", () => {
  for (const spec of STILLS) {
    const capture = manifest.captures[spec.capture];
    expect(capture).toBeDefined();
    const svg = readFileSync(join(DIR, spec.name), "utf8");
    const meta = JSON.parse(/<metadata id="provenance">(.*?)<\/metadata>/.exec(svg)![1]!) as Record<string, unknown>;
    expect(meta.classification).toBe("synthetic");
    expect(meta.sourceRevision).toBe(manifest.sourceRevision);
    expect(meta.capture).toBe(spec.capture);
    expect(meta.sourceCaptureSha256).toBe(capture!.png.sha256);
    expect(meta.viewport).toEqual(capture!.viewport);
    // The frame itself is drawn at the capture's CSS viewport geometry.
    expect(svg).toContain(`<svg xmlns="http://www.w3.org/2000/svg" width="${capture!.viewport.width}" height="${capture!.viewport.height}" viewBox="0 0 ${capture!.viewport.width} ${capture!.viewport.height}"`);
  }
});

/* ------------------------------------------------------------------ *
 * 3. Frames match PRODUCTION capability visibility per state           *
 * ------------------------------------------------------------------ */

/** The pill face drawn on live frames — must appear exactly when the matrix
    enables the runtime control for the state. */
const PILL_FACE = "5.6-Sol · High";

const STATES: StillState[] = ["live-ready", "unresolved-recovery", "dead-recovery", "image-upload"];

test("the frames' capability visibility is the production matrix's, not an illustration's", () => {
  for (const state of STATES) {
    const { file, view } = evidenceFixtures(state);
    const caps = capabilitiesFor(file, view, { runtimeEnabled: true });
    for (const spec of STILLS.filter((candidate) => candidate.state === state)) {
      const svg = readFileSync(join(DIR, spec.name), "utf8");
      const meta = JSON.parse(/<metadata id="provenance">(.*?)<\/metadata>/.exec(svg)![1]!) as {
        capabilities: { surface: string; send: string; runtime: string; images: string };
      };
      const summarize = (control: "send" | "runtime" | "images") => {
        const cell = caps.controls[control];
        return cell.state === "disabled" ? `disabled:${cell.reason}` : cell.state;
      };
      expect({ still: spec.name, ...meta.capabilities }).toEqual({
        still: spec.name,
        surface: caps.surface,
        send: summarize("send"),
        runtime: summarize("runtime"),
        images: summarize("images"),
      });
      // The visible drawing agrees with the matrix — a pill may be depicted
      // exactly when the runtime control is enabled for this surface.
      expect({ still: spec.name, pillDrawn: svg.includes(PILL_FACE) })
        .toEqual({ still: spec.name, pillDrawn: caps.controls.runtime.state === "enabled" });
      // A disabled-with-reason images cell renders its localized reason line.
      if (caps.controls.images.state === "disabled") {
        expect(svg).toContain(xmlEscape(translate(spec.lang, caps.controls.images.reason)).slice(0, 24));
      }
      // A disabled-with-reason send cell renders its localized reason line.
      if (caps.controls.send.state === "disabled") {
        expect(svg).toContain(xmlEscape(translate(spec.lang, caps.controls.send.reason)).slice(0, 24));
      }
    }
  }
});

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/* ------------------------------------------------------------------ *
 * 4. Dead frames carry the truthful copy, in their locale              *
 * ------------------------------------------------------------------ */

test("dead-recovery frames render the truthful banner copy and all three recovery controls in their locale", () => {
  const deadStills = STILLS.filter((spec) => spec.state === "dead-recovery");
  // EN and UK, at both the tall and the keyboard-open mobile heights.
  expect(deadStills.map((spec) => `${spec.lang}:${manifest.captures[spec.capture]!.viewport.height}`).sort())
    .toEqual(["en:600", "en:844", "uk:600", "uk:844"]);
  for (const spec of deadStills) {
    const svg = readFileSync(join(DIR, spec.name), "utf8");
    for (const key of ["deadHost.respawn", "deadHost.attach", "deadHost.recheck"] as MessageKey[]) {
      expect(svg).toContain(xmlEscape(translate(spec.lang, key)));
    }
    // The truthful body reaches the frame (word-wrapped, so check the head).
    expect(svg).toContain(xmlEscape(translate(spec.lang, "deadHost.body")).split(" ").slice(0, 3).join(" "));
    // The retired false claim must be gone from committed evidence.
    expect(svg).not.toContain("can't be delivered");
    expect(svg).not.toContain("не доставляються");
  }
});
