import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

export const PRIVACY_GENERATOR_RUNTIME = "1.3.3";
export const PRIVACY_GENERATOR_VERSION = "issue-626-vector-stills-v1";

export interface GeometryEvidence {
  width: number;
  scrollWidth: number;
  feedHeight: number;
  composerHeight: number;
  order: string[];
  liveItems: number;
  toolRows: number;
  toolOutputVisible: boolean;
  launchId: string;
  conversationId: string;
  path: string;
  filesRevision: string;
}

interface ManifestAsset {
  path: string;
  classification: "synthetic";
  source: "deterministic-generator";
  generator: string;
  generatorRuntime: string;
  generatorVersion: string;
  generatorSha256: string;
  sourceDigests: string[];
  description: string;
  sha256: string;
}

export interface EvidenceManifest {
  schemaVersion: 2;
  policy: "synthetic-and-redacted-media-only";
  assets: ManifestAsset[];
}

const SOURCE_DIGESTS: Record<string, string> = {
  "partial-adoption-desktop-1280": "ea0bda315a949dec303a0cdfb90042980330d6cd5a16830fe30601422bda90d8",
  "partial-adoption-mobile-390": "1d66e797a1c88f07da703e24a502baaa652640747c3b3e43538e5557a49c50ba",
  "refresh-after-adoption-desktop-1280": "2a0fa0d0d55a0ea0c9bde5776fb5bc74f31600119216d4f9b684e76cfa2af72b",
  "refresh-after-adoption-mobile-390": "ed9b3d4670e66d8ba33d96072e3c6f096dd1473c8a97da17c4ad13f7879fe228",
  "refresh-at-tool-transition-desktop-1280": "69c92ef1b13b133147b040929369efafdf51175ab2c1742dd513c9049c2a32a7",
  "refresh-at-tool-transition-mobile-390": "2fc2ca17ebdd9afccb4b6b1176f607121f119e8b1d7aa34dba329fe38d996e98",
  "streaming-before-tool-desktop-1280": "96929a8c1a6f4d4d116c9265efcb7b3f69e4a6be40d57588fc27a21d79109486",
  "streaming-before-tool-mobile-390": "060b250b5786df729ac2aaed78dba1bc804a46d219cc63d7f4e898fa759d2926",
};

const directory = import.meta.dir;
const generatorPath = import.meta.path;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function rowLabel(kind: string): string {
  if (kind === "outbox") return "queued user prompt";
  if (kind === "user") return "canonical user prompt";
  if (kind === "tool") return "tool call + output";
  if (kind === "live") return "live commentary handoff";
  return "canonical commentary";
}

function stateLabel(key: string): string {
  return key
    .replace(/-(desktop-1280|mobile-390)$/, "")
    .split("-")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

export function renderEvidenceStill(
  key: string,
  evidence: GeometryEvidence,
  sourceDigest: string,
): string {
  const height = evidence.feedHeight + evidence.composerHeight + 81;
  const mobile = evidence.width <= 390;
  const side = mobile ? 16 : Math.round(evidence.width * 0.16);
  const contentWidth = evidence.width - side * 2;
  const rowGap = mobile ? 14 : 18;
  let y = 132;
  const rows = evidence.order.map((kind) => {
    const rightAligned = kind === "outbox" || kind === "user";
    const inset = kind === "tool" ? (mobile ? 34 : 58) : 0;
    const width = kind === "tool"
      ? contentWidth - inset
      : Math.round(contentWidth * (mobile ? 0.82 : 0.64));
    const rowHeight = kind === "tool" ? (mobile ? 108 : 116) : (mobile ? 54 : 60);
    const x = rightAligned ? evidence.width - side - width : side + inset;
    const fill = kind === "tool" ? "#ffffff" : rightAligned ? "#e8e9ef" : "#ffffff";
    const stroke = kind === "live" ? "#7c3aed" : kind === "tool" ? "#d6dae3" : "#e2e5eb";
    const label = rowLabel(kind);
    const output = kind === "tool"
      ? `<text x="${x + 18}" y="${y + 70}" class="mono muted">TOOL_OUTPUT_626 · ${evidence.toolOutputVisible ? "visible" : "pending"}</text>`
      : "";
    const row = [
      `<g data-evidence-row="${escapeXml(kind)}">`,
      `<rect x="${x}" y="${y}" width="${width}" height="${rowHeight}" rx="14" fill="${fill}" stroke="${stroke}" stroke-width="${kind === "live" ? 3 : 1}"/>`,
      `<text x="${x + 18}" y="${y + 33}" class="row">${escapeXml(label)}</text>`,
      output,
      "</g>",
    ].join("");
    y += rowHeight + rowGap;
    return row;
  }).join("");
  const metadata = escapeXml(JSON.stringify({
    classification: "synthetic",
    generator: basename(generatorPath),
    generatorVersion: PRIVACY_GENERATOR_VERSION,
    sourceDigest,
    state: key,
    geometry: evidence,
  }));
  const state = stateLabel(key);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${evidence.width}" height="${height}" viewBox="0 0 ${evidence.width} ${height}">`,
    `<metadata>${metadata}</metadata>`,
    "<style>",
    "text{font-family:Inter,ui-sans-serif,system-ui,sans-serif;fill:#22242b}.title{font-size:16px;font-weight:700}.meta{font-size:11px;fill:#6b7280}.row{font-size:15px}.mono{font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px}.muted{fill:#667085}",
    "</style>",
    `<rect width="${evidence.width}" height="${height}" fill="#f5f6f8"/>`,
    `<rect width="${evidence.width}" height="81" fill="#ffffff"/>`,
    `<line x1="0" y1="80.5" x2="${evidence.width}" y2="80.5" stroke="#dfe2e8"/>`,
    `<text x="16" y="27" class="title">Issue 626 · ${escapeXml(state)}</text>`,
    `<text x="16" y="49" class="meta">${escapeXml(evidence.conversationId)} · ${escapeXml(evidence.launchId)} · ${escapeXml(evidence.filesRevision)}</text>`,
    `<text x="16" y="67" class="mono muted">${escapeXml(evidence.path)}</text>`,
    rows,
    `<rect x="0" y="${height - evidence.composerHeight}" width="${evidence.width}" height="${evidence.composerHeight}" fill="#ffffff"/>`,
    `<line x1="0" y1="${height - evidence.composerHeight + 0.5}" x2="${evidence.width}" y2="${height - evidence.composerHeight + 0.5}" stroke="#dfe2e8"/>`,
    `<rect x="${mobile ? 12 : 16}" y="${height - evidence.composerHeight + 14}" width="${evidence.width - (mobile ? 24 : 32)}" height="${evidence.composerHeight - 28}" rx="12" fill="#ffffff" stroke="#d8dce4"/>`,
    `<text x="${mobile ? 26 : 30}" y="${height - evidence.composerHeight + 47}" class="meta">Message this conversation</text>`,
    "</svg>",
    "",
  ].join("\n");
}

export function buildEvidenceArtifacts(): {
  manifest: EvidenceManifest;
  stills: Map<string, string>;
} {
  const geometry = JSON.parse(readFileSync(join(directory, "geometry.json"), "utf8")) as Record<string, GeometryEvidence>;
  const generatorSha256 = sha256(readFileSync(generatorPath));
  const stills = new Map<string, string>();
  const assets = Object.entries(geometry).map(([key, evidence]) => {
    const sourceDigest = SOURCE_DIGESTS[key];
    if (!sourceDigest) throw new Error(`Missing source digest for ${key}`);
    const path = `${key}.svg`;
    const contents = renderEvidenceStill(key, evidence, sourceDigest);
    stills.set(path, contents);
    return {
      path,
      classification: "synthetic" as const,
      source: "deterministic-generator" as const,
      generator: relative(directory, generatorPath),
      generatorRuntime: `bun-${PRIVACY_GENERATOR_RUNTIME}`,
      generatorVersion: PRIVACY_GENERATOR_VERSION,
      generatorSha256,
      sourceDigests: [sourceDigest],
      description: `Deterministic vector evidence for ${stateLabel(key)}.`,
      sha256: sha256(contents),
    };
  });
  return {
    manifest: {
      schemaVersion: 2,
      policy: "synthetic-and-redacted-media-only",
      assets,
    },
    stills,
  };
}

if (import.meta.main) {
  if (Bun.version !== PRIVACY_GENERATOR_RUNTIME) {
    throw new Error("Issue 626 evidence generation requires the pinned Bun runtime");
  }
  const { manifest, stills } = buildEvidenceArtifacts();
  for (const [path, contents] of stills) writeFileSync(join(directory, path), contents);
  writeFileSync(join(directory, "privacy-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`Generated ${stills.size} deterministic issue-626 SVG stills.\n`);
}
