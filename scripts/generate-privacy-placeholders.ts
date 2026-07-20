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
  { path: "docs/issue-440/desktop-1440x1000-0-images.png", width: 1440, height: 1000, description: "Redacted placeholder for the desktop focused-chat state without staged images." },
  { path: "docs/issue-440/desktop-1440x1000-1-image.png", width: 1440, height: 1000, description: "Redacted placeholder for the desktop focused-chat state with one staged image." },
  { path: "docs/issue-440/desktop-1440x1000-multiple-images.png", width: 1440, height: 1000, description: "Redacted placeholder for the desktop focused-chat state with multiple staged images." },
  { path: "docs/issue-440/mobile-390x844-0-images.png", width: 390, height: 844, description: "Redacted placeholder for the 390-pixel focused-chat state without staged images." },
  { path: "docs/issue-440/mobile-390x844-1-image.png", width: 390, height: 844, description: "Redacted placeholder for the 390-pixel focused-chat state with one staged image." },
  { path: "docs/issue-440/mobile-390x844-multiple-images.png", width: 390, height: 844, description: "Redacted placeholder for the 390-pixel focused-chat state with multiple staged images." },
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
  "docs/issue-440/desktop-1440x1000-0-images.png": "0f8a4e25191447a99312f4b3970964c47db29992c962e553c1fcbf471828459f",
  "docs/issue-440/desktop-1440x1000-1-image.png": "0e0e4c8cb127673eeca896ce13f487e44f69379f7995be0a021d588e52ed80ed",
  "docs/issue-440/desktop-1440x1000-multiple-images.png": "afeb53939c2de98ec84b1aef339b406d0200f80a44135a311ea4faa7efb816e4",
  "docs/issue-440/mobile-390x844-0-images.png": "8718ea3f40922a6de8fb4b4f23ff99f48afac9528277a8228ffb1536ce6a2271",
  "docs/issue-440/mobile-390x844-1-image.png": "acab37f4364d4f30747f059e172ed03c1a280038babbc6484ecf072b211a18e6",
  "docs/issue-440/mobile-390x844-multiple-images.png": "fe7c6da0ea52de3acf668287b27615f4481c17d1c5b8eaa8854336c792efedea",
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

/* --------------------------------------------------------------------------
 * Issue #499 synthetic acceptance stills.
 *
 * Deterministic re-renderings of the #499 composer acceptance states, drawn
 * entirely by this generator (classification `synthetic`, source
 * `deterministic-generator`) so the committed evidence is reproducible and
 * inspectable. Each still names its state, carries the exact source revision
 * in pixels AND in PNG metadata, and binds the SHA-256 of the real
 * chrome-headless capture it re-renders as its source digest — the captures
 * themselves stay uncommitted (browser output is not byte-deterministic).
 * ------------------------------------------------------------------------ */

type Issue499State = "live-ready" | "unresolved-recovery" | "dead-recovery" | "image-upload";

type Issue499Still = {
  path: string;
  width: number;
  height: number;
  state: Issue499State;
  description: string;
};

/** The commit whose verified acceptance run these stills re-render. */
const ISSUE_499_SOURCE_REVISION = "3a5c11045eeb9b7731343f7509c5161c7339c59f";

const issue499Stills: Issue499Still[] = [
  { path: "docs/screenshots/issue-499/still-live-ready-desktop-1440x900.png", width: 1440, height: 900, state: "live-ready", description: "Synthetic re-render of the desktop live-ready composer acceptance state for issue 499." },
  { path: "docs/screenshots/issue-499/still-live-ready-390x844.png", width: 390, height: 844, state: "live-ready", description: "Synthetic re-render of the 390x844 live-ready composer state with the always-visible runtime pill." },
  { path: "docs/screenshots/issue-499/still-live-ready-390x600.png", width: 390, height: 600, state: "live-ready", description: "Synthetic re-render of the 390x600 live-ready composer state at the keyboard-open height class." },
  { path: "docs/screenshots/issue-499/still-unresolved-recovery-390x844.png", width: 390, height: 844, state: "unresolved-recovery", description: "Synthetic re-render of the unresolved-host state: inline resolving reason, Re-check recovery, no launch affordance." },
  { path: "docs/screenshots/issue-499/still-dead-recovery-390x844.png", width: 390, height: 844, state: "dead-recovery", description: "Synthetic re-render of the dead-host recovery state: banner actions with the composer still admitting text." },
  { path: "docs/screenshots/issue-499/still-dead-recovery-390x600.png", width: 390, height: 600, state: "dead-recovery", description: "Synthetic re-render of the 390x600 dead-host recovery state proving the short-viewport reachability." },
  { path: "docs/screenshots/issue-499/still-image-upload-390x844.png", width: 390, height: 844, state: "image-upload", description: "Synthetic re-render of the image-upload state: staged tile in the bounded tray with Send enabled." },
];

/** SHA-256 of the real chrome-headless captures (at the source revision) each
    still re-renders. Kept as source digests so provenance names the exact
    verified frames without committing non-deterministic browser bytes. */
const issue499SourceDigests: Record<string, string> = {
  "docs/screenshots/issue-499/still-live-ready-desktop-1440x900.png": "2eafe805f6ad62a9dbca57e5c4822a8807db98cefa5ba9f041c39514232ac18e",
  "docs/screenshots/issue-499/still-live-ready-390x844.png": "4086a25e9b4903fed9298d6510cee6bfca8f13ec48772186f0d1aa1701860894",
  "docs/screenshots/issue-499/still-live-ready-390x600.png": "2d2b4057310ed8e1d27f5209373aea60ab4db43233435e21da7313db753f5cff",
  "docs/screenshots/issue-499/still-unresolved-recovery-390x844.png": "18dee490ce0d223bc479635ba259a850f0417722f04406a4827d873d16a2ac21",
  "docs/screenshots/issue-499/still-dead-recovery-390x844.png": "c78b711e72424dc8b1f6d9fdc1c9640fb57ea4876d9ae28836e6504c8d83eabf",
  "docs/screenshots/issue-499/still-dead-recovery-390x600.png": "9cd926ef41eb57a6047a1363049f95fb2bcee176b16e01c1208a50e613990415",
  "docs/screenshots/issue-499/still-image-upload-390x844.png": "d2d3f18aa6b45554b1818857edcc3dbc3877b65fac393cdbc812d207cbef1910",
};

/** 5x7 uppercase pixel font — enough to label every state legibly. */
const STILL_FONT: Record<string, string[]> = {
  "A": [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  "B": ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  "C": [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  "D": ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  "E": ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  "F": ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  "G": [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".####"],
  "H": ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  "I": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
  "J": ["....#", "....#", "....#", "....#", "#...#", "#...#", ".###."],
  "K": ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  "L": ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  "M": ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  "N": ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  "O": [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  "P": ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  "Q": [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  "R": ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  "S": [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  "T": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  "U": ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  "V": ["#...#", "#...#", "#...#", "#...#", ".#.#.", ".#.#.", "..#.."],
  "W": ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  "X": ["#...#", ".#.#.", "..#..", "..#..", "..#..", ".#.#.", "#...#"],
  "Y": ["#...#", ".#.#.", "..#..", "..#..", "..#..", "..#..", "..#.."],
  "Z": ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  "0": [".###.", "#..##", "#.#.#", "##..#", "#...#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", "#####"],
  "2": [".###.", "#...#", "....#", "..##.", ".#...", "#....", "#####"],
  "3": [".###.", "#...#", "....#", "..##.", "....#", "#...#", ".###."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
  "-": [".....", ".....", ".....", "####.", ".....", ".....", "....."],
  ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
};

function issue499Png(still: Issue499Still): Buffer {
  const { width, height, state } = still;
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
  const text = (x: number, y: number, label: string, color: Buffer, scale = 2) => {
    let cursor = x;
    for (const character of label) {
      const glyph = STILL_FONT[character] ?? STILL_FONT[" "]!;
      for (let row = 0; row < 7; row += 1) {
        for (let column = 0; column < 5; column += 1) {
          if (glyph[row]![column] === "#") fill(cursor + column * scale, y + row * scale, scale, scale, color);
        }
      }
      cursor += 6 * scale;
    }
    return cursor;
  };
  const canvas = Buffer.from([243, 244, 246]);
  const card = Buffer.from([255, 255, 255]);
  const border = Buffer.from([222, 226, 233]);
  const sunken = Buffer.from([238, 241, 245]);
  const ink = Buffer.from([31, 41, 55]);
  const muted = Buffer.from([140, 149, 163]);
  const accent = Buffer.from([109, 94, 246]);
  const accentSoft = Buffer.from([199, 193, 250]);
  const warning = Buffer.from([176, 118, 14]);
  const dangerSoft = Buffer.from([252, 231, 231]);
  const danger = Buffer.from([205, 48, 48]);
  const tile = Buffer.from([246, 138, 138]);

  for (let row = 0; row < height; row += 1) pixels.fill(canvas, row * stride + 1, (row + 1) * stride);

  const stateTitle: Record<Issue499State, string> = {
    "live-ready": "LIVE READY",
    "unresolved-recovery": "UNRESOLVED HOST - RECOVERY",
    "dead-recovery": "DEAD HOST - RECOVERY",
    "image-upload": "IMAGE UPLOAD",
  };
  text(16, 14, stateTitle[state], ink);
  text(16, 32, `ISSUE 499 - ${width}X${height} - SYNTHETIC FIXTURE`, muted, 1);

  /* Card pinned to the bottom, mirroring the pane layout. */
  const cardWidth = Math.min(width - 24, 720);
  const cardLeft = Math.round((width - cardWidth) / 2);
  const cardHeight = Math.min(height - 70, state === "dead-recovery" ? 400 : 320);
  const cardTop = height - cardHeight - 16;
  fill(cardLeft - 2, cardTop - 2, cardWidth + 4, cardHeight + 4, border);
  fill(cardLeft, cardTop, cardWidth, cardHeight, card);

  /* Transcript region up top of the card. */
  const bannerHeight = state === "dead-recovery" ? 132 : 0;
  const composerTop = cardTop + cardHeight
    - (state === "image-upload" ? 188 : state === "unresolved-recovery" ? 168 : 128);
  text(cardLeft + 16, cardTop + 14, "TRANSCRIPT", muted, 1);
  fill(cardLeft, composerTop - bannerHeight - 2, cardWidth, 2, border);

  if (state === "dead-recovery") {
    const bannerTop = composerTop - bannerHeight;
    fill(cardLeft, bannerTop, cardWidth, bannerHeight, dangerSoft);
    text(cardLeft + 16, bannerTop + 12, "AGENT HOST DIED - 5M AGO", danger);
    text(cardLeft + 16, bannerTop + 32, "MESSAGES CANT BE DELIVERED", ink, 1);
    const respawnWidth = 20 * 12 + 20;
    fill(cardLeft + 16, bannerTop + 48, respawnWidth, 30, accent);
    text(cardLeft + 26, bannerTop + 56, "RESPAWN CONVERSATION", card);
    const terminalWidth = 16 * 12 + 20;
    fill(cardLeft + 16, bannerTop + 86, terminalWidth, 30, border);
    fill(cardLeft + 18, bannerTop + 88, terminalWidth - 4, 26, card);
    text(cardLeft + 26, bannerTop + 94, "OPEN IN TERMINAL", ink);
    const recheckWidth = 8 * 12 + 20;
    fill(cardLeft + 24 + terminalWidth, bannerTop + 86, recheckWidth, 30, border);
    fill(cardLeft + 26 + terminalWidth, bannerTop + 88, recheckWidth - 4, 26, card);
    text(cardLeft + 34 + terminalWidth, bannerTop + 94, "RE-CHECK", ink);
  }

  /* Staged attachment tile (image-upload) above the input row. */
  if (state === "image-upload") {
    const tileTop = composerTop + 10;
    fill(cardLeft + 16, tileTop, 48, 48, tile);
    fill(cardLeft + 16 + 30, tileTop + 4, 14, 14, card);
    text(cardLeft + 16 + 33, tileTop + 5, "X", ink, 1);
  }

  /* Input row: sunken field + sliders/mic/send controls. */
  const inputTop = composerTop + (state === "image-upload" ? 70 : 12);
  const inputHeight = 44;
  fill(cardLeft + 14, inputTop - 2, cardWidth - 28, inputHeight + 4, border);
  fill(cardLeft + 16, inputTop, cardWidth - 32, inputHeight, sunken);
  const inputText: Record<Issue499State, { label: string; tone: Buffer }> = {
    "live-ready": { label: "MESSAGE THE AGENT...", tone: muted },
    "unresolved-recovery": { label: "RECONNECTING...", tone: muted },
    "dead-recovery": { label: "RECOVER AND CONTINUE", tone: ink },
    "image-upload": { label: "MESSAGE THE AGENT...", tone: muted },
  };
  text(cardLeft + 28, inputTop + 15, inputText[state].label, inputText[state].tone);
  const controlsRight = cardLeft + cardWidth - 32;
  /* Send: enabled accent for deliverable states, soft for blocked. */
  const sendColor = state === "unresolved-recovery" ? accentSoft : accent;
  fill(controlsRight - 36, inputTop + 6, 32, 32, sendColor);
  for (let step = 0; step < 8; step += 1) {
    fill(controlsRight - 36 + 11 + step, inputTop + 6 + 9 + step, 2, 2 * (8 - step), card);
  }
  /* Mic dot + sliders bars. */
  fill(controlsRight - 58, inputTop + 14, 10, 16, muted);
  fill(controlsRight - 82, inputTop + 16, 14, 3, muted);
  fill(controlsRight - 82, inputTop + 24, 14, 3, muted);

  const belowInput = inputTop + inputHeight + 12;
  if (state === "unresolved-recovery") {
    /* Inline blocked reason + the Re-check recovery route — never a launch. */
    text(cardLeft + 16, belowInput, "RESOLVING THE AGENT HOST...", warning);
    const recheckWidth = 8 * 12 + 20;
    fill(cardLeft + 16, belowInput + 22, recheckWidth, 30, border);
    fill(cardLeft + 18, belowInput + 24, recheckWidth - 4, 26, card);
    text(cardLeft + 26, belowInput + 30, "RE-CHECK", ink);
  } else {
    /* The always-visible model/reasoning pill row. */
    fill(cardLeft + 18, belowInput + 2, 10, 5, accent);
    fill(cardLeft + 22, belowInput + 7, 10, 5, accent);
    const pillEnd = text(cardLeft + 38, belowInput, "5.6-SOL - HIGH", ink);
    for (let step = 0; step < 4; step += 1) {
      fill(pillEnd + 8 + step, belowInput + 6 + step, 2, 2, ink);
      fill(pillEnd + 8 + 8 - step, belowInput + 6 + step, 2, 2, ink);
    }
  }

  text(cardLeft + 16, cardTop + cardHeight - 16, `SYNTHETIC - REV ${ISSUE_499_SOURCE_REVISION.slice(0, 12).toUpperCase()}`, muted, 1);

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("tEXt", Buffer.from("capture-source\0synthetic-fixture", "latin1")),
    chunk("tEXt", Buffer.from("privacy-classification\0synthetic", "latin1")),
    chunk("tEXt", Buffer.from("generator\0scripts/generate-privacy-placeholders.ts", "latin1")),
    chunk("tEXt", Buffer.from(`source-revision\0${ISSUE_499_SOURCE_REVISION}`, "latin1")),
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

for (const still of issue499Stills) {
  const output = resolve(root, still.path);
  const directory = dirname(output);
  mkdirSync(directory, { recursive: true });
  const sourceDigest = issue499SourceDigests[still.path];
  if (!sourceDigest) throw new Error("Missing source digest for issue 499 still");
  const contents = issue499Png(still);
  writeFileSync(output, contents);
  const assets = manifests.get(directory) ?? [];
  assets.push({
    path: output.slice(directory.length + 1),
    classification: "synthetic",
    source: "deterministic-generator",
    generator: relative(directory, generatorPath),
    generatorRuntime: `bun-${PRIVACY_GENERATOR_RUNTIME}`,
    generatorVersion: PRIVACY_GENERATOR_VERSION,
    generatorSha256,
    sourceDigests: [sourceDigest],
    sourceRevision: ISSUE_499_SOURCE_REVISION,
    description: still.description,
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

process.stdout.write(`Generated ${placeholders.length} deterministic redacted placeholders and ${issue499Stills.length} issue-499 synthetic stills with provenance.\n`);
