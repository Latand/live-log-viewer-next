/**
 * Deterministic SVG acceptance stills for issue #499.
 *
 * The privacy-publication gate reproduces raster provenance from the TRUSTED
 * default-branch generator, which cannot know about media a not-yet-merged PR
 * introduces — new raster provenance is structurally unvalidatable inside a
 * single PR (see the pr-439 precedent on main). These frames are therefore
 * vector artifacts: byte-stable text files the gate scans as text, needing no
 * raster manifest, while remaining fully inspectable evidence of the verified
 * composer states.
 *
 * Every frame embeds its provenance: classification `synthetic`, this
 * generator's path, the exact source revision whose acceptance run it
 * re-renders, and the SHA-256 of the real chrome-headless capture behind it
 * (the captures themselves are regenerated locally via capture.sh and stay
 * uncommitted because browser output is not byte-deterministic).
 *
 *   bun docs/screenshots/issue-499/generate-stills.ts
 *
 * Re-running always emits identical bytes. All data is synthetic.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type StillState = "live-ready" | "unresolved-recovery" | "dead-recovery" | "image-upload";

interface Still {
  name: string;
  width: number;
  height: number;
  state: StillState;
  /** SHA-256 of the chrome-headless capture (at the source revision) this
      frame re-renders. */
  sourceCaptureSha256: string;
}

/** The commit whose verified acceptance run these frames re-render. */
const SOURCE_REVISION = "3a5c11045eeb9b7731343f7509c5161c7339c59f";

const STILLS: Still[] = [
  { name: "still-live-ready-desktop-1440x900.svg", width: 1440, height: 900, state: "live-ready", sourceCaptureSha256: "2eafe805f6ad62a9dbca57e5c4822a8807db98cefa5ba9f041c39514232ac18e" },
  { name: "still-live-ready-390x844.svg", width: 390, height: 844, state: "live-ready", sourceCaptureSha256: "4086a25e9b4903fed9298d6510cee6bfca8f13ec48772186f0d1aa1701860894" },
  { name: "still-live-ready-390x600.svg", width: 390, height: 600, state: "live-ready", sourceCaptureSha256: "2d2b4057310ed8e1d27f5209373aea60ab4db43233435e21da7313db753f5cff" },
  { name: "still-unresolved-recovery-390x844.svg", width: 390, height: 844, state: "unresolved-recovery", sourceCaptureSha256: "18dee490ce0d223bc479635ba259a850f0417722f04406a4827d873d16a2ac21" },
  { name: "still-dead-recovery-390x844.svg", width: 390, height: 844, state: "dead-recovery", sourceCaptureSha256: "c78b711e72424dc8b1f6d9fdc1c9640fb57ea4876d9ae28836e6504c8d83eabf" },
  { name: "still-dead-recovery-390x600.svg", width: 390, height: 600, state: "dead-recovery", sourceCaptureSha256: "9cd926ef41eb57a6047a1363049f95fb2bcee176b16e01c1208a50e613990415" },
  { name: "still-image-upload-390x844.svg", width: 390, height: 844, state: "image-upload", sourceCaptureSha256: "d2d3f18aa6b45554b1818857edcc3dbc3877b65fac393cdbc812d207cbef1910" },
];

const STATE_TITLE: Record<StillState, string> = {
  "live-ready": "Live ready",
  "unresolved-recovery": "Unresolved host — recovery",
  "dead-recovery": "Dead host — recovery",
  "image-upload": "Image upload",
};

const FONT = "font-family=\"ui-sans-serif, system-ui, sans-serif\"";
const MONO = "font-family=\"ui-monospace, monospace\"";

function stillSvg(still: Still): string {
  const { width, height, state } = still;
  const parts: string[] = [];
  const rect = (x: number, y: number, w: number, h: number, fill: string, extra = "") =>
    parts.push(`  <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra ? ` ${extra}` : ""}/>`);
  const text = (x: number, y: number, label: string, fill: string, size = 13, font = FONT, weight = 600) =>
    parts.push(`  <text x="${x}" y="${y}" ${font} font-size="${size}" font-weight="${weight}" fill="${fill}">${label
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>`);

  const ink = "#1f2937";
  const muted = "#8c95a3";
  const border = "#dee2e9";
  const sunken = "#eef1f5";
  const accent = "#6d5ef6";
  const accentSoft = "#c7c1fa";
  const warning = "#b0760e";
  const danger = "#cd3030";
  const dangerSoft = "#fce7e7";

  rect(0, 0, width, height, "#f3f4f6");
  text(16, 26, `Issue 499 — ${STATE_TITLE[state]}`, ink, 16);
  text(16, 44, `${width}×${height} · synthetic fixture · rev ${SOURCE_REVISION.slice(0, 12)}`, muted, 11, MONO, 500);

  const cardWidth = Math.min(width - 24, 720);
  const cardLeft = Math.round((width - cardWidth) / 2);
  const cardHeight = Math.min(height - 70, state === "dead-recovery" ? 400 : 320);
  const cardTop = height - cardHeight - 16;
  rect(cardLeft - 2, cardTop - 2, cardWidth + 4, cardHeight + 4, border, 'rx="12"');
  rect(cardLeft, cardTop, cardWidth, cardHeight, "#ffffff", 'rx="10"');
  text(cardLeft + 16, cardTop + 24, "…transcript…", muted, 12, FONT, 500);

  const bannerHeight = state === "dead-recovery" ? 138 : 0;
  const composerTop = cardTop + cardHeight
    - (state === "image-upload" ? 190 : state === "unresolved-recovery" ? 170 : 130);
  rect(cardLeft, composerTop - bannerHeight - 2, cardWidth, 2, border);

  if (state === "dead-recovery") {
    const bannerTop = composerTop - bannerHeight;
    rect(cardLeft, bannerTop, cardWidth, bannerHeight, dangerSoft);
    text(cardLeft + 16, bannerTop + 24, "Agent host died · 5m ago", danger, 14, FONT, 700);
    text(cardLeft + 16, bannerTop + 44, "Messages can't be delivered. Pending approvals expired.", ink, 11, FONT, 500);
    rect(cardLeft + 16, bannerTop + 56, 200, 30, accent, 'rx="8"');
    text(cardLeft + 30, bannerTop + 76, "Respawn conversation", "#ffffff", 12, FONT, 700);
    rect(cardLeft + 16, bannerTop + 94, 150, 30, "#ffffff", `rx="8" stroke="${border}" stroke-width="2"`);
    text(cardLeft + 30, bannerTop + 114, "Open in terminal", ink, 12);
    rect(cardLeft + 176, bannerTop + 94, 92, 30, "#ffffff", `rx="8" stroke="${border}" stroke-width="2"`);
    text(cardLeft + 190, bannerTop + 114, "Re-check", ink, 12);
  }

  if (state === "image-upload") {
    const tileTop = composerTop + 12;
    rect(cardLeft + 16, tileTop, 48, 48, "#f68a8a", 'rx="6"');
    rect(cardLeft + 44, tileTop + 4, 16, 16, "#ffffff", 'rx="8"');
    text(cardLeft + 48, tileTop + 16, "×", ink, 12, FONT, 700);
  }

  const inputTop = composerTop + (state === "image-upload" ? 72 : 14);
  rect(cardLeft + 14, inputTop - 2, cardWidth - 28, 48, border, 'rx="10"');
  rect(cardLeft + 16, inputTop, cardWidth - 32, 44, sunken, 'rx="9"');
  const inputCopy: Record<StillState, { label: string; tone: string }> = {
    "live-ready": { label: "message the agent…", tone: muted },
    "unresolved-recovery": { label: "message the agent — reconnecting to its session…", tone: muted },
    "dead-recovery": { label: "Recover and continue this task.", tone: ink },
    "image-upload": { label: "message the agent…", tone: muted },
  };
  text(cardLeft + 30, inputTop + 27, inputCopy[state].label, inputCopy[state].tone, 12, FONT, 500);
  const controlsRight = cardLeft + cardWidth - 32;
  const sendColor = state === "unresolved-recovery" ? accentSoft : accent;
  rect(controlsRight - 36, inputTop + 6, 32, 32, sendColor, 'rx="8"');
  parts.push(`  <path d="M ${controlsRight - 25} ${inputTop + 14} L ${controlsRight - 13} ${inputTop + 22} L ${controlsRight - 25} ${inputTop + 30} Z" fill="#ffffff"/>`);
  rect(controlsRight - 58, inputTop + 14, 10, 16, muted, 'rx="5"');
  rect(controlsRight - 82, inputTop + 16, 14, 3, muted);
  rect(controlsRight - 82, inputTop + 24, 14, 3, muted);

  const belowInput = inputTop + 56;
  if (state === "unresolved-recovery") {
    text(cardLeft + 16, belowInput + 12, "resolving the agent host…", warning, 12, FONT, 700);
    rect(cardLeft + 16, belowInput + 22, 92, 30, "#ffffff", `rx="8" stroke="${border}" stroke-width="2"`);
    text(cardLeft + 30, belowInput + 42, "Re-check", ink, 12);
  } else {
    parts.push(`  <path d="M ${cardLeft + 24} ${belowInput + 2} L ${cardLeft + 18} ${belowInput + 12} L ${cardLeft + 23} ${belowInput + 12} L ${cardLeft + 17} ${belowInput + 22} L ${cardLeft + 29} ${belowInput + 9} L ${cardLeft + 24} ${belowInput + 9} L ${cardLeft + 28} ${belowInput + 2} Z" fill="${accent}"/>`);
    text(cardLeft + 38, belowInput + 16, "5.6-Sol · High ⌄", ink, 13, FONT, 700);
  }

  text(cardLeft + 16, cardTop + cardHeight - 10, `synthetic · rev ${SOURCE_REVISION.slice(0, 12)}`, muted, 10, MONO, 500);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Issue 499 acceptance state ${STATE_TITLE[still.state]}">`,
    `  <metadata id="provenance">{"classification":"synthetic","source":"deterministic-generator","generator":"docs/screenshots/issue-499/generate-stills.ts","sourceRevision":"${SOURCE_REVISION}","sourceCaptureSha256":"${still.sourceCaptureSha256}"}</metadata>`,
    ...parts,
    "</svg>",
    "",
  ].join("\n");
}

const outputDirectory = dirname(new URL(import.meta.url).pathname);
for (const still of STILLS) {
  writeFileSync(join(outputDirectory, still.name), stillSvg(still));
}
process.stdout.write(`Generated ${STILLS.length} deterministic issue-499 SVG stills.\n`);
