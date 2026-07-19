import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { auditGithubPublication } from "./privacy-github-audit";
import { formatPrivacyReport } from "./privacy-publication-gate";

const gate = join(import.meta.dir, "privacy-publication-gate.ts");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

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

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function liveCapturePng(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("tEXt", Buffer.from("capture-source\0live-runtime", "latin1")),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 255, 255]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function redactedPlaceholderPng(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("tEXt", Buffer.from("capture-source\0redacted-placeholder", "latin1")),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 245, 247, 250]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngWithMetadata(value: string): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("tEXt", Buffer.from(`comment\0${value}`, "latin1")),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 245, 247, 250]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngWithCustomMetadata(type: "eXIf" | "iCCP" | "iTXt" | "zTXt", value: string): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  let metadata: Buffer;
  if (type === "zTXt") {
    metadata = Buffer.concat([Buffer.from("comment\0\0", "latin1"), deflateSync(Buffer.from(value, "utf8"))]);
  } else if (type === "iCCP") {
    metadata = Buffer.concat([Buffer.from("synthetic-profile\0\0", "latin1"), deflateSync(Buffer.from(value, "utf8"))]);
  } else if (type === "iTXt") {
    metadata = Buffer.concat([
      Buffer.from("comment\0\x01\x00\0\0", "latin1"),
      deflateSync(Buffer.from(value, "utf8")),
    ]);
  } else {
    metadata = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from(value, "utf8")]);
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk(type, metadata),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 245, 247, 250]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngWithTrailingPayload(value: string): Buffer {
  return Buffer.concat([redactedPlaceholderPng(), Buffer.from(value, "utf8")]);
}

function writeValidProvenance(directory: string, name: string, contents: Buffer): void {
  const generator = Buffer.from('export const PRIVACY_GENERATOR_VERSION = "fixture-generator-v2";\n');
  writeFileSync(join(directory, "generate-placeholder.mjs"), generator);
  writeFileSync(join(directory, "privacy-manifest.json"), JSON.stringify({
    schemaVersion: 2,
    assets: [{
      path: name,
      classification: "redacted-placeholder",
      source: "redacted-live-capture",
      generator: "generate-placeholder.mjs",
      generatorVersion: "fixture-generator-v2",
      generatorSha256: createHash("sha256").update(generator).digest("hex"),
      sourceDigests: [createHash("sha256").update(`fixture-source:${name}`).digest("hex")],
      description: "Synthetic redacted placeholder used by the privacy gate test.",
      sha256: createHash("sha256").update(contents).digest("hex"),
    }],
  }));
}

function installTool(directory: string, name: string, body = "exit 0"): Record<string, string> {
  const executable = join(directory, name);
  writeFileSync(executable, `#!/bin/sh\n${body}\n`);
  chmodSync(executable, 0o755);
  return { PATH: `${directory}:${process.env.PATH ?? ""}` };
}

function runGateArguments(arguments_: string[], environment: Record<string, string> = {}, cwd = join(import.meta.dir, "..")) {
  return Bun.spawnSync({
    cmd: [process.execPath, gate, ...arguments_],
    cwd,
    env: { ...process.env, ...environment, NO_COLOR: "1" },
    stderr: "pipe",
    stdout: "pipe",
  });
}

function runGate(paths: string[], environment: Record<string, string> = {}) {
  return runGateArguments(["--paths", ...paths], environment);
}

function runGit(directory: string, arguments_: string[]): void {
  const result = Bun.spawnSync({ cmd: ["git", ...arguments_], cwd: directory, stderr: "pipe", stdout: "pipe" });
  expect(result.exitCode).toBe(0);
}

describe("privacy publication gate", () => {
  test("blocks an unsafe live raster without provenance using redacted diagnostics", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const image = join(directory, "capture.png");
    writeFileSync(image, liveCapturePng());

    const result = runGate([image], installTool(directory, "tesseract"));
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe([
      "PRIVACY GATE: FAIL",
      "media_live_source: 1",
      "provenance_missing: 1",
      "",
    ].join("\n"));
    expect(output).not.toContain("live-runtime");
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects provenance that does not declare the published raster", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const image = join(directory, "capture.png");
    writeFileSync(image, redactedPlaceholderPng());
    writeFileSync(join(directory, "privacy-manifest.json"), JSON.stringify({ schemaVersion: 1, assets: [] }));

    const result = runGate([image], installTool(directory, "tesseract"));

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\nprovenance_invalid: 1\n");
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects output-only provenance without source and generator bindings", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const image = join(directory, "capture.png");
    const contents = redactedPlaceholderPng();
    writeFileSync(image, contents);
    writeFileSync(join(directory, "generate-placeholder.mjs"), "// Legacy generator without a version binding.\n");
    writeFileSync(join(directory, "privacy-manifest.json"), JSON.stringify({
      schemaVersion: 1,
      assets: [{
        path: "capture.png",
        classification: "redacted-placeholder",
        source: "redacted-live-capture",
        generator: "generate-placeholder.mjs",
        description: "Legacy output-only provenance fixture for the privacy gate test.",
        sha256: createHash("sha256").update(contents).digest("hex"),
      }],
    }));

    const result = runGate([image], installTool(directory, "tesseract"));

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\nprovenance_invalid: 1\n");
    expect(result.stderr.toString()).toBe("");
  });

  test("regenerates source-bound placeholders deterministically", () => {
    const repositoryRoot = join(import.meta.dir, "..");
    const image = join(repositoryRoot, "docs", "acceptance", "issue-290", "readiness-kanban.png");
    const manifestPath = join(repositoryRoot, "docs", "acceptance", "issue-290", "privacy-manifest.json");
    const committedImageDigest = createHash("sha256").update(readFileSync(image)).digest("hex");
    const committedManifestDigest = createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
    const regenerate = () => Bun.spawnSync({
      cmd: [process.execPath, join(import.meta.dir, "generate-privacy-placeholders.ts")],
      cwd: repositoryRoot,
      stderr: "pipe",
      stdout: "pipe",
    });

    const first = regenerate();
    const firstImageDigest = createHash("sha256").update(readFileSync(image)).digest("hex");
    const firstManifestDigest = createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
    const second = regenerate();
    const secondImageDigest = createHash("sha256").update(readFileSync(image)).digest("hex");
    const secondManifestDigest = createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      assets?: Array<Record<string, unknown>>;
      schemaVersion?: unknown;
    };

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.stderr.toString()).toBe("");
    expect(second.stderr.toString()).toBe("");
    expect(committedImageDigest).toBe(firstImageDigest);
    expect(committedManifestDigest).toBe(firstManifestDigest);
    expect(firstImageDigest).toBe(secondImageDigest);
    expect(firstManifestDigest).toBe(secondManifestDigest);
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.assets?.[0]?.generatorRuntime).toBe("bun-1.3.3");
    expect(manifest.assets?.[0]?.generatorVersion).toBe("privacy-placeholders-v2");
    expect(manifest.assets?.[0]?.generatorSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.assets?.[0]?.sourceDigests).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
  });

  test("detects private text in raster pixels without echoing OCR content", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const image = join(directory, "capture.png");
    const contents = redactedPlaceholderPng();
    writeFileSync(image, contents);
    writeValidProvenance(directory, "capture.png", contents);
    const syntheticHome = ["", "home", "fixture-operator", "private"].join("/");

    const result = runGate([image], installTool(directory, "tesseract", `printf '%s\\n' '${syntheticHome}'`));
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\n");
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("scans changed text for private paths, addresses, and credential shapes", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "release-notes.md");
    const syntheticHome = ["", "home", "fixture-person", "records"].join("/");
    const syntheticAddress = ["fixture-person", "internal.local"].join("@");
    const syntheticCredential = ["api", "token"].join("_") + "=synthetic-test-value-1234567890";
    writeFileSync(text, [syntheticHome, syntheticAddress, syntheticCredential].join("\n"));

    const result = runGate([text]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe([
      "PRIVACY GATE: FAIL",
      "credential: 1",
      "email_address: 1",
      "home_path: 1",
      "",
    ].join("\n"));
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(syntheticAddress);
    expect(output).not.toContain(syntheticCredential);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("fails closed when required known-value fingerprints are unavailable", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "release-notes.md");
    writeFileSync(text, "Synthetic release evidence.\n");

    const result = runGateArguments(["--require-known-values", "--paths", text], {
      LLV_PRIVACY_KNOWN_VALUES: "",
      LLV_PRIVACY_KNOWN_VALUES_FILE: "",
      LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: "",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\nconfiguration_error: 1\n");
    expect(result.stderr.toString()).toBe("");
  });

  test("normalizes links, HTML forms, percent encoding, and split tokens", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "publication.md");
    const fingerprints = join(directory, "known-values.json");
    const knownLabel = "fixture-private-project-label";
    const compactKnownLabel = knownLabel.replaceAll(/[^a-z0-9]/g, "");
    writeFileSync(fingerprints, JSON.stringify({
      schemaVersion: 1,
      normalization: "nfkc-lower-alnum-v1",
      fingerprints: [{
        length: compactKnownLabel.length,
        sha256: createHash("sha256").update(compactKnownLabel).digest("hex"),
      }],
    }));
    const splitKnownLabel = "fixture-<span>private</span>-project-**label**";
    const percentSlash = String.fromCharCode(37, 50, 70);
    const encodedHome = ["", "home", "fixture-person", "records"].join("/").replaceAll("/", encodeURIComponent(percentSlash));
    const splitToken = `${String.fromCharCode(103)} ${String.fromCharCode(104)} ${String.fromCharCode(112)} _ syntheticfixturecredential123456`;
    const passwordInput = ['<form><in', 'put type="password" value="synthetic-form-credential-123456"></form>'].join("");
    const encodedPasswordInput = passwordInput.replace("<", "&lt;");
    const authorizationHeader = ["Author", "ization: Bear", "er syntheticfixturecredential123456"].join("");
    const authenticatedUrl = ["https://fixture-user:", "synthetic-password-123456", "@example.invalid"].join("");
    writeFileSync(text, [
      `[evidence](https://example.invalid/${encodedHome})`,
      splitKnownLabel,
      encodedPasswordInput,
      splitToken,
      authorizationHeader,
      authenticatedUrl,
    ].join("\n"));

    const result = runGate([text], {
      LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: fingerprints,
    });
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe([
      "PRIVACY GATE: FAIL",
      "credential: 1",
      "home_path: 1",
      "known_value: 1",
      "",
    ].join("\n"));
    expect(output).not.toContain(knownLabel);
    expect(output).not.toContain(encodedHome);
    expect(output).not.toContain(splitToken);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("matches fingerprinted labels inside HTML attributes", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "publication.html");
    const fingerprints = join(directory, "known-values.json");
    const knownLabel = ["fixture", "private", "attribute", "label"].join("-");
    const compactKnownLabel = knownLabel.replaceAll("-", "");
    writeFileSync(fingerprints, JSON.stringify({
      schemaVersion: 1,
      normalization: "nfkc-lower-alnum-v1",
      fingerprints: [{
        length: compactKnownLabel.length,
        sha256: createHash("sha256").update(compactKnownLabel).digest("hex"),
      }],
    }));
    writeFileSync(text, `<div data-project="${knownLabel}">Synthetic evidence</div>\n`);

    const result = runGate([text], {
      LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: fingerprints,
    });
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nknown_value: 1\n");
    expect(output).not.toContain(knownLabel);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("keeps malformed HTML entities inside class-only inspection", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "publication.html");
    writeFileSync(text, "Synthetic entity &#99999999; remains inert.\n");

    const result = runGate([text]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: PASS\n");
    expect(result.stderr.toString()).toBe("");
  });

  test("generates a value-free fingerprint catalog from an operator file", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const input = join(directory, "known-values.txt");
    const output = join(directory, "fingerprints.json");
    const knownLabel = ["fixture", "private", "catalog", "label"].join("-");
    writeFileSync(input, `${knownLabel}\n`);

    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        join(import.meta.dir, "generate-privacy-known-value-fingerprints.ts"),
        "--input",
        input,
        "--output",
        output,
      ],
      stderr: "pipe",
      stdout: "pipe",
    });
    const catalog = readFileSync(output, "utf8");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("FINGERPRINT CATALOG: PASS\nfingerprint_count: 1\n");
    expect(result.stderr.toString()).toBe("");
    expect(catalog).not.toContain(knownLabel);
    expect(catalog).toContain(createHash("sha256").update(knownLabel.replaceAll("-", "")).digest("hex"));
  });

  test("rejects symlink publication inputs without reading their targets", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "private-target.txt");
    const link = join(directory, "publication.md");
    const syntheticHome = ["", "home", "fixture-person", "records"].join("/");
    writeFileSync(target, `${syntheticHome}\n`);
    symlinkSync(target, link);

    const result = runGate([link]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nunsafe_path: 1\n");
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("samples GIF and video frames while keeping decoded content private", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const animation = join(directory, "capture.gif");
    const contents = Buffer.from("deterministic synthetic animation fixture");
    writeFileSync(animation, contents);
    writeValidProvenance(directory, "capture.gif", contents);
    const counter = join(directory, "sample-count");
    const syntheticHome = ["", "Users", "fixture-person", "records"].join("/");
    installTool(directory, "ffprobe", `printf '%s' '{"format":{"duration":"8","tags":{}}}'`);
    installTool(directory, "ffmpeg", "printf '%s' 'synthetic-frame'");
    const environment = installTool(directory, "tesseract", `printf x >> "$FRAME_COUNTER"\nprintf '%s\\n' '${syntheticHome}'`);

    const result = runGate([animation], { ...environment, FRAME_COUNTER: counter });
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\n");
    expect(readFileSync(counter, "utf8")).toHaveLength(5);
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("samples representative frame indexes when video duration is unknown", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const animation = join(directory, "capture.mp4");
    const contents = Buffer.from("deterministic synthetic unknown-duration video fixture");
    writeFileSync(animation, contents);
    writeValidProvenance(directory, "capture.mp4", contents);
    const counter = join(directory, "sample-count");
    const syntheticHome = ["", "Users", "fixture-person", "records"].join("/");
    installTool(directory, "ffprobe", `printf '%s' '{"format":{"duration":"N/A","tags":{}},"streams":[{"nb_read_frames":"240"}]}'`);
    installTool(directory, "ffmpeg", `printf x >> "$FRAME_COUNTER"\nprintf '%s' 'synthetic-frame'`);
    const environment = installTool(directory, "tesseract", `printf '%s\n' '${syntheticHome}'`);

    const result = runGate([animation], { ...environment, FRAME_COUNTER: counter });
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\n");
    expect(readFileSync(counter, "utf8")).toHaveLength(5);
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("passes configured multilingual OCR languages to raster inspection", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const image = join(directory, "capture.png");
    const contents = redactedPlaceholderPng();
    writeFileSync(image, contents);
    writeValidProvenance(directory, "capture.png", contents);
    const argumentsFile = join(directory, "ocr-arguments");
    const syntheticHome = ["", "home", "fixture-person", "records"].join("/");
    const environment = installTool(directory, "tesseract", `printf '%s' "$*" > "$OCR_ARGUMENTS"\nprintf '%s\n' '${syntheticHome}'`);

    const result = runGate([image], {
      ...environment,
      LLV_PRIVACY_OCR_LANGUAGES: "eng+ukr",
      OCR_ARGUMENTS: argumentsFile,
    });
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\n");
    expect(readFileSync(argumentsFile, "utf8")).toContain("-l eng+ukr");
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("matches operator-provided private labels without publishing them", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "release-notes.md");
    const privateLabel = ["fixture", "private", "project", "label"].join("-");
    writeFileSync(text, `Evidence for ${privateLabel}.\n`);

    const result = runGate([text], { LLV_PRIVACY_KNOWN_VALUES: privateLabel });
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nknown_value: 1\n");
    expect(output).not.toContain(privateLabel);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("discovers publication changes relative to the requested Git base", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    runGit(directory, ["init", "--quiet"]);
    runGit(directory, ["config", "user.name", "Synthetic Fixture"]);
    runGit(directory, ["config", "user.email", "fixture@example.invalid"]);
    const notes = join(directory, "release-notes.md");
    writeFileSync(notes, "Synthetic release evidence.\n");
    runGit(directory, ["add", "release-notes.md"]);
    runGit(directory, ["commit", "--quiet", "-m", "fixture baseline"]);
    const baseResult = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: directory, stdout: "pipe" });
    const base = baseResult.stdout.toString().trim();
    const syntheticHome = ["", "home", "fixture-person", "records"].join("/");
    writeFileSync(notes, `Synthetic release evidence.\n${syntheticHome}\n`);

    const result = runGateArguments(["--base", base], {}, directory);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\n");
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("allows checksum-bound adversarial synthetic fixtures with declared classes", () => {
    const root = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(root);
    const directory = join(root, "privacy-fixtures");
    mkdirSync(directory);
    const image = join(directory, "synthetic-path.png");
    const contents = redactedPlaceholderPng();
    writeFileSync(image, contents);
    const generator = Buffer.from('export const PRIVACY_GENERATOR_VERSION = "fixture-generator-v2";\n');
    writeFileSync(join(directory, "generate-fixture.mjs"), generator);
    writeFileSync(join(directory, "privacy-manifest.json"), JSON.stringify({
      schemaVersion: 2,
      assets: [{
        path: "synthetic-path.png",
        classification: "adversarial-synthetic",
        source: "deterministic-generator",
        generator: "generate-fixture.mjs",
        generatorVersion: "fixture-generator-v2",
        generatorSha256: createHash("sha256").update(generator).digest("hex"),
        sourceDigests: [createHash("sha256").update("adversarial-fixture-source").digest("hex")],
        description: "Synthetic adversarial raster for path-detection regression coverage.",
        expectedFindingClasses: ["home_path"],
        sha256: createHash("sha256").update(contents).digest("hex"),
      }],
    }));
    const syntheticHome = ["", "home", "fixture-person", "records"].join("/");

    const result = runGate([image], installTool(directory, "tesseract", `printf '%s\\n' '${syntheticHome}'`));
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(output).toBe("PRIVACY GATE: PASS\n");
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects symlink manifests and provenance generators", () => {
    const root = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(root);
    const contents = redactedPlaceholderPng();
    const externalManifest = join(root, "external-manifest.json");
    const manifestLinkDirectory = join(root, "manifest-link");
    mkdirSync(manifestLinkDirectory);
    const manifestLinkImage = join(manifestLinkDirectory, "capture.png");
    writeFileSync(manifestLinkImage, contents);
    const generator = Buffer.from('export const PRIVACY_GENERATOR_VERSION = "fixture-generator-v2";\n');
    writeFileSync(join(manifestLinkDirectory, "generate-placeholder.mjs"), generator);
    writeFileSync(externalManifest, JSON.stringify({
      schemaVersion: 2,
      assets: [{
        path: "capture.png",
        classification: "redacted-placeholder",
        source: "redacted-live-capture",
        generator: "generate-placeholder.mjs",
        generatorVersion: "fixture-generator-v2",
        generatorSha256: createHash("sha256").update(generator).digest("hex"),
        sourceDigests: [createHash("sha256").update("fixture-source").digest("hex")],
        description: "Synthetic provenance fixture with a linked manifest.",
        sha256: createHash("sha256").update(contents).digest("hex"),
      }],
    }));
    symlinkSync(externalManifest, join(manifestLinkDirectory, "privacy-manifest.json"));

    const generatorLinkDirectory = join(root, "generator-link");
    mkdirSync(generatorLinkDirectory);
    const generatorLinkImage = join(generatorLinkDirectory, "capture.png");
    writeFileSync(generatorLinkImage, contents);
    writeValidProvenance(generatorLinkDirectory, "capture.png", contents);
    const regularGenerator = join(generatorLinkDirectory, "generate-placeholder.mjs");
    const externalGenerator = join(root, "external-generator.mjs");
    writeFileSync(externalGenerator, readFileSync(regularGenerator));
    rmSync(regularGenerator);
    symlinkSync(externalGenerator, regularGenerator);

    const result = runGate(
      [manifestLinkImage, generatorLinkImage],
      installTool(root, "tesseract"),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\nprovenance_invalid: 2\n");
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects provenance generators outside the asset boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(root);
    const directory = join(root, "published");
    mkdirSync(directory);
    const image = join(directory, "capture.png");
    const contents = redactedPlaceholderPng();
    writeFileSync(image, contents);
    const generator = Buffer.from('export const PRIVACY_GENERATOR_VERSION = "fixture-generator-v2";\n');
    const externalGenerator = join(root, "external-generator.mjs");
    writeFileSync(externalGenerator, generator);
    writeFileSync(join(directory, "privacy-manifest.json"), JSON.stringify({
      schemaVersion: 2,
      assets: [{
        path: "capture.png",
        classification: "redacted-placeholder",
        source: "redacted-live-capture",
        generator: "../external-generator.mjs",
        generatorVersion: "fixture-generator-v2",
        generatorSha256: createHash("sha256").update(generator).digest("hex"),
        sourceDigests: [createHash("sha256").update("fixture-source").digest("hex")],
        description: "Synthetic provenance fixture with an external generator.",
        sha256: createHash("sha256").update(contents).digest("hex"),
      }],
    }));

    const result = runGate([image], installTool(root, "tesseract"));

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\nprovenance_invalid: 1\n");
    expect(result.stderr.toString()).toBe("");
  });

  test("requires a dedicated generator version declaration", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const image = join(directory, "capture.png");
    const contents = redactedPlaceholderPng();
    writeFileSync(image, contents);
    const generator = Buffer.from('export const packageMetadata = { version: "fixture-generator-v2" };\n');
    writeFileSync(join(directory, "generate-placeholder.mjs"), generator);
    writeFileSync(join(directory, "privacy-manifest.json"), JSON.stringify({
      schemaVersion: 2,
      assets: [{
        path: "capture.png",
        classification: "redacted-placeholder",
        source: "redacted-live-capture",
        generator: "generate-placeholder.mjs",
        generatorVersion: "fixture-generator-v2",
        generatorSha256: createHash("sha256").update(generator).digest("hex"),
        sourceDigests: [createHash("sha256").update("fixture-source").digest("hex")],
        description: "Synthetic provenance fixture with a generic version string.",
        sha256: createHash("sha256").update(contents).digest("hex"),
      }],
    }));

    const result = runGate([image], installTool(directory, "tesseract"));

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\nprovenance_invalid: 1\n");
    expect(result.stderr.toString()).toBe("");
  });

  test("classifies private network, resource, and transcript-shaped media text", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const image = join(directory, "capture.png");
    const contents = redactedPlaceholderPng();
    writeFileSync(image, contents);
    writeValidProvenance(directory, "capture.png", contents);
    const syntheticAddress = [10, 23, 45, 67].join(".");
    const syntheticIdentifier = ["12345678", "1234", "4abc", "8def", "123456789abc"].join("-");
    const transcriptMarker = ["trans", "cript"].join("") + ": synthetic fixture utterance";
    const ocr = [syntheticAddress, syntheticIdentifier, transcriptMarker].join("\\n");

    const result = runGate([image], installTool(directory, "tesseract", `printf '%b\\n' '${ocr}'`));
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe([
      "PRIVACY GATE: FAIL",
      "private_network: 1",
      "resource_identifier: 1",
      "transcript_content: 1",
      "",
    ].join("\n"));
    expect(output).not.toContain(syntheticAddress);
    expect(output).not.toContain(syntheticIdentifier);
    expect(output).not.toContain(transcriptMarker);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("scans embedded raster metadata independently from OCR", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const image = join(directory, "capture.png");
    const syntheticHome = ["", "home", "fixture-person", "metadata"].join("/");
    const contents = pngWithMetadata(syntheticHome);
    writeFileSync(image, contents);
    writeValidProvenance(directory, "capture.png", contents);

    const result = runGate([image], installTool(directory, "tesseract"));
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\n");
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("scans compressed PNG text, eXIf, and trailing payloads", () => {
    const root = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(root);
    const syntheticHome = ["", "home", "fixture-person", "metadata"].join("/");
    const images: string[] = [];
    const fixtures: Array<[string, Buffer]> = [
      ["ztxt", pngWithCustomMetadata("zTXt", syntheticHome)],
      ["itxt", pngWithCustomMetadata("iTXt", syntheticHome)],
      ["iccp", pngWithCustomMetadata("iCCP", syntheticHome)],
      ["exif", pngWithCustomMetadata("eXIf", syntheticHome)],
      ["trailing", pngWithTrailingPayload(syntheticHome)],
    ];
    for (const [name, contents] of fixtures) {
      const directory = join(root, name);
      mkdirSync(directory);
      const image = join(directory, "capture.png");
      writeFileSync(image, contents);
      writeValidProvenance(directory, "capture.png", contents);
      images.push(image);
    }

    const result = runGate(images, installTool(root, "tesseract"));
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 5\n");
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(root);
    expect(result.stderr.toString()).toBe("");
  });

  test("audits authenticated GitHub issue, PR, comment, review, and media surfaces", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const originalOcrLanguages = process.env.LLV_PRIVACY_OCR_LANGUAGES;
    const syntheticHome = ["", "home", "fixture-person", "tracker"].join("/");
    const encodedHome = syntheticHome.replaceAll("/", "%2F");
    const syntheticIdentifier = ["12345678", "1234", "4abc", "8def", "123456789abc"].join("-");
    const media = pngWithCustomMetadata("eXIf", syntheticHome);
    const token = ["synthetic", "github", "audit", "token"].join("-");
    const passwordInput = ['<form><in', 'put name=token value=synthetic-form-credential-123456></form>'].join("");
    const transcriptMarker = ["trans", "cript"].join("") + ": synthetic fixture utterance";
    const requests: Array<{ authorization: string | null; url: string }> = [];
    const languageResult = Bun.spawnSync({ cmd: ["tesseract", "--list-langs"], stderr: "pipe", stdout: "pipe" });
    const ocrLanguage = languageResult.stdout.toString().split(/\r?\n/).find((language) => /^[a-z0-9_]+$/i.test(language) && language !== "osd");
    process.env.LLV_PRIVACY_OCR_LANGUAGES = ocrLanguage ?? "missing-test-language";
    const fetcher = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input);
      requests.push({ authorization: new Headers(init?.headers).get("authorization"), url: url.href });
      if (url.hostname === "github.com") {
        return new Response(Uint8Array.from(media), { headers: { "content-type": "image/png" } });
      }
      if (url.pathname.endsWith("/issues/456")) {
        return Response.json({ body: "", pull_request: {} });
      }
      if (url.pathname.endsWith("/issues/456/comments")) {
        return Response.json([{ body: `[encoded](${encodedHome})` }]);
      }
      if (url.pathname.endsWith("/pulls/456")) {
        const mediaUrl = "https://github.com/example/repository/assets/synthetic(media).png";
        return Response.json({
          body: [
            passwordInput,
            `![evidence](<${mediaUrl}>)`,
            `<img src=${mediaUrl}>`,
          ].join("\n"),
        });
      }
      if (url.pathname.endsWith("/pulls/456/comments")) {
        return Response.json([{ body: transcriptMarker }]);
      }
      if (url.pathname.endsWith("/pulls/456/reviews")) {
        return Response.json([{ body: `Synthetic resource ${syntheticIdentifier}` }]);
      }
      return new Response(null, { status: 404 });
    };

    try {
      const findings = await auditGithubPublication({
        apiUrl: "https://api.github.test/",
        fetcher,
        number: 456,
        repo: "example/repository",
        requireKnownValues: false,
        token,
      });
      const output = formatPrivacyReport(findings);

      expect(output).toBe([
        "PRIVACY GATE: FAIL",
        "credential: 1",
        "home_path: 2",
        "provenance_missing: 1",
        "resource_identifier: 1",
        "transcript_content: 1",
        "",
      ].join("\n"));
      expect(requests).toHaveLength(6);
      expect(requests.every((request) => request.authorization === `Bearer ${token}`)).toBe(true);
      expect(requests.some((request) => request.url.includes("/issues/456/comments"))).toBe(true);
      expect(requests.some((request) => request.url.includes("/pulls/456/comments"))).toBe(true);
      expect(requests.some((request) => request.url.includes("/pulls/456/reviews"))).toBe(true);
      expect(output).not.toContain(syntheticHome);
      expect(output).not.toContain(syntheticIdentifier);
      expect(output).not.toContain(token);
      expect(output).not.toContain(directory);
    } finally {
      if (originalOcrLanguages === undefined) delete process.env.LLV_PRIVACY_OCR_LANGUAGES;
      else process.env.LLV_PRIVACY_OCR_LANGUAGES = originalOcrLanguages;
    }
  });

  test("fails the GitHub audit closed when authentication is unavailable", async () => {
    let requestCount = 0;
    const findings = await auditGithubPublication({
      fetcher: async () => {
        requestCount += 1;
        return new Response(null, { status: 500 });
      },
      number: 456,
      repo: "example/repository",
      requireKnownValues: false,
      token: "",
    });

    expect(formatPrivacyReport(findings)).toBe("PRIVACY GATE: FAIL\nconfiguration_error: 1\n");
    expect(requestCount).toBe(0);
  });

  test("blocks untrusted publication media URLs before network access", async () => {
    const requests: string[] = [];
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = new URL(input);
      requests.push(url.href);
      if (url.pathname.endsWith("/issues/448")) {
        return Response.json({ body: "![evidence](http://127.0.0.2/private.png)" });
      }
      if (url.pathname.endsWith("/issues/448/comments")) return Response.json([]);
      return new Response(null, { status: 500 });
    };

    const findings = await auditGithubPublication({
      apiUrl: "https://api.github.test/",
      fetcher,
      number: 448,
      repo: "example/repository",
      requireKnownValues: false,
      token: "synthetic-github-audit-token",
    });

    expect(formatPrivacyReport(findings)).toBe("PRIVACY GATE: FAIL\ninspection_error: 1\n");
    expect(requests).toHaveLength(2);
    expect(requests.every((url) => url.startsWith("https://api.github.test/"))).toBe(true);
  });
});
