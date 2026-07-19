import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { deflateSync } from "node:zlib";

type Placeholder = {
  description: string;
  height: number;
  path: string;
  width: number;
};

const placeholders: Placeholder[] = [
  { path: "docs/issue-177/after-bottom.png", width: 780, height: 1688, description: "Redacted placeholder for the post-change mobile bottom layout evidence." },
  { path: "docs/issue-177/after-card-header.png", width: 780, height: 1688, description: "Redacted placeholder for the post-change mobile card-header evidence." },
  { path: "docs/issue-177/after-composer.png", width: 780, height: 1688, description: "Redacted placeholder for the post-change mobile composer evidence." },
  { path: "docs/issue-177/after-toggle-list.png", width: 780, height: 1688, description: "Redacted placeholder for the post-change mobile toggle-list evidence." },
  { path: "docs/issue-177/before-bottom.png", width: 780, height: 1688, description: "Redacted placeholder for the pre-change mobile bottom layout evidence." },
  { path: "docs/issue-177/before-card-header.png", width: 780, height: 1688, description: "Redacted placeholder for the pre-change mobile card-header evidence." },
  { path: "docs/issue-177/before-composer.png", width: 780, height: 1688, description: "Redacted placeholder for the pre-change mobile composer evidence." },
  { path: "docs/issue-177/before-toggle-list.png", width: 780, height: 1688, description: "Redacted placeholder for the pre-change mobile toggle-list evidence." },
  { path: "docs/acceptance/issue-388/desktop-en.png", width: 1440, height: 1000, description: "Redacted placeholder retaining the desktop English acceptance viewport." },
  { path: "docs/acceptance/issue-388/desktop-uk-preflight.png", width: 1440, height: 1000, description: "Redacted placeholder retaining the desktop Ukrainian preflight acceptance viewport." },
  { path: "docs/acceptance/issue-388/desktop-uk.png", width: 1440, height: 1000, description: "Redacted placeholder retaining the desktop Ukrainian acceptance viewport." },
  { path: "docs/acceptance/issue-388/mobile-390-en.png", width: 390, height: 844, description: "Redacted placeholder retaining the 390-pixel English acceptance viewport." },
  { path: "docs/acceptance/issue-388/mobile-390-uk.png", width: 390, height: 844, description: "Redacted placeholder retaining the 390-pixel Ukrainian acceptance viewport." },
  { path: "docs/screenshots/issue-196/template-draft-desktop-1440.png", width: 1440, height: 900, description: "Redacted placeholder for the desktop template-draft evidence." },
  { path: "docs/screenshots/issue-196/template-draft-mobile-390.png", width: 390, height: 844, description: "Redacted placeholder for the mobile template-draft evidence." },
  { path: "docs/screenshots/issue-136/builder-desktop-1440.png", width: 1440, height: 900, description: "Redacted placeholder for the desktop builder evidence." },
  { path: "docs/screenshots/issue-136/builder-mobile-390.png", width: 390, height: 300, description: "Redacted placeholder for the mobile builder evidence." },
  { path: "docs/screenshots/mobile-tail-148-156/01-mobile-pipeline-full-plan.png", width: 780, height: 1688, description: "Redacted placeholder for the full mobile pipeline plan evidence." },
  { path: "docs/screenshots/mobile-tail-148-156/02-mobile-drawer-header.png", width: 780, height: 1688, description: "Redacted placeholder for the mobile drawer-header evidence." },
  { path: "docs/screenshots/mobile-tail-148-156/03-mobile-accounts-sheet.png", width: 780, height: 1688, description: "Redacted placeholder for the mobile accounts-sheet evidence." },
  { path: "docs/screenshots/mobile-tail-148-156/04-drawer-header-before.png", width: 494, height: 114, description: "Redacted placeholder for the pre-change drawer-header crop." },
  { path: "docs/screenshots/mobile-tail-148-156/05-drawer-header-after.png", width: 494, height: 114, description: "Redacted placeholder for the post-change drawer-header crop." },
  { path: "docs/screenshots/mobile-tail-148-156/06-drawer-header-99plus-capped.png", width: 780, height: 1688, description: "Redacted placeholder for the capped drawer-header count evidence." },
  { path: "docs/acceptance/issue-290/readiness-kanban.png", width: 1180, height: 720, description: "Redacted placeholder retaining the readiness Kanban acceptance viewport." },
  { path: "docs/media/issue-145/after-create-menu.png", width: 780, height: 1688, description: "Redacted placeholder for the post-change mobile create-menu evidence." },
  { path: "docs/media/issue-145/after-desktop-unchanged.png", width: 1280, height: 800, description: "Redacted placeholder for the unchanged desktop comparison evidence." },
  { path: "docs/media/issue-145/after-drawer.png", width: 780, height: 1688, description: "Redacted placeholder for the post-change mobile drawer evidence." },
  { path: "docs/media/issue-145/after-more-menu.png", width: 780, height: 1688, description: "Redacted placeholder for the post-change mobile overflow-menu evidence." },
  { path: "docs/media/issue-145/after-scheme.png", width: 780, height: 1688, description: "Redacted placeholder for the post-change mobile scheme evidence." },
  { path: "docs/media/issue-145/before-scheme.png", width: 780, height: 1688, description: "Redacted placeholder for the pre-change mobile scheme evidence." },
  { path: "docs/media/issue-155-slice2/before-1440.png", width: 2880, height: 1800, description: "Redacted placeholder retaining the desktop pre-change viewport." },
  { path: "docs/media/issue-292/relation-navigate-desktop.png", width: 2880, height: 1800, description: "Redacted placeholder for the desktop relation-navigation evidence." },
  { path: "docs/media/issue-292/relation-strip-desktop-uk.png", width: 2880, height: 1800, description: "Redacted placeholder for the Ukrainian desktop relation-strip evidence." },
  { path: "docs/media/issue-292/relation-strip-desktop.png", width: 2880, height: 1800, description: "Redacted placeholder for the desktop relation-strip evidence." },
  { path: "docs/media/issue-292/task-card-expanded-desktop.png", width: 2880, height: 1800, description: "Redacted placeholder for the expanded desktop task-card evidence." },
  { path: "docs/media/issue-353/edges-desktop.png", width: 1920, height: 1080, description: "Redacted placeholder for the desktop pipeline-edge evidence." },
  { path: "docs/media/issue-353/edges-onestage-desktop.png", width: 1920, height: 1080, description: "Redacted placeholder for the single-stage desktop edge evidence." },
];

const root = resolve(import.meta.dir, "..");
const generatorPath = resolve(import.meta.path);

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function placeholderPng({ height, path, width }: Placeholder): Buffer {
  const stride = width * 3 + 1;
  const pixels = Buffer.alloc(stride * height);
  const fill = (x: number, y: number, rectangleWidth: number, rectangleHeight: number, color: Buffer) => {
    const left = Math.max(0, Math.min(width, Math.round(x)));
    const right = Math.max(left, Math.min(width, Math.round(x + rectangleWidth)));
    const top = Math.max(0, Math.min(height, Math.round(y)));
    const bottom = Math.max(top, Math.min(height, Math.round(y + rectangleHeight)));
    for (let row = top; row < bottom; row += 1) {
      pixels.fill(color, row * stride + 1 + left * 3, row * stride + 1 + right * 3);
    }
  };
  const background = Buffer.from([244, 247, 250]);
  for (let row = 0; row < height; row += 1) pixels.fill(background, row * stride + 1, (row + 1) * stride);
  const variant = createHash("sha256").update(path).digest()[0];
  const headerHeight = Math.max(18, Math.round(height * 0.07));
  const railWidth = width >= 700 ? Math.round(width * 0.22) : 0;
  fill(0, 0, width, headerHeight, Buffer.from([22, 34, 58]));
  if (railWidth > 0) fill(0, headerHeight, railWidth, height - headerHeight, Buffer.from([225, 231, 239]));
  const contentLeft = railWidth + Math.round(width * 0.04);
  const contentWidth = width - contentLeft - Math.round(width * 0.04);
  const cardGap = Math.max(8, Math.round(height * 0.018));
  const cardHeight = Math.max(24, Math.round((height - headerHeight - cardGap * 5) / 4));
  for (let index = 0; index < 4; index += 1) {
    const y = headerHeight + cardGap + index * (cardHeight + cardGap);
    fill(contentLeft, y, contentWidth, cardHeight, Buffer.from([209, 216, 226]));
    fill(contentLeft + 2, y + 2, contentWidth - 4, cardHeight - 4, Buffer.from([255, 255, 255]));
    const barWidth = contentWidth * (0.32 + ((variant + index * 17) % 42) / 100);
    fill(contentLeft + contentWidth * 0.07, y + cardHeight * 0.28, barWidth, Math.max(4, cardHeight * 0.1), Buffer.from([121, 133, 151]));
    fill(contentLeft + contentWidth * 0.07, y + cardHeight * 0.52, contentWidth * 0.58, Math.max(4, cardHeight * 0.08), Buffer.from([185, 194, 207]));
  }
  fill(contentLeft + contentWidth * 0.18, headerHeight + (height - headerHeight) * 0.38, contentWidth * 0.64, Math.max(18, height * 0.12), Buffer.from([35, 42, 54]));
  fill(contentLeft + contentWidth * 0.24, headerHeight + (height - headerHeight) * 0.425, contentWidth * 0.52, Math.max(5, height * 0.025), Buffer.from([245, 158, 11]));

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("tEXt", Buffer.from("capture-source\0redacted-placeholder", "latin1")),
    chunk("tEXt", Buffer.from("privacy-classification\0redacted-placeholder", "latin1")),
    chunk("tEXt", Buffer.from("generator\0scripts/generate-privacy-placeholders.ts", "latin1")),
    chunk("IDAT", deflateSync(pixels, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const manifests = new Map<string, Array<Record<string, string>>>();
for (const placeholder of placeholders) {
  const output = resolve(root, placeholder.path);
  const directory = dirname(output);
  mkdirSync(directory, { recursive: true });
  const contents = placeholderPng(placeholder);
  writeFileSync(output, contents);
  const assets = manifests.get(directory) ?? [];
  assets.push({
    path: output.slice(directory.length + 1),
    classification: "redacted-placeholder",
    source: "redacted-live-capture",
    generator: relative(directory, generatorPath),
    description: placeholder.description,
    sha256: createHash("sha256").update(contents).digest("hex"),
  });
  manifests.set(directory, assets);
}

for (const [directory, assets] of manifests) {
  writeFileSync(resolve(directory, "privacy-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    policy: "synthetic-and-redacted-media-only",
    assets,
  }, null, 2)}\n`);
}

process.stdout.write(`Generated ${placeholders.length} deterministic redacted placeholders with provenance.\n`);
