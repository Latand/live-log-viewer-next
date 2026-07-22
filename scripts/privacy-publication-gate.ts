import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inflateSync } from "node:zlib";

import { decodeHTMLStrict } from "entities";

import { withoutWakatimeCredential } from "../src/lib/wakatime/credential";

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
  generatorRuntime?: unknown;
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
const textExtensions = new Set([
  ".cjs", ".conf", ".css", ".csv", ".env", ".graphql", ".htm", ".html", ".ini", ".js", ".json",
  ".jsx", ".lock", ".md", ".mdx", ".mjs", ".properties", ".sh", ".svg", ".toml", ".ts", ".tsx",
  ".txt", ".xml", ".yaml", ".yml", ".zsh",
]);
const textBasenames = new Set(["CODEOWNERS", "Dockerfile", "LICENSE", "Makefile", "README"]);
const maxPublicationBytes = 32 * 1024 * 1024;
const maxVideoStreams = 16;
const supportedGeneratorRuntime = "bun-1.3.3";
const credentialInputPattern = new RegExp([
  String.raw`<in`,
  String.raw`put\b(?=[^>]*(?:type\s*=\s*["']?password|name\s*=\s*["']?(?:api[_-]?key|password|secret|token)))`,
  String.raw`(?=[^>]*value\s*=\s*(?:["'][^"']{4,}["']|[^\s"'=<>]{4,}))[^>]*>`,
].join(""), "i");

type KnownValueFingerprint = {
  length: number;
  sha256: string;
};

type SafePathResult = {
  metadata?: ReturnType<typeof lstatSync>;
  status: "missing" | "safe" | "symlink";
};

type MediaKind = "animated" | "png" | "raster";

function safePath(path: string): SafePathResult {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(root);
  } catch {
    return { status: "missing" };
  }
  if (metadata.isSymbolicLink()) return { status: "symlink" };
  const segments = relative(root, absolute).split(sep).filter(Boolean);
  for (const segment of segments) {
    current = join(current, segment);
    try {
      metadata = lstatSync(current);
    } catch {
      return { status: "missing" };
    }
    if (metadata.isSymbolicLink()) return { status: "symlink" };
  }
  return { metadata, status: "safe" };
}

function readSafeRegularFile(path: string): Buffer {
  const result = safePath(path);
  if (result.status !== "safe" || !result.metadata?.isFile()) throw new Error("unsafe file path");
  return readFileSync(resolve(path));
}

function compactSensitiveText(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("en-US").replaceAll(/[^\p{L}\p{N}]/gu, "");
}

function loadKnownValues(): { error: boolean; fingerprints: KnownValueFingerprint[]; values: string[] } {
  const values = (process.env.LLV_PRIVACY_KNOWN_VALUES ?? "").split(/\r?\n/);
  const file = process.env.LLV_PRIVACY_KNOWN_VALUES_FILE;
  if (file) {
    try {
      values.push(...readSafeRegularFile(file).toString("utf8").split(/\r?\n/));
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
      const catalog = JSON.parse(readSafeRegularFile(fingerprintFile).toString("utf8")) as {
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

function extensionMediaKind(path: string): MediaKind | undefined {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") return "png";
  if (rasterExtensions.has(extension)) return "raster";
  if (animatedExtensions.has(extension)) return "animated";
  return undefined;
}

function signatureMediaKind(bytes: Buffer): MediaKind | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "png";
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "raster";
  const prefix = bytes.subarray(0, 12).toString("latin1");
  if (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a")) return "animated";
  if (prefix.startsWith("BM")) return "raster";
  if (bytes.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]))
    || bytes.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))) return "raster";
  if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "AVI ") return "animated";
  if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP") {
    const webpChunks = bytes.subarray(12).toString("latin1");
    return webpChunks.includes("ANIM") || webpChunks.includes("ANMF") ? "animated" : "raster";
  }
  if (bytes.length >= 8 && bytes.subarray(4, 8).toString("latin1") === "ftyp") return "animated";
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "animated";
  return undefined;
}

function mediaKind(path: string): MediaKind | undefined {
  try {
    return signatureMediaKind(readFileSync(path)) ?? extensionMediaKind(path);
  } catch {
    return extensionMediaKind(path);
  }
}

function requestedPaths(arguments_: string[]): string[] | undefined {
  const separator = arguments_.indexOf("--paths");
  return separator === -1 ? undefined : arguments_.slice(separator + 1);
}

function argumentValue(arguments_: string[], flag: string): string | undefined {
  const index = arguments_.indexOf(flag);
  if (index === -1) return undefined;
  const value = arguments_[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function gitPaths(repository: string, arguments_: string[]): { error: boolean; paths: string[] } {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", repository, ...arguments_],
    env: withoutWakatimeCredential(process.env),
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) return { error: true, paths: [] };
  return {
    error: false,
    paths: result.stdout.toString().split("\0").filter(Boolean),
  };
}

function changedPaths(arguments_: string[], repository: string): { error: boolean; paths: string[] } {
  const baseIndex = arguments_.indexOf("--base");
  const base = baseIndex === -1 ? "origin/main" : arguments_[baseIndex + 1];
  if (!base || base.startsWith("--")) return { error: true, paths: [] };
  const commands = [
    ["diff", "--name-only", "--diff-filter=ACMRT", "-z", `${base}...HEAD`],
    ["diff", "--name-only", "--diff-filter=ACMRT", "-z"],
    ["diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ];
  const paths = new Set<string>();
  for (const command of commands) {
    const result = gitPaths(repository, command);
    if (result.error) return { error: true, paths: [] };
    for (const path of result.paths) paths.add(resolve(repository, path));
  }
  return { error: false, paths: [...paths] };
}

function addFinding(findings: Map<FindingClass, number>, finding: FindingClass): void {
  findings.set(finding, (findings.get(finding) ?? 0) + 1);
}

function decodePercentEncoding(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  });
}

function decodeHtmlEntities(text: string): string {
  return decodeHTMLStrict(text);
}

function decodeCommonMarkEscapes(text: string): string {
  return text.replaceAll(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
}

function removeDefaultIgnorables(text: string): string {
  return text.replaceAll(/\p{Default_Ignorable_Code_Point}/gu, "");
}

export function canonicalSensitiveText(text: string): { error: boolean; text: string } {
  let decoded = removeDefaultIgnorables(text);
  for (let pass = 0; pass < 16; pass += 1) {
    const next = removeDefaultIgnorables(
      decodeCommonMarkEscapes(decodeHtmlEntities(decodePercentEncoding(decoded))),
    );
    if (next === decoded) return { error: false, text: decoded };
    decoded = next;
  }
  return { error: true, text: decoded };
}

function visibleMarkdownText(text: string): string {
  let visible = "";
  let cursor = 0;
  while (cursor < text.length) {
    const labelStart = text[cursor] === "["
      ? cursor
      : (text[cursor] === "!" && text[cursor + 1] === "[" ? cursor + 1 : -1);
    if (labelStart === -1) {
      visible += text[cursor];
      cursor += 1;
      continue;
    }
    let labelEnd = labelStart + 1;
    let labelDepth = 0;
    for (; labelEnd < text.length; labelEnd += 1) {
      if (text[labelEnd] === "\\" && labelEnd + 1 < text.length) {
        labelEnd += 1;
        continue;
      }
      if (text[labelEnd] === "[") labelDepth += 1;
      if (text[labelEnd] !== "]") continue;
      if (labelDepth === 0) break;
      labelDepth -= 1;
    }
    if (labelEnd >= text.length || text[labelEnd + 1] !== "(") {
      visible += text[cursor];
      cursor += 1;
      continue;
    }
    let destinationEnd = labelEnd + 2;
    let destinationDepth = 0;
    for (; destinationEnd < text.length; destinationEnd += 1) {
      if (text[destinationEnd] === "\\" && destinationEnd + 1 < text.length) {
        destinationEnd += 1;
        continue;
      }
      if (text[destinationEnd] === "(") {
        destinationDepth += 1;
        continue;
      }
      if (text[destinationEnd] !== ")") continue;
      if (destinationDepth === 0) break;
      destinationDepth -= 1;
    }
    if (destinationEnd >= text.length) {
      visible += text[cursor];
      cursor += 1;
      continue;
    }
    visible += text.slice(labelStart + 1, labelEnd);
    cursor = destinationEnd + 1;
  }
  return visible;
}

function normalizedSensitiveText(text: string): { compact: string; error: boolean; searchable: string } {
  const canonical = canonicalSensitiveText(text);
  const decoded = canonical.text;
  const withoutMarkup = visibleMarkdownText(decoded).replaceAll(/<[^>]*>/g, "").replaceAll(/[\[\]*_`~]/g, "");
  return {
    compact: `${compactSensitiveText(decoded)}\0${compactSensitiveText(withoutMarkup)}`,
    error: canonical.error,
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
  for (const alignment of [0, 1]) {
    const end = bytes.length - ((bytes.length - alignment) % 2);
    if (end - alignment < 8) continue;
    const aligned = bytes.subarray(alignment, end);
    strings.push(aligned.toString("utf16le"));
    const swapped = Buffer.from(aligned);
    swapped.swap16();
    strings.push(swapped.toString("utf16le"));
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

function pngMetadata(bytes: Buffer): { animated?: boolean; error: boolean; liveSource?: boolean; text: string } {
  if (!bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return { error: true, text: "" };
  }
  const values: string[] = [];
  let animated = false;
  let liveSource = false;
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
    if (type === "acTL") {
      if (animated || data.length !== 8 || data.readUInt32BE(0) < 1) return { error: true, text: "" };
      animated = true;
    }
    if (type === "tEXt") {
      const separator = data.indexOf(0);
      if (separator > 0 && data.subarray(0, separator).toString("latin1") === "capture-source"
        && data.subarray(separator + 1).toString("latin1").startsWith("live-")) {
        liveSource = true;
      }
      values.push(data.toString("latin1"));
    }
    if (type === "iTXt") {
      try {
        const decoded = internationalText(data);
        values.push(...decoded);
        if (decoded[0] === "capture-source" && decoded[3].startsWith("live-")) liveSource = true;
      } catch {
        return { error: true, text: "" };
      }
    }
    if (type === "zTXt") {
      const separator = data.indexOf(0);
      if (separator === -1 || data[separator + 1] !== 0) return { error: true, text: "" };
      try {
        const keyword = data.subarray(0, separator).toString("latin1");
        const decoded = inflateSync(data.subarray(separator + 2), { maxOutputLength: 1024 * 1024 }).toString("latin1");
        values.push(keyword, decoded);
        if (keyword === "capture-source" && decoded.startsWith("live-")) liveSource = true;
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
  if (values.some((value) => value.includes("capture-source\0live-"))) liveSource = true;
  return { animated, error: false, liveSource, text: values.join("\n") };
}

function inspectRasterMetadata(path: string, kind: MediaKind | undefined): Set<FindingClass> {
  if (kind !== "png" && kind !== "raster") return new Set();
  try {
    const bytes = readFileSync(path);
    if (kind === "png") {
      const metadata = pngMetadata(bytes);
      if (metadata.error) return new Set(["inspection_error"]);
      const findings = sensitiveClasses(metadata.text);
      if (metadata.animated) findings.add("inspection_error");
      if (metadata.liveSource) findings.add("media_live_source");
      return findings;
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
  const { compact, error, searchable: searchableText } = normalizedSensitiveText(text);
  if (error) findings.add("inspection_error");
  const normalizedText = searchableText.toLocaleLowerCase("en-US");
  if (knownValues.values.some((value) => normalizedText.includes(value.toLocaleLowerCase("en-US"))) || matchesKnownFingerprint(compact)) {
    findings.add("known_value");
  }
  const unixHomePattern = /(?:^|[\s"'(=:/])\/(?:home|Users)\/([A-Za-z0-9._-]+)(?:\/|$)/gm;
  for (let match = unixHomePattern.exec(searchableText); match; match = unixHomePattern.exec(searchableText)) {
    if (match[1].toLowerCase() === "user") continue;
    findings.add("home_path");
    break;
  }
  const windowsHomePattern = /(?:^|[\s"'(])[A-Za-z]:\\Users\\([A-Za-z0-9._-]+)(?:\\|$)/gim;
  for (let match = windowsHomePattern.exec(searchableText); match; match = windowsHomePattern.exec(searchableText)) {
    if (match[1].toLowerCase() === "user") continue;
    findings.add("home_path");
    break;
  }
  const emailPattern = /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
  for (let match = emailPattern.exec(searchableText); match; match = emailPattern.exec(searchableText)) {
    const domain = match[1].toLowerCase();
    if (domain === "example.com" || domain === "example.net" || domain === "example.org" || domain.endsWith(".invalid")) continue;
    findings.add("email_address");
    break;
  }
  const credentialAssignmentPattern = /(?:api[_-]?(?:key|token)|access[_-]?token|authorization|password|secret)\s*[:=]\s*(?:"[^"\r\n]{12,}"|'[^'\r\n]{12,}'|[^\s"'`]{12,})/i;
  if (credentialAssignmentPattern.test(searchableText)) {
    findings.add("credential");
  }
  if (/\b(?:github_pat_|gh[pousr]_|sk-|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/.test(searchableText)) {
    findings.add("credential");
  }
  const separator = String.raw`[^a-z0-9\r\n]{1,8}`;
  const splitTokenPrefix = new RegExp([
    `g${separator}i${separator}t${separator}h${separator}u${separator}b${separator}p${separator}a${separator}t`,
    `g${separator}h${separator}[pousr]`,
    `x${separator}o${separator}x${separator}[baprs]`,
    `s${separator}k`,
  ].join("|") + String.raw`[^a-z0-9\r\n]{0,8}?[_-][^a-z0-9\r\n]*`, "gi");
  for (const line of searchableText.split(/\r?\n/)) {
    splitTokenPrefix.lastIndex = 0;
    for (let match = splitTokenPrefix.exec(line); match; match = splitTokenPrefix.exec(line)) {
      const compactTail = compactSensitiveText(line.slice(match.index));
      if (/^(?:githubpat|gh[pousr]|xox[baprs]|sk)[a-z0-9]{12,}/i.test(compactTail)) {
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
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(searchableText)) {
    findings.add("resource_identifier");
  }
  if (/(?:^|\n)\s*(?:assistant|prompt|transcript|user)\s*:\s*\S/im.test(searchableText)) {
    findings.add("transcript_content");
  }
  return findings;
}

function inspectText(path: string, kind: MediaKind | undefined): Set<FindingClass> {
  if (kind) return new Set();
  try {
    const contents = readFileSync(path);
    const utf8 = contents.toString("utf8");
    const views = [utf8];
    const startsUtf32LittleEndian = contents.subarray(0, 4).equals(Buffer.from([0xff, 0xfe, 0x00, 0x00]));
    const startsUtf32BigEndian = contents.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0xfe, 0xff]));
    const startsLittleEndian = !startsUtf32LittleEndian
      && contents.length >= 2
      && contents[0] === 0xff
      && contents[1] === 0xfe;
    const startsBigEndian = !startsUtf32BigEndian
      && contents.length >= 2
      && contents[0] === 0xfe
      && contents[1] === 0xff;
    let supportedEncoding = false;
    if (startsLittleEndian || startsBigEndian) {
      const payload = Buffer.from(contents.subarray(2));
      if (payload.length % 2 === 0) {
        if (startsBigEndian) payload.swap16();
        try {
          views.push(new TextDecoder("utf-16le", { fatal: true }).decode(payload));
          supportedEncoding = true;
        } catch {
          supportedEncoding = false;
        }
      }
    } else if (!startsUtf32LittleEndian && !startsUtf32BigEndian) {
      try {
        views[0] = new TextDecoder("utf-8", { fatal: true }).decode(contents);
        supportedEncoding = true;
      } catch {
        supportedEncoding = false;
      }
    }
    if (contents.includes(0) && !startsLittleEndian && !startsBigEndian) {
      for (const alignment of [0, 1]) {
        const end = contents.length - ((contents.length - alignment) % 2);
        if (end - alignment < 4) continue;
        const aligned = contents.subarray(alignment, end);
        views.push(aligned.toString("utf16le"));
        const swapped = Buffer.from(aligned);
        swapped.swap16();
        views.push(swapped.toString("utf16le"));
      }
    }
    const findings = sensitiveClasses(views.join("\n"));
    const extension = extname(path).toLowerCase();
    const textLike = textExtensions.has(extension) || textBasenames.has(basename(path));
    const controlBytes = contents.reduce((count, byte) => {
      const allowedWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d;
      return count + (byte < 0x20 && !allowedWhitespace ? 1 : 0);
    }, 0);
    const excessiveControlBytes = !startsLittleEndian
      && !startsBigEndian
      && controlBytes > 0
      && controlBytes * 8 > contents.length;
    const unsupportedBinary = !textLike && (!supportedEncoding || controlBytes > 0);
    const invalidTextEncoding = textLike && (!supportedEncoding || excessiveControlBytes);
    if (unsupportedBinary || invalidTextEncoding) findings.add("inspection_error");
    return findings;
  } catch {
    return new Set(["inspection_error"]);
  }
}

function inspectRaster(path: string, kind: MediaKind | undefined): Set<FindingClass> {
  if (kind !== "png" && kind !== "raster") return new Set();
  if (!Bun.which("tesseract")) return new Set(["tool_unavailable"]);
  const languages = configuredOcrLanguages();
  if (!languages) return new Set(["configuration_error"]);
  const result = Bun.spawnSync({
    cmd: ["tesseract", path, "stdout", "-l", languages],
    env: withoutWakatimeCredential(process.env),
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) return new Set(["inspection_error"]);
  return sensitiveClasses(result.stdout.toString());
}

function inspectAnimated(path: string, kind: MediaKind | undefined): Set<FindingClass> {
  if (kind !== "animated") return new Set();
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
      "v",
      "-show_entries",
      "format=duration:format_tags:stream=duration,nb_frames,nb_read_frames:stream_tags",
      "-of",
      "json",
      path,
    ],
    env: withoutWakatimeCredential(process.env),
    stderr: "pipe",
    stdout: "pipe",
  });
  if (probe.exitCode !== 0) return new Set(["inspection_error"]);
  const findings = sensitiveClasses(probe.stdout.toString());
  let formatDuration = 0;
  let streams: Array<{ duration?: unknown; nb_frames?: unknown; nb_read_frames?: unknown }>;
  try {
    const metadata = JSON.parse(probe.stdout.toString()) as {
      format?: { duration?: unknown };
      streams?: unknown;
    };
    formatDuration = Number(metadata.format?.duration);
    if (!Number.isFinite(formatDuration) || formatDuration < 0) formatDuration = 0;
    if (!Array.isArray(metadata.streams) || metadata.streams.length === 0 || metadata.streams.length > maxVideoStreams
      || metadata.streams.some((stream) => typeof stream !== "object" || stream === null || Array.isArray(stream))) {
      findings.add("inspection_error");
      return findings;
    }
    streams = metadata.streams as Array<{ duration?: unknown; nb_frames?: unknown; nb_read_frames?: unknown }>;
  } catch {
    return new Set([...findings, "inspection_error"]);
  }
  const fractions = [0, 0.25, 0.5, 0.75, 0.95];
  for (const [streamOrdinal, stream] of streams.entries()) {
    let duration = Number(stream.duration);
    if (!Number.isFinite(duration) || duration < 0) duration = formatDuration;
    let frameCount = 0;
    for (const candidate of [stream.nb_read_frames, stream.nb_frames]) {
      const count = Number(candidate);
      if (!Number.isSafeInteger(count) || count < 1) continue;
      frameCount = count;
      break;
    }
    if (duration === 0 && frameCount === 0) {
      findings.add("inspection_error");
      continue;
    }
    const samples = duration > 0
      ? fractions.map((fraction) => ({ kind: "time" as const, value: (duration * fraction).toFixed(3) }))
      : fractions.map((fraction) => ({
        kind: "frame" as const,
        value: Math.floor((frameCount - 1) * fraction).toString(),
      }));
    const uniqueSamples = new Map(samples.map((sample) => [`${sample.kind}:${sample.value}`, sample]));
    for (const sample of uniqueSamples.values()) {
      const inputArguments = sample.kind === "time"
        ? ["-ss", sample.value, "-i", path]
        : ["-i", path];
      const filterArguments = sample.kind === "frame" ? ["-vf", `select=eq(n\\,${sample.value})`] : [];
      const frame = Bun.spawnSync({
        cmd: [
          "ffmpeg",
          "-v",
          "error",
          ...inputArguments,
          "-map",
          `0:v:${streamOrdinal}`,
          ...filterArguments,
          "-frames:v",
          "1",
          "-f",
          "image2pipe",
          "-vcodec",
          "png",
          "pipe:1",
        ],
        env: withoutWakatimeCredential(process.env),
        stderr: "pipe",
        stdout: "pipe",
      });
      if (frame.exitCode !== 0 || frame.stdout.length === 0) {
        findings.add("inspection_error");
        continue;
      }
      const ocr = Bun.spawnSync({
        cmd: ["tesseract", "stdin", "stdout", "-l", languages],
        env: withoutWakatimeCredential(process.env),
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
  }
  return findings;
}

type ProvenanceResult = {
  expectedFindingClasses: Set<FindingClass>;
  status: "invalid" | "missing" | "valid";
};

type ReproducedAsset = {
  asset: ProvenanceAsset;
  sha256: string;
};

const reproducedCatalogs = new Map<string, Map<string, ReproducedAsset> | undefined>();

function pathIsWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function canonicalPathIsWithin(root: string, candidate: string): boolean {
  if (safePath(root).status !== "safe" || safePath(candidate).status !== "safe") return false;
  return pathIsWithin(realpathSync(root), realpathSync(candidate));
}

function repositoryRelativePath(root: string, candidate: string): string | undefined {
  const relativePath = relative(resolve(root), resolve(candidate));
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return undefined;
  }
  return relativePath.split(sep).join("/");
}

function collectReproducedAssets(root: string, directory: string, assets: Map<string, ReproducedAsset>): boolean {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!collectReproducedAssets(root, path, assets)) return false;
      continue;
    }
    if (!entry.isFile() || entry.name !== "privacy-manifest.json") continue;
    const manifest = JSON.parse(readFileSync(path, "utf8")) as { assets?: unknown; schemaVersion?: unknown };
    if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.assets)) return false;
    for (const candidate of manifest.assets) {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return false;
      const asset = candidate as ProvenanceAsset;
      if (typeof asset.path !== "string" || asset.path.length === 0 || isAbsolute(asset.path)) return false;
      const assetPath = resolve(dirname(path), asset.path);
      const key = repositoryRelativePath(root, assetPath);
      if (!key || assets.has(key) || !canonicalPathIsWithin(root, assetPath)) return false;
      const metadata = safePath(assetPath);
      if (metadata.status !== "safe" || !metadata.metadata?.isFile()) return false;
      assets.set(key, {
        asset,
        sha256: createHash("sha256").update(readFileSync(assetPath)).digest("hex"),
      });
    }
  }
  return true;
}

function reproduceTrustedGenerator(generatorBytes: Buffer): Map<string, ReproducedAsset> | undefined {
  const generatorHash = createHash("sha256").update(generatorBytes).digest("hex");
  if (reproducedCatalogs.has(generatorHash)) return reproducedCatalogs.get(generatorHash);
  const temporaryRoot = mkdtempSync(join(tmpdir(), "llv-privacy-generator-"));
  let catalog: Map<string, ReproducedAsset> | undefined;
  try {
    const scriptsDirectory = join(temporaryRoot, "scripts");
    mkdirSync(scriptsDirectory, { recursive: true });
    const isolatedGenerator = join(scriptsDirectory, "generate-privacy-placeholders.ts");
    writeFileSync(isolatedGenerator, generatorBytes);
    const generation = Bun.spawnSync({
      cmd: [process.execPath, isolatedGenerator],
      cwd: temporaryRoot,
      env: withoutWakatimeCredential(process.env),
      stderr: "pipe",
      stdout: "pipe",
    });
    if (generation.exitCode === 0) {
      const generatedAssets = new Map<string, ReproducedAsset>();
      if (collectReproducedAssets(temporaryRoot, temporaryRoot, generatedAssets)) catalog = generatedAssets;
    }
  } catch {
    catalog = undefined;
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
  reproducedCatalogs.set(generatorHash, catalog);
  return catalog;
}

function matchesTrustedReproduction(
  path: string,
  generatorPath: string,
  asset: ProvenanceAsset,
  inspectionRoot: string | undefined,
): boolean {
  if (!repositoryRoot || !inspectionRoot || typeof asset.generatorSha256 !== "string") return false;
  const relativeGenerator = repositoryRelativePath(inspectionRoot, generatorPath);
  const relativeAsset = repositoryRelativePath(inspectionRoot, path);
  if (!relativeGenerator || !relativeAsset) return false;
  const trustedGeneratorPath = resolve(repositoryRoot, relativeGenerator);
  if (!canonicalPathIsWithin(repositoryRoot, trustedGeneratorPath)) return false;
  const trustedGenerator = safePath(trustedGeneratorPath);
  if (trustedGenerator.status !== "safe" || !trustedGenerator.metadata?.isFile()) return false;
  const trustedGeneratorBytes = readFileSync(trustedGeneratorPath);
  const trustedHash = createHash("sha256").update(trustedGeneratorBytes).digest("hex");
  if (trustedHash !== asset.generatorSha256) return false;
  const reproduced = reproduceTrustedGenerator(trustedGeneratorBytes)?.get(relativeAsset);
  return reproduced !== undefined
    && reproduced.sha256 === asset.sha256
    && isDeepStrictEqual(reproduced.asset, asset);
}

function assetExistsInTrustedBase(
  manifestPath: string,
  asset: ProvenanceAsset,
  inspectionRoot: string | undefined,
  trustedBase: string | undefined,
): boolean {
  if (!inspectionRoot || !trustedBase || trustedBase.startsWith("--")) return false;
  if (!canonicalPathIsWithin(inspectionRoot, manifestPath)) return false;
  const relativeManifest = relative(resolve(inspectionRoot), resolve(manifestPath));
  if (relativeManifest === "" || relativeManifest === ".." || relativeManifest.startsWith(`..${sep}`) || isAbsolute(relativeManifest)) {
    return false;
  }
  const result = Bun.spawnSync({
    cmd: ["git", "-C", inspectionRoot, "show", `${trustedBase}:${relativeManifest.split(sep).join("/")}`],
    env: withoutWakatimeCredential(process.env),
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) return false;
  try {
    const manifest = JSON.parse(result.stdout.toString()) as { assets?: unknown; schemaVersion?: unknown };
    if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.assets)) return false;
    const trustedAsset = manifest.assets.find((candidate) => {
      return typeof candidate === "object" && candidate !== null
        && (candidate as ProvenanceAsset).path === asset.path;
    });
    return trustedAsset !== undefined && isDeepStrictEqual(trustedAsset, asset);
  } catch {
    return false;
  }
}

function currentRepositoryRoot(): string | undefined {
  const result = Bun.spawnSync({
    cmd: ["git", "rev-parse", "--show-toplevel"],
    env: withoutWakatimeCredential(process.env),
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) return undefined;
  const root = result.stdout.toString().trim();
  return root.length > 0 ? resolve(root) : undefined;
}

const repositoryRoot = currentRepositoryRoot();

function provenanceFor(path: string, inspectionRoot = repositoryRoot, trustedBase?: string): ProvenanceResult {
  const manifestPath = join(dirname(path), "privacy-manifest.json");
  const invalid: ProvenanceResult = { expectedFindingClasses: new Set(), status: "invalid" };
  const manifestPathResult = safePath(manifestPath);
  if (manifestPathResult.status === "missing") return { expectedFindingClasses: new Set(), status: "missing" };
  if (manifestPathResult.status !== "safe" || !manifestPathResult.metadata?.isFile()) return invalid;
  try {
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
    const provenanceRoot = inspectionRoot && canonicalPathIsWithin(inspectionRoot, path) ? inspectionRoot : dirname(manifestPath);
    if (!canonicalPathIsWithin(provenanceRoot, generatorPath)) return invalid;
    const generatorMetadata = safePath(generatorPath);
    if (generatorMetadata.status !== "safe" || !generatorMetadata.metadata?.isFile()) return invalid;
    const generatorBytes = readFileSync(generatorPath);
    if (asset.generatorRuntime !== supportedGeneratorRuntime) return invalid;
    const runtimeVersion = supportedGeneratorRuntime.slice("bun-".length);
    const escapedRuntimeVersion = runtimeVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const runtimeDeclaration = new RegExp(`\\bPRIVACY_GENERATOR_RUNTIME\\s*=\\s*["']${escapedRuntimeVersion}["']`);
    if (!runtimeDeclaration.test(generatorBytes.toString("utf8"))) return invalid;
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
      if (!matchesTrustedReproduction(path, generatorPath, asset, inspectionRoot)) return invalid;
      return { expectedFindingClasses: new Set(), status: "valid" };
    }
    if (!assetExistsInTrustedBase(manifestPath, asset, inspectionRoot, trustedBase)) return invalid;
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

export function inspectPaths(
  paths: string[],
  configurationError = false,
  requireKnownValues = false,
  inspectionRoot = repositoryRoot,
  trustedBase?: string,
): Map<FindingClass, number> {
  const findings = new Map<FindingClass, number>();
  if (knownValues.error || configurationError || (requireKnownValues && knownValues.fingerprints.length === 0)) {
    addFinding(findings, "configuration_error");
  }
  for (const path of paths) {
    const pathResult = safePath(path);
    if (pathResult.status === "symlink" || (pathResult.status === "safe" && !pathResult.metadata?.isFile())) {
      addFinding(findings, "unsafe_path");
      continue;
    }
    if (pathResult.status === "missing" || !pathResult.metadata) {
      addFinding(findings, "inspection_error");
      continue;
    }
    if (pathResult.metadata.size > maxPublicationBytes) {
      addFinding(findings, "inspection_error");
      continue;
    }
    const pathFindings = new Set<FindingClass>();
    const kind = mediaKind(path);
    for (const finding of inspectRasterMetadata(path, kind)) pathFindings.add(finding);
    for (const finding of inspectRaster(path, kind)) pathFindings.add(finding);
    for (const finding of inspectAnimated(path, kind)) pathFindings.add(finding);
    for (const finding of inspectText(path, kind)) pathFindings.add(finding);
    if (kind) {
      const provenance = provenanceFor(path, inspectionRoot, trustedBase);
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
  const repositoryArgument = argumentValue(arguments_, "--repository");
  const inspectionRoot = repositoryArgument ? resolve(repositoryArgument) : (repositoryRoot ?? resolve("."));
  const trustedBase = argumentValue(arguments_, "--base") ?? "origin/main";
  const repositoryPath = safePath(inspectionRoot);
  const repositoryError = repositoryPath.status !== "safe" || !repositoryPath.metadata?.isDirectory();
  const explicitPaths = requestedPaths(arguments_);
  const selection = explicitPaths === undefined
    ? changedPaths(arguments_, inspectionRoot)
    : {
      error: explicitPaths.length === 0,
      paths: explicitPaths.map((path) => isAbsolute(path) ? path : resolve(inspectionRoot, path)),
    };
  reportPrivacyFindings(inspectPaths(
    selection.paths,
    selection.error || repositoryError,
    arguments_.includes("--require-known-values"),
    inspectionRoot,
    trustedBase,
  ));
}
