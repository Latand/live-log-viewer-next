import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { deflateSync } from "node:zlib";

type Placeholder = {
  description: string;
  height: number;
  path: string;
  width: number;
};

const PRIVACY_GENERATOR_RUNTIME = "1.3.3";
const PRIVACY_GENERATOR_VERSION = "privacy-placeholders-v2";

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
  { path: "docs/acceptance/pr-441/pr-441-desktop-badges.png", width: 1040, height: 600, description: "Redacted placeholder retaining the desktop subagent badge anchor viewport." },
  { path: "docs/acceptance/pr-441/pr-441-mobile-390.png", width: 390, height: 844, description: "Redacted placeholder retaining the 390-pixel mobile subagent badge viewport." },
];

const sourceDigests: Record<string, string> = {
  "docs/issue-177/after-bottom.png": "f313695f6f53a836cc1068c6b90564d72f9ea34db5c4179f1a7ec2807f4e3715",
  "docs/issue-177/after-card-header.png": "88c9604843d035d49b8cc2c8473e7c928fc5e54c74426b55587de1aa478a1875",
  "docs/issue-177/after-composer.png": "c2abd18fa6b8b89ccab35867d3bdb5ab481c318e538a21e717868df49771176b",
  "docs/issue-177/after-toggle-list.png": "e5c3f858b5e607e70eda2686bf95ebc142e657516252ecdda6b4ed9cdb288e2c",
  "docs/issue-177/before-bottom.png": "2f16aac105f47becc0e281315a901c6ecc9b0a3b980f30a561541c73db9aed31",
  "docs/issue-177/before-card-header.png": "adff93817b822ecb3c399019089085c1facfd36f490aae97e2c288bcb66225ce",
  "docs/issue-177/before-composer.png": "689d51bc772e2b169ee6e6f7c41abfd749a3d15ca847628557cd64b7b791f05d",
  "docs/issue-177/before-toggle-list.png": "ac525a2179a3b5ac985f3d5616b1eed75eac90665360c1670bae86d2dcc6183e",
  "docs/acceptance/issue-388/desktop-en.png": "48feae049382008d409ed92c7ed8f0c2b63d2c4702c593422a33b591ae0b0354",
  "docs/acceptance/issue-388/desktop-uk-preflight.png": "da1a4c5f6ac85201a814ed9198ced35ca6bafe81209b2c5f770ea5207d58427e",
  "docs/acceptance/issue-388/desktop-uk.png": "8a20e0f407b5114f6ddad4c3d6e799bb562d341b9f1f1d4f97e5f1be93854139",
  "docs/acceptance/issue-388/mobile-390-en.png": "90c4d3c7e02c845cb87173d85774adb5526b0bd1f04ac196fa40a85a44c65dfb",
  "docs/acceptance/issue-388/mobile-390-uk.png": "395ddf2f81be9ea3906655b906ef44427f6c8dc776bf0182ff1bd34b9726a47e",
  "docs/screenshots/issue-196/template-draft-desktop-1440.png": "715159ce6078ccb80316962f4a21000a7ee22bc46a77176d98079557a70e10ed",
  "docs/screenshots/issue-196/template-draft-mobile-390.png": "217a32bf18afacc8cb2b1a6286136b55355e15d10026e10fbe7c9a2ab2d9727c",
  "docs/screenshots/issue-136/builder-desktop-1440.png": "073fe5e8d008ecf7484989d482b3fef97930f12c39a6fab3126be40c1a764a2e",
  "docs/screenshots/issue-136/builder-mobile-390.png": "f9236e9d7677c236bad5cc76b98ac8f756c55329664ed5cd8c92216b8a7514a4",
  "docs/screenshots/mobile-tail-148-156/01-mobile-pipeline-full-plan.png": "f439de6c723f5630bc58716d0d738ef201aa0e52f7eb076c8202b637f8d25547",
  "docs/screenshots/mobile-tail-148-156/02-mobile-drawer-header.png": "d2ab35caf766754f20ee9697256e0b0827032868df5d79bdecc1e8f63b317474",
  "docs/screenshots/mobile-tail-148-156/03-mobile-accounts-sheet.png": "1c61facd071e6e0ab64edd0fed47e5bf6a00f5e54363f2819636e5dbe4c7a672",
  "docs/screenshots/mobile-tail-148-156/04-drawer-header-before.png": "3616aceb4f9a5382eeaa285f51723ffb3f1f3291ca634c4f6c6272ff1e39719c",
  "docs/screenshots/mobile-tail-148-156/05-drawer-header-after.png": "1e892c87be05892fe44b9711201e8b732290843b96d896c3b0f9d90b70a57a9a",
  "docs/screenshots/mobile-tail-148-156/06-drawer-header-99plus-capped.png": "0b73a36e716ad2a9a34ac927bbe16fcedd3caf72b824b0d0f19f60ff4a4ac886",
  "docs/acceptance/issue-290/readiness-kanban.png": "4bbee6dd05cd6ea991910ccb602e6eebe97160678a987fcbd82906635e9a4ff5",
  "docs/media/issue-145/after-create-menu.png": "70fd36785d9fe5eaa5ad7a578e504b797d5ea3cf847c0b8f595f4be566eb60ab",
  "docs/media/issue-145/after-desktop-unchanged.png": "94560d1282a1ff288f5c1ea5e9d0686d1f671005e9d3d139897581348feaf79c",
  "docs/media/issue-145/after-drawer.png": "c361ca5e7abcc7e0fb5bfa5177d35fefc0d808f93ef6c8214e12bd3d1557546c",
  "docs/media/issue-145/after-more-menu.png": "c9a419630a062a0fe918084bc7682ae02eba04de4e994cecdacc2c3a3ee6ce3e",
  "docs/media/issue-145/after-scheme.png": "4b36302bc2db9182a331f1e436b3d01e9f3a0b233107069d7e9809672eb32c3f",
  "docs/media/issue-145/before-scheme.png": "ef33aea419f8e0f69303ad1aef162356ce4889e4f4475ec49b1a7366f3eafc31",
  "docs/media/issue-155-slice2/before-1440.png": "a43428d86f66669bd0ef35565c43ff997d41db83b4f684add04bdea542ca2af1",
  "docs/media/issue-292/relation-navigate-desktop.png": "c61162c12b20e4080cabe341b59048a2427337c3215b56ceab6cd8a907cea238",
  "docs/media/issue-292/relation-strip-desktop-uk.png": "284f9627ccbda4e32734d64bf01a8c67814dbad0153d964fba7cc8ca8c0d3122",
  "docs/media/issue-292/relation-strip-desktop.png": "4113df0ba59d4f2a077b9a598b265b5d06faebeabbbca5d34d36d7bb5ebe8c39",
  "docs/media/issue-292/task-card-expanded-desktop.png": "7bed3aeebfd4ece12c12774aee3dda4c4089b77aff4b618ddc92445c570ac478",
  "docs/media/issue-353/edges-desktop.png": "386c9349aa6fc59562ae62ad6a57ba4c13c21422cc81a0f7357681937ea72ae2",
  "docs/media/issue-353/edges-onestage-desktop.png": "eed6170341efdbefe837fefa4d284a8680f8c29122a4a8bee49693659df83944",
  "docs/acceptance/pr-441/pr-441-desktop-badges.png": "1ade5a95002485fc4085c03f28cb931a309c18c264b884db43c5d55dfab10131",
  "docs/acceptance/pr-441/pr-441-mobile-390.png": "c41651872641bc8dcf44e48c2c4a0f183153283e18ffc837db54954146b1038f",
};

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

function placeholderPng({ height, path, width }: Placeholder, sourceDigest: string): Buffer {
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
  const variant = createHash("sha256")
    .update(`${PRIVACY_GENERATOR_VERSION}\0${sourceDigest}\0${path}`)
    .digest()[0];
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

const manifests = new Map<string, Array<Record<string, unknown>>>();
if (Bun.version !== PRIVACY_GENERATOR_RUNTIME) {
  throw new Error("Privacy placeholder generation requires the pinned Bun runtime");
}
const generatorSha256 = createHash("sha256").update(readFileSync(generatorPath)).digest("hex");
for (const placeholder of placeholders) {
  const output = resolve(root, placeholder.path);
  const directory = dirname(output);
  mkdirSync(directory, { recursive: true });
  const sourceDigest = sourceDigests[placeholder.path];
  if (!sourceDigest) throw new Error("Missing source digest for privacy placeholder");
  const contents = placeholderPng(placeholder, sourceDigest);
  writeFileSync(output, contents);
  const assets = manifests.get(directory) ?? [];
  assets.push({
    path: output.slice(directory.length + 1),
    classification: "redacted-placeholder",
    source: "redacted-live-capture",
    generator: relative(directory, generatorPath),
    generatorRuntime: `bun-${PRIVACY_GENERATOR_RUNTIME}`,
    generatorVersion: PRIVACY_GENERATOR_VERSION,
    generatorSha256,
    sourceDigests: [sourceDigest],
    description: placeholder.description,
    sha256: createHash("sha256").update(contents).digest("hex"),
  });
  manifests.set(directory, assets);
}

for (const [directory, assets] of manifests) {
  writeFileSync(resolve(directory, "privacy-manifest.json"), `${JSON.stringify({
    schemaVersion: 2,
    policy: "synthetic-and-redacted-media-only",
    assets,
  }, null, 2)}\n`);
}

process.stdout.write(`Generated ${placeholders.length} deterministic redacted placeholders with provenance.\n`);
