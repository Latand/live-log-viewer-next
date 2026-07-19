import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { inflateSync } from "node:zlib";

type FindingClass =
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
  | "transcript_content";

type ProvenanceAsset = {
  classification?: unknown;
  description?: unknown;
  expectedFindingClasses?: unknown;
  generator?: unknown;
  path?: unknown;
  sha256?: unknown;
  source?: unknown;
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

function loadKnownValues(): { error: boolean; values: string[] } {
  const values = (process.env.LLV_PRIVACY_KNOWN_VALUES ?? "").split(/\r?\n/);
  const file = process.env.LLV_PRIVACY_KNOWN_VALUES_FILE;
  if (file) {
    try {
      values.push(...readFileSync(file, "utf8").split(/\r?\n/));
    } catch {
      return { error: true, values: [] };
    }
  }
  return {
    error: false,
    values: [...new Set(values.map((value) => value.trim()).filter((value) => value.length >= 4))],
  };
}

const knownValues = loadKnownValues();

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

function hasLiveCaptureMetadata(path: string): boolean {
  if (extname(path).toLowerCase() !== ".png") return false;
  const bytes = readFileSync(path);
  return bytes.includes(Buffer.from("capture-source\0live-", "latin1"));
}

function pngMetadata(bytes: Buffer): { error: boolean; text: string } {
  if (!bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return { error: true, text: "" };
  }
  const values: string[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (length > 16 * 1024 * 1024 || end > bytes.length) return { error: true, text: "" };
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "tEXt") values.push(data.toString("latin1"));
    if (type === "iTXt") values.push(data.toString("utf8"));
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
    offset = end;
    if (type === "IEND") break;
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

function sensitiveClasses(text: string): Set<FindingClass> {
  const findings = new Set<FindingClass>();
  const searchableText = text.replaceAll("\0", "\n");
  const normalizedText = searchableText.toLocaleLowerCase("en-US");
  if (knownValues.values.some((value) => normalizedText.includes(value.toLocaleLowerCase("en-US")))) {
    findings.add("known_value");
  }
  if (/(?:^|[\s"'(])\/(?:home|Users)\/[A-Za-z0-9._-]+(?:\/|$)/m.test(searchableText)) {
    findings.add("home_path");
  }
  if (/(?:^|[\s"'(])[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\|$)/m.test(searchableText)) {
    findings.add("home_path");
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
  const result = Bun.spawnSync({
    cmd: ["tesseract", path, "stdout"],
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
  const probe = Bun.spawnSync({
    cmd: ["ffprobe", "-v", "error", "-show_entries", "format=duration:format_tags", "-of", "json", path],
    stderr: "pipe",
    stdout: "pipe",
  });
  if (probe.exitCode !== 0) return new Set(["inspection_error"]);
  const findings = sensitiveClasses(probe.stdout.toString());
  let duration = 0;
  try {
    const metadata = JSON.parse(probe.stdout.toString()) as { format?: { duration?: unknown } };
    duration = Number(metadata.format?.duration);
    if (!Number.isFinite(duration) || duration < 0) duration = 0;
  } catch {
    return new Set([...findings, "inspection_error"]);
  }
  const sampleTimes = duration > 0
    ? [0, 0.25, 0.5, 0.75, 0.95].map((fraction) => (duration * fraction).toFixed(3))
    : ["0"];
  for (const sampleTime of new Set(sampleTimes)) {
    const frame = Bun.spawnSync({
      cmd: [
        "ffmpeg",
        "-v",
        "error",
        "-ss",
        sampleTime,
        "-i",
        path,
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
      cmd: ["tesseract", "stdin", "stdout"],
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

function provenanceFor(path: string): ProvenanceResult {
  const manifestPath = join(dirname(path), "privacy-manifest.json");
  const invalid: ProvenanceResult = { expectedFindingClasses: new Set(), status: "invalid" };
  if (!existsSync(manifestPath)) return { expectedFindingClasses: new Set(), status: "missing" };
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      assets?: unknown;
      schemaVersion?: unknown;
    };
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets)) return invalid;
    const asset = manifest.assets.find((candidate): candidate is ProvenanceAsset => {
      if (typeof candidate !== "object" || candidate === null) return false;
      return (candidate as ProvenanceAsset).path === basename(path);
    });
    if (!asset) return invalid;
    if (typeof asset.classification !== "string" || !allowedClassifications.has(asset.classification)) return invalid;
    if (typeof asset.description !== "string" || asset.description.trim().length < 12) return invalid;
    if (typeof asset.generator !== "string" || asset.generator.length === 0 || isAbsolute(asset.generator)) return invalid;
    if (!existsSync(resolve(dirname(manifestPath), asset.generator))) return invalid;
    const expectedSource = asset.classification === "redacted-placeholder" ? "redacted-live-capture" : "deterministic-generator";
    if (asset.source !== expectedSource) return invalid;
    if (typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)) return invalid;
    const actualHash = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (actualHash !== asset.sha256) return invalid;
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

function inspect(paths: string[], configurationError = false): Map<FindingClass, number> {
  const findings = new Map<FindingClass, number>();
  if (knownValues.error || configurationError) addFinding(findings, "configuration_error");
  for (const path of paths) {
    if (!existsSync(path)) continue;
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

function report(findings: Map<FindingClass, number>): void {
  if (findings.size === 0) {
    process.stdout.write("PRIVACY GATE: PASS\n");
    return;
  }
  const lines = ["PRIVACY GATE: FAIL"];
  for (const [finding, count] of [...findings].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`${finding}: ${count}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exitCode = 1;
}

const arguments_ = process.argv.slice(2);
const explicitPaths = requestedPaths(arguments_);
const selection = explicitPaths === undefined
  ? changedPaths(arguments_)
  : { error: explicitPaths.length === 0, paths: explicitPaths };
report(inspect(selection.paths, selection.error));
