import { existsSync, lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { inflateSync } from "node:zlib";

export type FindingClass =
  | "configuration_error"
  | "credential"
  | "email_address"
  | "home_path"
  | "inspection_error"
  | "known_value"
  | "media_live_source"
  | "private_network"
  | "provenance_invalid"
  | "provenance_missing"
  | "resource_identifier"
  | "tool_unavailable"
  | "transcript_content"
  | "unsafe_path";

type ProvenanceAsset = {
  classification?: unknown;
  description?: unknown;
  expectedFindingClasses?: unknown;
  generator?: unknown;
  generatorSha256?: unknown;
  generatorVersion?: unknown;
  path?: unknown;
  sha256?: unknown;
  source?: unknown;
  sourceDigests?: unknown;
};

const allowedClassifications = new Set([
  "adversarial-synthetic",
  "redacted-placeholder",
  "synthetic",
]);
const adversarialFindingClasses = new Set<FindingClass>([
  "credential",
  "email_address",
  "home_path",
  "private_network",
  "resource_identifier",
  "transcript_content",
]);
const rasterExtensions = new Set([".bmp", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"]);
const animatedExtensions = new Set([".avi", ".gif", ".m4v", ".mkv", ".mov", ".mp4", ".webm"]);
const maxPublicationBytes = 32 * 1024 * 1024;
const credentialInputPattern = new RegExp([
  String.raw`<in`,
  String.raw`put\b(?=[^>]*(?:type\s*=\s*["']?password|name\s*=\s*["']?(?:api[_-]?key|password|secret|token)))`,
  String.raw`(?=[^>]*value\s*=\s*(?:["'][^"']{4,}["']|[^\s"'=<>]{4,}))[^>]*>`,
].join(""), "i");

type KnownValueFingerprint = {
  length: number;
  sha256: string;
};

function compactSensitiveText(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("en-US").replaceAll(/[^\p{L}\p{N}]/gu, "");
}

function loadKnownValues(): { error: boolean; fingerprints: KnownValueFingerprint[]; values: string[] } {
  const values = (process.env.LLV_PRIVACY_KNOWN_VALUES ?? "").split(/\r?\n/);
  const file = process.env.LLV_PRIVACY_KNOWN_VALUES_FILE;
  if (file) {
    try {
      values.push(...readFileSync(file, "utf8").split(/\r?\n/));
    } catch {
      return { error: true, fingerprints: [], values: [] };
    }
  }
  const normalizedValues = [...new Set(values.map((value) => value.trim()).filter((value) => value.length >= 4))];
  const fingerprints = new Map<string, KnownValueFingerprint>();
  for (const value of normalizedValues) {
    const compact = compactSensitiveText(value);
    if (compact.length < 4) continue;
    const sha256 = createHash("sha256").update(compact).digest("hex");
    fingerprints.set(`${compact.length}:${sha256}`, { length: compact.length, sha256 });
  }
  const fingerprintFile = process.env.LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE;
  if (fingerprintFile) {
    try {
      const catalog = JSON.parse(readFileSync(fingerprintFile, "utf8")) as {
        fingerprints?: unknown;
        normalization?: unknown;
        schemaVersion?: unknown;
      };
      if (catalog.schemaVersion !== 1 || catalog.normalization !== "nfkc-lower-alnum-v1" || !Array.isArray(catalog.fingerprints)) {
        return { error: true, fingerprints: [], values: [] };
      }
      for (const candidate of catalog.fingerprints) {
        if (typeof candidate !== "object" || candidate === null) return { error: true, fingerprints: [], values: [] };
        const fingerprint = candidate as Partial<KnownValueFingerprint>;
        if (!Number.isSafeInteger(fingerprint.length) || (fingerprint.length ?? 0) < 4 || (fingerprint.length ?? 0) > 512) {
          return { error: true, fingerprints: [], values: [] };
        }
        if (typeof fingerprint.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint.sha256)) {
          return { error: true, fingerprints: [], values: [] };
        }
        const valid = fingerprint as KnownValueFingerprint;
        fingerprints.set(`${valid.length}:${valid.sha256}`, valid);
      }
    } catch {
      return { error: true, fingerprints: [], values: [] };
    }
  }
  return {
    error: false,
    fingerprints: [...fingerprints.values()],
    values: normalizedValues,
  };
}

const knownValues = loadKnownValues();

function configuredOcrLanguages(): string | undefined {
  const languages = (process.env.LLV_PRIVACY_OCR_LANGUAGES ?? "eng").trim();
  return /^[a-z0-9_]+(?:\+[a-z0-9_]+)*$/i.test(languages) ? languages : undefined;
}

function isMedia(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return rasterExtensions.has(extension) || animatedExtensions.has(extension);
}

function requestedPaths(arguments_: string[]): string[] | undefined {
  const separator = arguments_.indexOf("--paths");
  return separator === -1 ? undefined : arguments_.slice(separator + 1);
}

function gitPaths(arguments_: string[]): { error: boolean; paths: string[] } {
  const result = Bun.spawnSync({ cmd: ["git", ...arguments_], stderr: "pipe", stdout: "pipe" });
  if (result.exitCode !== 0) return { error: true, paths: [] };
  return {
    error: false,
    paths: result.stdout.toString().split("\0").filter(Boolean),
  };
}

function changedPaths(arguments_: string[]): { error: boolean; paths: string[] } {
  const baseIndex = arguments_.indexOf("--base");
  const base = baseIndex === -1 ? "origin/main" : arguments_[baseIndex + 1];
  if (!base || base.startsWith("--")) return { error: true, paths: [] };
  const commands = [
    ["diff", "--name-only", "--diff-filter=ACMR", "-z", `${base}...HEAD`],
    ["diff", "--name-only", "--diff-filter=ACMR", "-z"],
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ];
  const paths = new Set<string>();
  for (const command of commands) {
    const result = gitPaths(command);
    if (result.error) return { error: true, paths: [] };
    for (const path of result.paths) paths.add(resolve(path));
  }
  return { error: false, paths: [...paths] };
}

function addFinding(findings: Map<FindingClass, number>, finding: FindingClass): void {
  findings.set(finding, (findings.get(finding) ?? 0) + 1);
}

function decodePercentEncoding(text: string): string {
  let decoded = text;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decoded.replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    });
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    colon: ":",
    gt: ">",
    lt: "<",
    quot: "\"",
    sol: "/",
  };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) {
      const value = Number.parseInt(code.slice(2), 16);
      return Number.isSafeInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : entity;
    }
    if (code.startsWith("#")) {
      const value = Number.parseInt(code.slice(1), 10);
      return Number.isSafeInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : entity;
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

function normalizedSensitiveText(text: string): { compact: string; searchable: string } {
  const decoded = decodeHtmlEntities(decodePercentEncoding(text.replaceAll(/[\u200B-\u200D\u2060\uFEFF]/g, "")));
  const withoutMarkup = decoded.replaceAll(/<[^>]*>/g, "").replaceAll(/[\[\]*`~]/g, "");
  const fingerprintViews = `${decoded}\n${withoutMarkup}`;
  return {
    compact: fingerprintViews.split(/\r?\n/).map((line) => compactSensitiveText(line)).join("\n"),
    searchable: `${decoded}\n${withoutMarkup}`.replaceAll("\0", "\n"),
  };
}

function matchesKnownFingerprint(compact: string): boolean {
  const fingerprintsByLength = new Map<number, Set<string>>();
  for (const fingerprint of knownValues.fingerprints) {
    const hashes = fingerprintsByLength.get(fingerprint.length) ?? new Set<string>();
    hashes.add(fingerprint.sha256);
    fingerprintsByLength.set(fingerprint.length, hashes);
  }
  for (const [length, hashes] of fingerprintsByLength) {
    if (length > compact.length) continue;
    for (let index = 0; index <= compact.length - length; index += 1) {
      const digest = createHash("sha256").update(compact.slice(index, index + length)).digest("hex");
      if (hashes.has(digest)) return true;
    }
  }
  return false;
}

function hasLiveCaptureMetadata(path: string): boolean {
  if (extname(path).toLowerCase() !== ".png") return false;
  const bytes = readFileSync(path);
  return bytes.includes(Buffer.from("capture-source\0live-", "latin1"));
}

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

function metadataStrings(bytes: Buffer): string[] {
  if (bytes.length > 1024 * 1024) throw new Error("metadata limit exceeded");
  const strings: string[] = [...(bytes.toString("latin1").match(/[\x20-\x7e]{4,}/g) ?? [])];
  const utf8 = bytes.toString("utf8");
  if (!utf8.includes("\ufffd")) strings.push(utf8);
  if (bytes.length >= 8 && bytes.length % 2 === 0) {
    const littleEndian = bytes.toString("utf16le");
    strings.push(...(littleEndian.match(/[\p{L}\p{N}][\p{L}\p{N}\p{P}\p{Zs}\\/:@._-]{3,}/gu) ?? []));
    const swapped = Buffer.from(bytes);
    swapped.swap16();
    const bigEndian = swapped.toString("utf16le");
    strings.push(...(bigEndian.match(/[\p{L}\p{N}][\p{L}\p{N}\p{P}\p{Zs}\\/:@._-]{3,}/gu) ?? []));
  }
  return strings;
}

function internationalText(data: Buffer): string[] {
  const keywordEnd = data.indexOf(0);
  if (keywordEnd < 1 || keywordEnd + 4 > data.length) throw new Error("invalid iTXt keyword");
  const compressionFlag = data[keywordEnd + 1];
  const compressionMethod = data[keywordEnd + 2];
  if ((compressionFlag !== 0 && compressionFlag !== 1) || compressionMethod !== 0) {
    throw new Error("invalid iTXt compression");
  }
  const languageEnd = data.indexOf(0, keywordEnd + 3);
  if (languageEnd === -1) throw new Error("invalid iTXt language");
  const translatedEnd = data.indexOf(0, languageEnd + 1);
  if (translatedEnd === -1) throw new Error("invalid iTXt translation");
  const encodedText = data.subarray(translatedEnd + 1);
  const text = compressionFlag === 1
    ? inflateSync(encodedText, { maxOutputLength: 1024 * 1024 })
    : encodedText;
  return [
    data.subarray(0, keywordEnd).toString("latin1"),
    data.subarray(keywordEnd + 3, languageEnd).toString("ascii"),
    data.subarray(languageEnd + 1, translatedEnd).toString("utf8"),
    text.toString("utf8"),
  ];
}

function pngMetadata(bytes: Buffer): { error: boolean; text: string } {
  if (!bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return { error: true, text: "" };
  }
  const values: string[] = [];
  let offset = 8;
  let iendOffset = -1;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (length > 16 * 1024 * 1024 || end > bytes.length) return { error: true, text: "" };
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) {
      return { error: true, text: "" };
    }
    if (type === "tEXt") values.push(data.toString("latin1"));
    if (type === "iTXt") {
      try {
        values.push(...internationalText(data));
      } catch {
        return { error: true, text: "" };
      }
    }
    if (type === "zTXt") {
      const separator = data.indexOf(0);
      if (separator === -1 || data[separator + 1] !== 0) return { error: true, text: "" };
      try {
        values.push(data.subarray(0, separator).toString("latin1"));
        values.push(inflateSync(data.subarray(separator + 2), { maxOutputLength: 1024 * 1024 }).toString("latin1"));
      } catch {
        return { error: true, text: "" };
      }
    }
    if (type === "iCCP") {
      const separator = data.indexOf(0);
      if (separator < 1 || separator + 2 > data.length || data[separator + 1] !== 0) {
        return { error: true, text: "" };
      }
      try {
        values.push(data.subarray(0, separator).toString("latin1"));
        const profile = inflateSync(data.subarray(separator + 2), { maxOutputLength: 1024 * 1024 });
        values.push(...metadataStrings(profile));
      } catch {
        return { error: true, text: "" };
      }
    }
    if (type === "eXIf") {
      try {
        values.push(...metadataStrings(data));
      } catch {
        return { error: true, text: "" };
      }
    }
    offset = end;
    if (type === "IEND") {
      if (length !== 0) return { error: true, text: "" };
      iendOffset = end;
      break;
    }
  }
  if (iendOffset === -1) return { error: true, text: "" };
  if (iendOffset < bytes.length) {
    try {
      values.push(...metadataStrings(bytes.subarray(iendOffset)));
    } catch {
      return { error: true, text: "" };
    }
  }
  return { error: false, text: values.join("\n") };
}

function inspectRasterMetadata(path: string): Set<FindingClass> {
  const extension = extname(path).toLowerCase();
  if (!rasterExtensions.has(extension)) return new Set();
  try {
    const bytes = readFileSync(path);
    if (extension === ".png") {
      const metadata = pngMetadata(bytes);
      return metadata.error ? new Set(["inspection_error"]) : sensitiveClasses(metadata.text);
    }
    if (bytes.length > 32 * 1024 * 1024) return new Set(["inspection_error"]);
    const printableMetadata = bytes.toString("latin1").match(/[\x20-\x7e]{4,}/g)?.join("\n") ?? "";
    return sensitiveClasses(printableMetadata);
  } catch {
    return new Set(["inspection_error"]);
  }
}

export function sensitiveClasses(text: string): Set<FindingClass> {
  const findings = new Set<FindingClass>();
  const { compact, searchable: searchableText } = normalizedSensitiveText(text);
  const normalizedText = searchableText.toLocaleLowerCase("en-US");
  if (knownValues.values.some((value) => normalizedText.includes(value.toLocaleLowerCase("en-US"))) || matchesKnownFingerprint(compact)) {
    findings.add("known_value");
  }
  const unixHomePattern = /(?:^|[\s"'(=:/])\/(?:home|Users)\/([A-Za-z0-9._-]+)(?:\/|$)/gm;
  for (const match of searchableText.matchAll(unixHomePattern)) {
    if (match[1].toLowerCase() === "user") continue;
    findings.add("home_path");
    break;
  }
  const windowsHomePattern = /(?:^|[\s"'(])[A-Za-z]:\\Users\\([A-Za-z0-9._-]+)(?:\\|$)/gm;
  for (const match of searchableText.matchAll(windowsHomePattern)) {
    if (match[1].toLowerCase() === "user") continue;
    findings.add("home_path");
    break;
  }
  const emailPattern = /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
  for (const match of searchableText.matchAll(emailPattern)) {
    const domain = match[1].toLowerCase();
    if (domain === "example.com" || domain === "example.net" || domain === "example.org" || domain.endsWith(".invalid")) continue;
    findings.add("email_address");
    break;
  }
  if (/(?:api[_-]?(?:key|token)|access[_-]?token|authorization|password|secret)\s*[:=]\s*["']?[A-Za-z0-9_./+:-]{12,}/i.test(searchableText)) {
    findings.add("credential");
  }
  if (/\b(?:gh[pousr]_|sk-|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/.test(searchableText)) {
    findings.add("credential");
  }
  const splitTokenPrefix = /(?:g[^a-z0-9\r\n]{1,8}h[^a-z0-9\r\n]{1,8}[pousr]|x[^a-z0-9\r\n]{1,8}o[^a-z0-9\r\n]{1,8}x[^a-z0-9\r\n]{1,8}[baprs]|s[^a-z0-9\r\n]{1,8}k)[^a-z0-9\r\n]{0,8}?[_-][^a-z0-9\r\n]*/gi;
  for (const line of searchableText.split(/\r?\n/)) {
    for (const match of line.matchAll(splitTokenPrefix)) {
      const compactTail = compactSensitiveText(line.slice(match.index));
      if (/^(?:gh[pousr]|xox[baprs]|sk)[a-z0-9]{12,}/i.test(compactTail)) {
        findings.add("credential");
        break;
      }
    }
    if (findings.has("credential")) break;
  }
  if (/\bauthorization\s*[:=]\s*(?:basic|bearer)\s+[A-Za-z0-9._~+/=-]{8,}/i.test(searchableText)) {
    findings.add("credential");
  }
  if (/https?:\/\/[^\s/@:]+:[^\s/@]+@/i.test(searchableText)) {
    findings.add("credential");
  }
  if (credentialInputPattern.test(searchableText)) {
    findings.add("credential");
  }
  if (/\b(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})\b/.test(searchableText)) {
    findings.add("private_network");
  }
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(searchableText)) {
    findings.add("resource_identifier");
  }
  if (/(?:^|\n)\s*(?:assistant|prompt|transcript|user)\s*:\s*\S/im.test(searchableText)) {
    findings.add("transcript_content");
  }
  return findings;
}

function inspectText(path: string): Set<FindingClass> {
  if (isMedia(path)) return new Set();
  const contents = readFileSync(path);
  if (contents.includes(0)) return new Set();
  return sensitiveClasses(contents.toString("utf8"));
}

function inspectRaster(path: string): Set<FindingClass> {
  if (!rasterExtensions.has(extname(path).toLowerCase())) return new Set();
  if (!Bun.which("tesseract")) return new Set(["tool_unavailable"]);
  const languages = configuredOcrLanguages();
  if (!languages) return new Set(["configuration_error"]);
  const result = Bun.spawnSync({
    cmd: ["tesseract", path, "stdout", "-l", languages],
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) return new Set(["inspection_error"]);
  return sensitiveClasses(result.stdout.toString());
}

function inspectAnimated(path: string): Set<FindingClass> {
  if (!animatedExtensions.has(extname(path).toLowerCase())) return new Set();
  if (!Bun.which("ffprobe") || !Bun.which("ffmpeg") || !Bun.which("tesseract")) {
    return new Set(["tool_unavailable"]);
  }
  const languages = configuredOcrLanguages();
  if (!languages) return new Set(["configuration_error"]);
  const probe = Bun.spawnSync({
    cmd: [
      "ffprobe",
      "-v",
      "error",
      "-count_frames",
      "-select_streams",
      "v:0",
      "-show_entries",
      "format=duration:format_tags:stream=duration,nb_frames,nb_read_frames:stream_tags",
      "-of",
      "json",
      path,
    ],
    stderr: "pipe",
    stdout: "pipe",
  });
  if (probe.exitCode !== 0) return new Set(["inspection_error"]);
  const findings = sensitiveClasses(probe.stdout.toString());
  let duration = 0;
  let frameCount = 0;
  try {
    const metadata = JSON.parse(probe.stdout.toString()) as {
      format?: { duration?: unknown };
      streams?: Array<{ duration?: unknown; nb_frames?: unknown; nb_read_frames?: unknown }>;
    };
    duration = Number(metadata.format?.duration ?? metadata.streams?.[0]?.duration);
    if (!Number.isFinite(duration) || duration < 0) duration = 0;
    frameCount = Number(metadata.streams?.[0]?.nb_read_frames ?? metadata.streams?.[0]?.nb_frames);
    if (!Number.isSafeInteger(frameCount) || frameCount < 1) frameCount = 0;
  } catch {
    return new Set([...findings, "inspection_error"]);
  }
  const fractions = [0, 0.25, 0.5, 0.75, 0.95];
  const samples = duration > 0
    ? fractions.map((fraction) => ({ kind: "time" as const, value: (duration * fraction).toFixed(3) }))
    : fractions.map((fraction) => ({
      kind: "frame" as const,
      value: Math.floor((frameCount > 0 ? frameCount - 1 : 1_800) * fraction).toString(),
    }));
  const uniqueSamples = new Map(samples.map((sample) => [`${sample.kind}:${sample.value}`, sample]));
  for (const sample of uniqueSamples.values()) {
    const seekArguments = sample.kind === "time"
      ? ["-ss", sample.value, "-i", path]
      : ["-i", path, "-vf", `select=eq(n\\,${sample.value})`];
    const frame = Bun.spawnSync({
      cmd: [
        "ffmpeg",
        "-v",
        "error",
        ...seekArguments,
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "pipe:1",
      ],
      stderr: "pipe",
      stdout: "pipe",
    });
    if (frame.exitCode !== 0 || frame.stdout.length === 0) {
      findings.add("inspection_error");
      continue;
    }
    const ocr = Bun.spawnSync({
      cmd: ["tesseract", "stdin", "stdout", "-l", languages],
      stdin: frame.stdout,
      stderr: "pipe",
      stdout: "pipe",
    });
    if (ocr.exitCode !== 0) {
      findings.add("inspection_error");
      continue;
    }
    for (const finding of sensitiveClasses(ocr.stdout.toString())) findings.add(finding);
  }
  return findings;
}

type ProvenanceResult = {
  expectedFindingClasses: Set<FindingClass>;
  status: "invalid" | "missing" | "valid";
};

function pathIsWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function currentRepositoryRoot(): string | undefined {
  const result = Bun.spawnSync({ cmd: ["git", "rev-parse", "--show-toplevel"], stderr: "pipe", stdout: "pipe" });
  if (result.exitCode !== 0) return undefined;
  const root = result.stdout.toString().trim();
  return root.length > 0 ? resolve(root) : undefined;
}

const repositoryRoot = currentRepositoryRoot();

function provenanceFor(path: string): ProvenanceResult {
  const manifestPath = join(dirname(path), "privacy-manifest.json");
  const invalid: ProvenanceResult = { expectedFindingClasses: new Set(), status: "invalid" };
  if (!existsSync(manifestPath)) return { expectedFindingClasses: new Set(), status: "missing" };
  try {
    const manifestMetadata = lstatSync(manifestPath);
    if (manifestMetadata.isSymbolicLink() || !manifestMetadata.isFile()) return invalid;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      assets?: unknown;
      schemaVersion?: unknown;
    };
    if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.assets)) return invalid;
    const asset = manifest.assets.find((candidate): candidate is ProvenanceAsset => {
      if (typeof candidate !== "object" || candidate === null) return false;
      return (candidate as ProvenanceAsset).path === basename(path);
    });
    if (!asset) return invalid;
    if (typeof asset.classification !== "string" || !allowedClassifications.has(asset.classification)) return invalid;
    if (typeof asset.description !== "string" || asset.description.trim().length < 12) return invalid;
    if (typeof asset.generator !== "string" || asset.generator.length === 0 || isAbsolute(asset.generator)) return invalid;
    const generatorPath = resolve(dirname(manifestPath), asset.generator);
    if (!existsSync(generatorPath)) return invalid;
    const provenanceRoot = repositoryRoot && pathIsWithin(repositoryRoot, path) ? repositoryRoot : dirname(manifestPath);
    if (!pathIsWithin(provenanceRoot, generatorPath)) return invalid;
    const generatorMetadata = lstatSync(generatorPath);
    if (generatorMetadata.isSymbolicLink() || !generatorMetadata.isFile()) return invalid;
    const generatorBytes = readFileSync(generatorPath);
    if (typeof asset.generatorVersion !== "string" || !/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(asset.generatorVersion)) return invalid;
    const escapedVersion = asset.generatorVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const versionDeclaration = new RegExp(`\\bPRIVACY_GENERATOR_VERSION\\s*=\\s*["']${escapedVersion}["']`);
    if (!versionDeclaration.test(generatorBytes.toString("utf8"))) return invalid;
    if (typeof asset.generatorSha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.generatorSha256)) return invalid;
    const generatorHash = createHash("sha256").update(generatorBytes).digest("hex");
    if (generatorHash !== asset.generatorSha256) return invalid;
    const expectedSource = asset.classification === "redacted-placeholder" ? "redacted-live-capture" : "deterministic-generator";
    if (asset.source !== expectedSource) return invalid;
    if (typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)) return invalid;
    const actualHash = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (actualHash !== asset.sha256) return invalid;
    if (!Array.isArray(asset.sourceDigests) || asset.sourceDigests.length === 0 || asset.sourceDigests.length > 16) return invalid;
    const sourceDigests = new Set<string>();
    for (const digest of asset.sourceDigests) {
      if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest) || digest === actualHash) return invalid;
      sourceDigests.add(digest);
    }
    if (sourceDigests.size !== asset.sourceDigests.length) return invalid;
    if (asset.classification !== "adversarial-synthetic") {
      if (asset.expectedFindingClasses !== undefined) return invalid;
      return { expectedFindingClasses: new Set(), status: "valid" };
    }
    const fixtureDirectory = dirname(path).split(/[\\/]/).some((segment) => /(?:^|-)fixtures?$/.test(segment));
    if (!fixtureDirectory || !Array.isArray(asset.expectedFindingClasses) || asset.expectedFindingClasses.length === 0) return invalid;
    const expectedFindingClasses = new Set<FindingClass>();
    for (const finding of asset.expectedFindingClasses) {
      if (typeof finding !== "string" || !adversarialFindingClasses.has(finding as FindingClass)) return invalid;
      expectedFindingClasses.add(finding as FindingClass);
    }
    if (expectedFindingClasses.size !== asset.expectedFindingClasses.length) return invalid;
    return { expectedFindingClasses, status: "valid" };
  } catch {
    return invalid;
  }
}

export function inspectPaths(paths: string[], configurationError = false, requireKnownValues = false): Map<FindingClass, number> {
  const findings = new Map<FindingClass, number>();
  if (knownValues.error || configurationError || (requireKnownValues && knownValues.fingerprints.length === 0)) {
    addFinding(findings, "configuration_error");
  }
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        addFinding(findings, "unsafe_path");
        continue;
      }
      if (metadata.size > maxPublicationBytes) {
        addFinding(findings, "inspection_error");
        continue;
      }
    } catch {
      addFinding(findings, "inspection_error");
      continue;
    }
    const pathFindings = new Set<FindingClass>();
    if (hasLiveCaptureMetadata(path)) pathFindings.add("media_live_source");
    for (const finding of inspectRasterMetadata(path)) pathFindings.add(finding);
    for (const finding of inspectRaster(path)) pathFindings.add(finding);
    for (const finding of inspectAnimated(path)) pathFindings.add(finding);
    for (const finding of inspectText(path)) pathFindings.add(finding);
    if (isMedia(path)) {
      const provenance = provenanceFor(path);
      if (provenance.status === "missing") pathFindings.add("provenance_missing");
      if (provenance.status === "invalid") pathFindings.add("provenance_invalid");
      if (provenance.status === "valid" && provenance.expectedFindingClasses.size > 0) {
        const actualAdversarial = new Set([...pathFindings].filter((finding) => adversarialFindingClasses.has(finding)));
        const matches = actualAdversarial.size === provenance.expectedFindingClasses.size
          && [...actualAdversarial].every((finding) => provenance.expectedFindingClasses.has(finding));
        if (matches) {
          for (const finding of provenance.expectedFindingClasses) pathFindings.delete(finding);
        } else {
          pathFindings.add("provenance_invalid");
        }
      }
    }
    for (const finding of pathFindings) addFinding(findings, finding);
  }
  return findings;
}

export function formatPrivacyReport(findings: Map<FindingClass, number>): string {
  if (findings.size === 0) {
    return "PRIVACY GATE: PASS\n";
  }
  const lines = ["PRIVACY GATE: FAIL"];
  for (const [finding, count] of [...findings].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`${finding}: ${count}`);
  }
  return `${lines.join("\n")}\n`;
}

export function reportPrivacyFindings(findings: Map<FindingClass, number>): void {
  process.stdout.write(formatPrivacyReport(findings));
  if (findings.size === 0) return;
  process.exitCode = 1;
}

if (import.meta.main) {
  const arguments_ = process.argv.slice(2);
  const explicitPaths = requestedPaths(arguments_);
  const selection = explicitPaths === undefined
    ? changedPaths(arguments_)
    : { error: explicitPaths.length === 0, paths: explicitPaths };
  reportPrivacyFindings(inspectPaths(selection.paths, selection.error, arguments_.includes("--require-known-values")));
}
