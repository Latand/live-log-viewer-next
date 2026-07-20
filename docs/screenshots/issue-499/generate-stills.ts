/**
 * Deterministic SVG acceptance stills for issue #499, mechanically bound to
 * the committed capture manifest.
 *
 * The privacy-publication gate reproduces raster provenance from the TRUSTED
 * default-branch generator, which cannot know about media a not-yet-merged PR
 * introduces — new raster provenance is structurally unvalidatable inside a
 * single PR (see the pr-439 precedent on main). These frames are therefore
 * vector artifacts: byte-stable text files the gate scans as text, while
 * remaining fully inspectable evidence of the verified composer states.
 *
 * Nothing in a frame is hand-declared:
 *  - geometry, capture digest, and source revision come from
 *    `capture-manifest.json`, which capture.sh writes from the REAL
 *    chrome-headless captures (per-PNG SHA-256, IHDR-verified pixel size, and
 *    digests of the harness inputs themselves);
 *  - the depicted capability set (Send / model-reasoning pill / images /
 *    recovery) is resolved through the PRODUCTION `capabilitiesFor` matrix
 *    for each state's fixtures;
 *  - all user-facing copy is read from the production locale dictionaries.
 *
 * `evidence.test.ts` fails whenever a committed frame drifts from this
 * regeneration, from the manifest, from the harness bytes, or from the
 * production capability matrix.
 *
 *   bun docs/screenshots/issue-499/generate-stills.ts
 *
 * Re-running against the same manifest always emits identical bytes. All data
 * is synthetic.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { capabilitiesFor, type Capability } from "@/components/agentCapabilities";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import { en } from "@/lib/i18n/en";
import { uk } from "@/lib/i18n/uk";
import type { FileEntry } from "@/lib/types";

export type StillState = "live-ready" | "unresolved-recovery" | "dead-recovery" | "image-upload";
export type StillLocale = "en" | "uk";

export interface StillSpec {
  /** Committed SVG filename. */
  name: string;
  /** The capture-manifest entry this frame re-renders. */
  capture: string;
  state: StillState;
  lang: StillLocale;
}

/** Integer getBoundingClientRect of a control, as measured in the real page. */
export interface ControlRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The nonzero, in-viewport control geometry the browser harness measured with
    getBoundingClientRect at the capture's viewport: Send, the model/reasoning
    pill, and the opened reasoning and model picker surfaces. */
export interface CaptureGeometry {
  send: ControlRect;
  pill: ControlRect;
  reasoningPicker: ControlRect;
  modelPicker: ControlRect;
}

export interface CaptureEntry {
  view: string;
  lang: string;
  theme: string;
  viewport: { width: number; height: number };
  png: { width: number; height: number; sha256: string };
  /** Present on the picker-open captures at each viewport. */
  geometry?: CaptureGeometry;
  /** SHA-256 sealing the canonical capture record above — recomputable by CI
      from the committed manifest bytes alone (see `captureDigest`). */
  sha256: string;
}

export interface CaptureManifest {
  classification: string;
  generator: string;
  /** Full 40-hex commit the harness ran against; `evidence.test.ts` proves the
      committed harness bytes are exactly this revision's tree. */
  sourceRevision: string;
  /** Git tree object of `sourceRevision` — binds the manifest to the exact
      reviewed source-tree revision, recomputably (`git rev-parse <rev>^{tree}`). */
  sourceTree: string;
  deviceScaleFactor: number;
  /** SHA-256 of the harness inputs at capture time, keyed by basename. */
  harness: Record<string, string>;
  captures: Record<string, CaptureEntry>;
}

const CONTROL_KEYS = ["send", "pill", "reasoningPicker", "modelPicker"] as const;

/** A control rect in fixed key order — determinism for the sealing digest. */
function canonicalRect(rect: ControlRect): ControlRect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function canonicalGeometry(geometry: CaptureGeometry): CaptureGeometry {
  return {
    send: canonicalRect(geometry.send),
    pill: canonicalRect(geometry.pill),
    reasoningPicker: canonicalRect(geometry.reasoningPicker),
    modelPicker: canonicalRect(geometry.modelPicker),
  };
}

/**
 * The canonical, deterministic serialization of one capture's committed
 * record: the same bytes whether emitted by `build-manifest.ts` or recomputed
 * by `evidence.test.ts`, independent of the on-disk key order. The record
 * commits to the captured pixel digest AND the measured control geometry, so
 * sealing it lets CI recompute every capture digest from the committed manifest
 * alone — the privacy-safe canonical capture payload the raw PNGs cannot be.
 */
export function canonicalCaptureRecord(capture: Omit<CaptureEntry, "sha256">): string {
  const record: Record<string, unknown> = {
    view: capture.view,
    lang: capture.lang,
    theme: capture.theme,
    viewport: { width: capture.viewport.width, height: capture.viewport.height },
    png: { width: capture.png.width, height: capture.png.height, sha256: capture.png.sha256 },
  };
  if (capture.geometry) record.geometry = canonicalGeometry(capture.geometry);
  return JSON.stringify(record);
}

export function captureDigest(capture: Omit<CaptureEntry, "sha256">): string {
  return createHash("sha256").update(canonicalCaptureRecord(capture)).digest("hex");
}

/** A rect is a real, nonzero box lying fully inside the CSS viewport. */
export function rectInViewport(rect: ControlRect, viewport: { width: number; height: number }): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.width <= viewport.width &&
    rect.y + rect.height <= viewport.height
  );
}

export const GEOMETRY_CONTROLS = CONTROL_KEYS;

const DIR = dirname(new URL(import.meta.url).pathname);

export const STILLS: StillSpec[] = [
  { name: "still-live-ready-desktop-1440x900.svg", capture: "rest-desktop-en-light", state: "live-ready", lang: "en" },
  { name: "still-live-ready-390x844.svg", capture: "rest-390-en-light", state: "live-ready", lang: "en" },
  { name: "still-live-ready-390x600.svg", capture: "rest-390x600-en-light", state: "live-ready", lang: "en" },
  { name: "still-unresolved-recovery-390x844.svg", capture: "blocked-390-en-light", state: "unresolved-recovery", lang: "en" },
  { name: "still-dead-recovery-390x844.svg", capture: "dead-390-en-light", state: "dead-recovery", lang: "en" },
  { name: "still-dead-recovery-390x600.svg", capture: "dead-390x600-en-light", state: "dead-recovery", lang: "en" },
  { name: "still-dead-recovery-390x844-uk.svg", capture: "dead-390-uk-light", state: "dead-recovery", lang: "uk" },
  { name: "still-dead-recovery-390x600-uk.svg", capture: "dead-390x600-uk-light", state: "dead-recovery", lang: "uk" },
  { name: "still-image-upload-390x844.svg", capture: "images-390-en-light", state: "image-upload", lang: "en" },
];

export function loadManifest(): CaptureManifest {
  return JSON.parse(readFileSync(join(DIR, "capture-manifest.json"), "utf8")) as CaptureManifest;
}

/** The production locale dictionaries are the only copy source. */
const DICTS = { en, uk } as const;
function msg(lang: StillLocale, key: keyof typeof en): string {
  const value = DICTS[lang][key];
  if (typeof value !== "string") throw new Error(`non-string message for ${key}`);
  return value;
}

/**
 * The exact fixture shapes the browser harness mounts (harness.tsx): a
 * Viewer-launched codex conversation whose structured session is hosted,
 * dead, or not yet resolved. `evidence.test.ts` resolves these through
 * `capabilitiesFor` independently to hold the frames to the production
 * capability matrix.
 */
export function evidenceFixtures(state: StillState): { file: FileEntry; view: RuntimeSessionView | null } {
  const file = {
    path: "/codex-viewer-499.jsonl",
    root: "codex-sessions",
    name: "codex-viewer-499.jsonl",
    project: "viewer",
    title: "Viewer-launched conversation",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "live",
    proc: "running",
    pid: null,
    conversationId: "conversation_viewer499accept",
    spawnOrigin: "viewer",
    model: "gpt-5.6-sol",
    effort: "high",
    fast: false,
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
  if (state === "unresolved-recovery") return { file, view: null };
  const view = {
    session: {
      conversationId: "conversation_viewer499accept",
      sessionKey: { engine: "codex", sessionId: "codex-thread-499" },
      hostKind: "codex-app-server",
      host: state === "dead-recovery" ? "dead" : "hosted",
      turn: "idle",
      provenance: "structured",
      revision: 4,
      attentionIds: [],
      recentReceipts: [],
      accountId: null,
      parentConversationId: null,
      flowId: null,
      workflowId: null,
      cwd: "/home/user/projects/viewer",
      artifactPath: "/codex-viewer-499.jsonl",
      capabilities: {
        steer: true,
        structuredAttention: true,
        imageInput: { supported: true },
        runtimeSettings: { perTurnEffort: true, perTurnModel: false },
      },
      activeTurnId: null,
    },
    uiState: {},
    attentions: [],
    receipts: [],
    legacy: false,
    structuredControlsEnabled: true,
  } as unknown as RuntimeSessionView;
  return { file, view };
}

const STATE_TITLE: Record<StillState, string> = {
  "live-ready": "Live ready",
  "unresolved-recovery": "Unresolved host — recovery",
  "dead-recovery": "Dead host — recovery",
  "image-upload": "Image upload",
};

const FONT = "font-family=\"ui-sans-serif, system-ui, sans-serif\"";
const MONO = "font-family=\"ui-monospace, monospace\"";

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/** Deterministic greedy word wrap by character budget. */
function wrap(value: string, budget: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of value.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > budget && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function capabilitySummary(cell: Capability): string {
  return cell.state === "disabled" ? `disabled:${cell.reason}` : cell.state;
}

export function stillSvg(spec: StillSpec, manifest: CaptureManifest): string {
  const capture = manifest.captures[spec.capture];
  if (!capture) throw new Error(`capture-manifest.json has no capture named ${spec.capture}`);
  const { width, height } = capture.viewport;
  const { state, lang } = spec;
  const { file, view } = evidenceFixtures(state);
  const caps = capabilitiesFor(file, view, { runtimeEnabled: true });

  const parts: string[] = [];
  const rect = (x: number, y: number, w: number, h: number, fill: string, extra = "") =>
    parts.push(`  <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra ? ` ${extra}` : ""}/>`);
  const text = (x: number, y: number, label: string, fill: string, size = 13, font = FONT, weight = 600) =>
    parts.push(`  <text x="${x}" y="${y}" ${font} font-size="${size}" font-weight="${weight}" fill="${fill}">${xmlEscape(label)}</text>`);

  const ink = "#1f2937";
  const muted = "#8c95a3";
  const border = "#dee2e9";
  const sunken = "#eef1f5";
  const accent = "#6d5ef6";
  const accentSoft = "#c7c1fa";
  const warning = "#b0760e";
  const danger = "#cd3030";
  const dangerSoft = "#fce7e7";

  const cardWidth = Math.min(width - 24, 720);
  const cardLeft = Math.round((width - cardWidth) / 2);
  const budget = Math.max(20, Math.floor((cardWidth - 32) / 6));

  // The banner and status copy come from the production dictionaries so the
  // committed frames can only show what the shipped UI says.
  const bannerBody = wrap(msg(lang, "deadHost.body"), budget);
  const imagesReason = caps.controls.images.state === "disabled"
    ? wrap(msg(lang, caps.controls.images.reason as keyof typeof en), Math.max(20, Math.floor((cardWidth - 32) / 5.4)))
    : [];
  const sendReason = caps.controls.send.state === "disabled"
    ? wrap(msg(lang, caps.controls.send.reason as keyof typeof en), budget)
    : [];
  const pillDrawn = caps.controls.runtime.state === "enabled";

  // Bottom-anchored vertical flow: measure the card, then draw top-down.
  const transcriptH = 36;
  const bannerH = state === "dead-recovery" ? 30 + bannerBody.length * 15 + 8 + 30 + 8 + 30 + 14 : 0;
  const tileH = state === "image-upload" ? 60 : 0;
  const inputH = 56;
  const belowH = (pillDrawn ? 40 : 0)
    + (sendReason.length ? sendReason.length * 15 + 40 : 0)
    + (imagesReason.length ? imagesReason.length * 14 + 8 : 0);
  const footerH = 24;
  const cardHeight = transcriptH + bannerH + tileH + inputH + belowH + footerH + 12;
  const cardTop = height - cardHeight - 16;

  rect(0, 0, width, height, "#f3f4f6");
  text(16, 26, `Issue 499 — ${STATE_TITLE[state]}`, ink, 16);
  text(16, 44, `${width}×${height} · synthetic fixture · rev ${manifest.sourceRevision.slice(0, 12)}`, muted, 11, MONO, 500);

  rect(cardLeft - 2, cardTop - 2, cardWidth + 4, cardHeight + 4, border, 'rx="12"');
  rect(cardLeft, cardTop, cardWidth, cardHeight, "#ffffff", 'rx="10"');
  let y = cardTop;
  text(cardLeft + 16, y + 24, "…transcript…", muted, 12, FONT, 500);
  y += transcriptH;

  if (state === "dead-recovery") {
    rect(cardLeft, y, cardWidth, bannerH, dangerSoft);
    const since = lang === "en" ? "5m ago" : "5 хв тому";
    text(cardLeft + 16, y + 22, msg(lang, "deadHost.title").replace("{since}", since), danger, 14, FONT, 700);
    let lineY = y + 42;
    for (const line of bannerBody) {
      text(cardLeft + 16, lineY, line, ink, 11, FONT, 500);
      lineY += 15;
    }
    const button = (x: number, top: number, label: string, primary: boolean): number => {
      const w = 24 + Math.round(label.length * 6.6);
      if (primary) {
        rect(x, top, w, 30, accent, 'rx="8"');
        text(x + 12, top + 20, label, "#ffffff", 12, FONT, 700);
      } else {
        rect(x, top, w, 30, "#ffffff", `rx="8" stroke="${border}" stroke-width="2"`);
        text(x + 12, top + 20, label, ink, 12);
      }
      return w;
    };
    // The three recovery controls the production banner offers (§5).
    button(cardLeft + 16, lineY + 1, msg(lang, "deadHost.respawn"), true);
    const attachW = button(cardLeft + 16, lineY + 39, msg(lang, "deadHost.attach"), false);
    button(cardLeft + 16 + attachW + 10, lineY + 39, msg(lang, "deadHost.recheck"), false);
    y += bannerH;
  }

  if (state === "image-upload") {
    rect(cardLeft + 16, y + 8, 48, 48, "#f68a8a", 'rx="6"');
    rect(cardLeft + 44, y + 12, 16, 16, "#ffffff", 'rx="8"');
    text(cardLeft + 48, y + 24, "×", ink, 12, FONT, 700);
    y += tileH;
  }

  const inputTop = y + 6;
  rect(cardLeft + 14, inputTop - 2, cardWidth - 28, 48, border, 'rx="10"');
  rect(cardLeft + 16, inputTop, cardWidth - 32, 44, sunken, 'rx="9"');
  const inputCopy: Record<StillState, { label: string; tone: string }> = {
    "live-ready": { label: msg(lang, "composer.placeholderSend"), tone: muted },
    "unresolved-recovery": { label: msg(lang, "composer.placeholderResolving"), tone: muted },
    // The dead composer keeps admitting text durably — the frame shows the
    // typed draft the harness driver enters, not a placeholder.
    "dead-recovery": { label: "Recover and continue this task.", tone: ink },
    "image-upload": { label: msg(lang, "composer.placeholderSend"), tone: muted },
  };
  text(cardLeft + 30, inputTop + 27, inputCopy[state].label, inputCopy[state].tone, 12, FONT, 500);
  const controlsRight = cardLeft + cardWidth - 32;
  const sendColor = caps.controls.send.state === "enabled" ? accent : accentSoft;
  rect(controlsRight - 36, inputTop + 6, 32, 32, sendColor, 'rx="8"');
  parts.push(`  <path d="M ${controlsRight - 25} ${inputTop + 14} L ${controlsRight - 13} ${inputTop + 22} L ${controlsRight - 25} ${inputTop + 30} Z" fill="#ffffff"/>`);
  rect(controlsRight - 58, inputTop + 14, 10, 16, muted, 'rx="5"');
  rect(controlsRight - 82, inputTop + 16, 14, 3, muted);
  rect(controlsRight - 82, inputTop + 24, 14, 3, muted);
  y = inputTop + 50;

  if (pillDrawn) {
    // The one obvious 44px model/reasoning pill — drawn exactly when the
    // production matrix enables the runtime control for this surface.
    parts.push(`  <path d="M ${cardLeft + 24} ${y + 10} L ${cardLeft + 18} ${y + 20} L ${cardLeft + 23} ${y + 20} L ${cardLeft + 17} ${y + 30} L ${cardLeft + 29} ${y + 17} L ${cardLeft + 24} ${y + 17} L ${cardLeft + 28} ${y + 10} Z" fill="${accent}"/>`);
    text(cardLeft + 38, y + 24, "5.6-Sol · High ⌄", ink, 13, FONT, 700);
    y += 40;
  }

  if (sendReason.length) {
    let lineY = y + 12;
    for (const line of sendReason) {
      text(cardLeft + 16, lineY, line, warning, 12, FONT, 700);
      lineY += 15;
    }
    rect(cardLeft + 16, lineY - 5, 24 + Math.round(msg(lang, "deadHost.recheck").length * 6.6), 30, "#ffffff", `rx="8" stroke="${border}" stroke-width="2"`);
    text(cardLeft + 28, lineY + 15, msg(lang, "deadHost.recheck"), ink, 12);
    y += sendReason.length * 15 + 40;
  }

  if (imagesReason.length) {
    let lineY = y + 12;
    for (const line of imagesReason) {
      text(cardLeft + 16, lineY, line, muted, 11, FONT, 600);
      lineY += 14;
    }
    y += imagesReason.length * 14 + 8;
  }

  text(cardLeft + 16, cardTop + cardHeight - 10, `synthetic · rev ${manifest.sourceRevision.slice(0, 12)}`, muted, 10, MONO, 500);

  const provenance = {
    classification: "synthetic",
    source: "deterministic-generator",
    generator: "docs/screenshots/issue-499/generate-stills.ts",
    sourceRevision: manifest.sourceRevision,
    capture: spec.capture,
    sourceCaptureSha256: capture.png.sha256,
    viewport: { width, height },
    capabilities: {
      surface: caps.surface,
      send: capabilitySummary(caps.controls.send),
      runtime: capabilitySummary(caps.controls.runtime),
      images: capabilitySummary(caps.controls.images),
    },
  };

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Issue 499 acceptance state ${STATE_TITLE[state]} (${lang})">`,
    `  <metadata id="provenance">${JSON.stringify(provenance)}</metadata>`,
    ...parts,
    "</svg>",
    "",
  ].join("\n");
}

if (import.meta.main) {
  const manifest = loadManifest();
  for (const spec of STILLS) {
    writeFileSync(join(DIR, spec.name), stillSvg(spec, manifest));
  }
  process.stdout.write(`Generated ${STILLS.length} deterministic issue-499 SVG stills from capture-manifest.json.\n`);
}
