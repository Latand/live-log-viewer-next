import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function syntheticFineGrainedPat(): string {
  return `${[["git", "hub"].join(""), "pat"].join("_")}_${"A".repeat(82)}`;
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

function compressedLiveCapturePng(type: "iTXt" | "zTXt"): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk(type, Buffer.concat([
      Buffer.from(type === "zTXt" ? "capture-source\0\0" : "capture-source\0\x01\x00\0\0", "latin1"),
      deflateSync(Buffer.from("live-runtime", "latin1")),
    ])),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 255, 255]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function animatedPng(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(2, 0);
  const frameControl = (sequence: number) => {
    const control = Buffer.alloc(26);
    control.writeUInt32BE(sequence, 0);
    control.writeUInt32BE(1, 4);
    control.writeUInt32BE(1, 8);
    control.writeUInt16BE(1, 20);
    control.writeUInt16BE(10, 22);
    return control;
  };
  const secondFrame = Buffer.alloc(4);
  secondFrame.writeUInt32BE(2);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("acTL", animation),
    pngChunk("fcTL", frameControl(0)),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 245, 247, 250]))),
    pngChunk("fcTL", frameControl(1)),
    pngChunk("fdAT", Buffer.concat([secondFrame, deflateSync(Buffer.from([0, 255, 255, 255]))])),
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

function oddAlignedUtf16(value: string, byteOrder: "be" | "le"): Buffer {
  const encoded = Buffer.from(value, "utf16le");
  if (byteOrder === "be") encoded.swap16();
  return Buffer.concat([Buffer.from([0x7f]), encoded]);
}

function pngWithExifBytes(data: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("eXIf", data),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 245, 247, 250]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function writeValidProvenance(directory: string, name: string, contents: Buffer): void {
  const generator = Buffer.from([
    'export const PRIVACY_GENERATOR_RUNTIME = "1.3.3";',
    'export const PRIVACY_GENERATOR_VERSION = "fixture-generator-v2";',
    "",
  ].join("\n"));
  writeFileSync(join(directory, "generate-placeholder.mjs"), generator);
  writeFileSync(join(directory, "privacy-manifest.json"), JSON.stringify({
    schemaVersion: 2,
    assets: [{
      path: name,
      classification: "redacted-placeholder",
      source: "redacted-live-capture",
      generator: "generate-placeholder.mjs",
      generatorRuntime: "bun-1.3.3",
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

function writeFingerprintCatalog(path: string, value: string): void {
  const compact = value.normalize("NFKC").toLocaleLowerCase("en-US").replaceAll(/[^\p{L}\p{N}]/gu, "");
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    normalization: "nfkc-lower-alnum-v1",
    fingerprints: [{
      length: compact.length,
      sha256: createHash("sha256").update(compact).digest("hex"),
    }],
  }));
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

  for (const metadataType of ["zTXt", "iTXt"] as const) {
    test(`detects live-source metadata inside compressed PNG ${metadataType}`, () => {
      const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
      temporaryDirectories.push(directory);
      const image = join(directory, "capture.png");
      writeFileSync(image, compressedLiveCapturePng(metadataType));

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
  }

  test("fails closed for animated PNG publication input", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const image = join(directory, "capture.png");
    const contents = animatedPng();
    writeFileSync(image, contents);
    writeValidProvenance(directory, "capture.png", contents);

    const result = runGate([image], installTool(directory, "tesseract"));
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\ninspection_error: 1\nprovenance_invalid: 1\n");
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

  test("accepts media reproduced by the trusted source-bound generator", () => {
    const toolsDirectory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(toolsDirectory);
    const repositoryRoot = join(import.meta.dir, "..");
    const image = join(repositoryRoot, "docs", "acceptance", "issue-290", "readiness-kanban.png");

    const result = runGate([image], installTool(toolsDirectory, "tesseract"));

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: PASS\n");
    expect(result.stderr.toString()).toBe("");
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
    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_invalid: 1\n");
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

  test("detects a plain fine-grained GitHub PAT without exposing it", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "publication.md");
    const token = syntheticFineGrainedPat();
    writeFileSync(text, token);

    const result = runGate([text]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\ncredential: 1\n");
    expect(output).not.toContain(token);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("detects a percent-encoded fine-grained GitHub PAT without exposing it", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "publication.md");
    const token = syntheticFineGrainedPat();
    const encodedToken = [...token]
      .map((character) => `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`)
      .join("");
    writeFileSync(text, encodedToken);

    const result = runGate([text]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\ncredential: 1\n");
    expect(output).not.toContain(token);
    expect(output).not.toContain(encodedToken);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("detects a separator-split fine-grained GitHub PAT without exposing it", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const text = join(directory, "publication.md");
    const token = syntheticFineGrainedPat();
    const splitToken = [...token].join(" ");
    writeFileSync(text, splitToken);

    const result = runGate([text]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\ncredential: 1\n");
    expect(output).not.toContain(token);
    expect(output).not.toContain(splitToken);
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

  const canonicalizationFixtures = [
    {
      expected: "home_path",
      name: "mixed entity and percent encoding",
      publication: () => `${"&#37;26&#37;23x2f&#37;3B"}home&#37;26&#37;23x2f&#37;3Bfixture-person&#37;26&#37;23x2f&#37;3Brecords`,
    },
    {
      expected: "home_path",
      name: "four-layer percent encoding",
      publication: () => {
        let encoded = ["", "home", "fixture-person", "records"].join("/");
        for (let pass = 0; pass < 4; pass += 1) encoded = encodeURIComponent(encoded);
        return encoded;
      },
    },
    {
      expected: "home_path",
      name: "CommonMark escaped slashes",
      publication: () => ["", "home", "fixture-person", "records"].join("\\/"),
    },
    {
      expected: "known_value",
      name: "newline-split known values",
      publication: () => ["fixture", process.pid, "newline", "known", "label"].join("\n"),
      value: () => ["fixture", process.pid, "newline", "known", "label"].join("-"),
    },
    {
      expected: "home_path",
      name: "lowercase Windows home paths",
      publication: () => ["c:", "users", "fixture-person", "records"].join("\\"),
    },
    {
      expected: "private_network",
      name: "GFM HTML5 named entities",
      publication: () => ["192", "168", "12", "34"].join("&period;"),
    },
    {
      expected: "private_network",
      name: "GFM underscore emphasis",
      publication: () => ["192", "_168_", "12", "34"].join("."),
    },
  ];

  for (const fixture of canonicalizationFixtures) {
    test(`canonicalizes ${fixture.name} with class-only diagnostics`, () => {
      const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
      temporaryDirectories.push(directory);
      const publication = fixture.publication();
      const text = join(directory, "publication.md");
      writeFileSync(text, `${publication}\n`);
      const environment: Record<string, string> = {};
      if (fixture.value) {
        const fingerprints = join(directory, "known-values.json");
        writeFingerprintCatalog(fingerprints, fixture.value());
        environment.LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE = fingerprints;
      }

      const result = runGate([text], environment);
      const output = result.stdout.toString();

      expect(result.exitCode).toBe(1);
      expect(output).toBe(`PRIVACY GATE: FAIL\n${fixture.expected}: 1\n`);
      expect(output).not.toContain(publication);
      expect(output).not.toContain(directory);
      expect(result.stderr.toString()).toBe("");
    });
  }

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

  const encodedTextFixtures = [
    {
      expected: "home_path",
      name: "NUL-prefixed text",
      value: () => Buffer.concat([
        Buffer.from([0]),
        Buffer.from(["", "home", "fixture-person", "records"].join("/")),
      ]),
    },
    {
      expected: "home_path",
      name: "embedded-NUL text",
      value: () => Buffer.concat([
        Buffer.from("Synthetic prefix"),
        Buffer.from([0]),
        Buffer.from(["", "home", "fixture-person", "records"].join("/")),
      ]),
    },
    {
      expected: "home_path",
      name: "UTF-16 text",
      value: () => Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(["", "home", "fixture-person", "records"].join("/"), "utf16le"),
      ]),
    },
  ];

  for (const fixture of encodedTextFixtures) {
    test(`inspects ${fixture.name} with class-only diagnostics`, () => {
      const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
      temporaryDirectories.push(directory);
      const text = join(directory, "publication.md");
      const contents = fixture.value();
      writeFileSync(text, contents);

      const result = runGate([text]);
      const output = result.stdout.toString();

      expect(result.exitCode).toBe(1);
      expect(output).toBe(`PRIVACY GATE: FAIL\n${fixture.expected}: 1\n`);
      expect(output).not.toContain(directory);
      expect(result.stderr.toString()).toBe("");
    });
  }

  test("fails closed for unsupported binary publication input", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const binary = join(directory, "publication.bin");
    writeFileSync(binary, Buffer.from([0x00, 0xff, 0x00, 0xfe, 0x01, 0x02]));

    const result = runGate([binary]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\ninspection_error: 1\n");
    expect(result.stdout.toString()).not.toContain(directory);
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

  test("rejects fingerprint catalogs reached through symlinked ancestors", () => {
    const root = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(root);
    const realDirectory = join(root, "real-catalog");
    mkdirSync(realDirectory);
    const catalog = join(realDirectory, "known-values.json");
    writeFingerprintCatalog(catalog, `fixture-${process.pid}-catalog-value`);
    const linkedDirectory = join(root, "linked-catalog");
    symlinkSync(realDirectory, linkedDirectory);
    const publication = join(root, "publication.md");
    writeFileSync(publication, "Synthetic publication.\n");

    const result = runGateArguments(["--require-known-values", "--paths", publication], {
      LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: join(linkedDirectory, "known-values.json"),
      LLV_PRIVACY_KNOWN_VALUES: "",
      LLV_PRIVACY_KNOWN_VALUES_FILE: "",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\nconfiguration_error: 1\n");
    expect(result.stdout.toString()).not.toContain(root);
    expect(result.stderr.toString()).toBe("");
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

  test("discovers committed regular-file to symlink type changes", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    runGit(directory, ["init", "--quiet"]);
    runGit(directory, ["config", "user.name", "Synthetic Fixture"]);
    runGit(directory, ["config", "user.email", "fixture@example.invalid"]);
    const publication = join(directory, "publication.md");
    writeFileSync(publication, "Synthetic baseline.\n");
    runGit(directory, ["add", "publication.md"]);
    runGit(directory, ["commit", "--quiet", "-m", "fixture baseline"]);
    const baseResult = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: directory, stdout: "pipe" });
    const base = baseResult.stdout.toString().trim();
    rmSync(publication);
    symlinkSync(["", "home", "fixture-person", "dangling-target"].join("/"), publication);
    runGit(directory, ["add", "publication.md"]);
    runGit(directory, ["commit", "--quiet", "-m", "fixture type change"]);

    const result = runGateArguments(["--base", base], {}, directory);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\nunsafe_path: 1\n");
    expect(result.stdout.toString()).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects dangling symlinks without resolving their target strings", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const publication = join(directory, "publication.md");
    const target = ["", "home", "fixture-person", "missing-target"].join("/");
    symlinkSync(target, publication);

    const result = runGate([publication]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nunsafe_path: 1\n");
    expect(output).not.toContain(target);
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
    installTool(directory, "ffprobe", `printf '%s' '{"format":{"duration":"8","tags":{}},"streams":[{"duration":"8","nb_frames":"80","tags":{}}]}'`);
    installTool(directory, "ffmpeg", "printf '%s' 'synthetic-frame'");
    const environment = installTool(directory, "tesseract", `printf x >> "$FRAME_COUNTER"\nprintf '%s\\n' '${syntheticHome}'`);

    const result = runGate([animation], { ...environment, FRAME_COUNTER: counter });
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_invalid: 1\n");
    expect(readFileSync(counter, "utf8")).toHaveLength(5);
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("inspects every video stream with class-only diagnostics", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const animation = join(directory, "capture.mp4");
    const contents = Buffer.from("deterministic synthetic multi-stream video fixture");
    writeFileSync(animation, contents);
    writeValidProvenance(directory, "capture.mp4", contents);
    const syntheticHome = ["", "Users", "fixture-person", "second-stream"].join("/");
    installTool(directory, "ffprobe", `printf '%s' '{"format":{"duration":"8","tags":{}},"streams":[{"duration":"8","nb_frames":"80","tags":{"title":"safe-zero"}},{"duration":"8","nb_frames":"80","tags":{"title":"safe-one"}}]}'`);
    installTool(directory, "ffmpeg", `case "$*" in *"0:v:1"*) printf '%s' 'private-frame';; *) printf '%s' 'safe-frame';; esac`);
    const environment = installTool(directory, "tesseract", `frame=$(cat)\nif [ "$frame" = "private-frame" ]; then printf '%s\\n' '${syntheticHome}'; fi`);

    const result = runGate([animation], environment);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_invalid: 1\n");
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("inspects metadata from every video stream", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const animation = join(directory, "capture.mp4");
    const contents = Buffer.from("deterministic synthetic multi-stream metadata fixture");
    writeFileSync(animation, contents);
    writeValidProvenance(directory, "capture.mp4", contents);
    const syntheticHome = ["", "Users", "fixture-person", "stream-metadata"].join("/");
    installTool(directory, "ffprobe", `case "$*" in *"v:0"*) printf '%s' '{"format":{"duration":"8"},"streams":[{"duration":"8","nb_frames":"80","tags":{"title":"safe-zero"}}]}';; *) printf '%s' '{"format":{"duration":"8"},"streams":[{"duration":"8","nb_frames":"80","tags":{"title":"safe-zero"}},{"duration":"8","nb_frames":"80","tags":{"title":"${syntheticHome}"}}]}';; esac`);
    installTool(directory, "ffmpeg", "printf '%s' 'safe-frame'");
    const environment = installTool(directory, "tesseract");

    const result = runGate([animation], environment);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_invalid: 1\n");
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("fails closed before sampling excessive video streams", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const animation = join(directory, "capture.mp4");
    const contents = Buffer.from("deterministic synthetic excessive-stream video fixture");
    writeFileSync(animation, contents);
    writeValidProvenance(directory, "capture.mp4", contents);
    const counter = join(directory, "sample-count");
    const probe = JSON.stringify({
      format: { duration: "8" },
      streams: Array.from({ length: 17 }, () => ({ duration: "8", nb_frames: "80", tags: {} })),
    });
    installTool(directory, "ffprobe", `printf '%s' '${probe}'`);
    installTool(directory, "ffmpeg", `printf x >> "$FRAME_COUNTER"\nprintf '%s' 'safe-frame'`);
    const environment = installTool(directory, "tesseract");

    const result = runGate([animation], { ...environment, FRAME_COUNTER: counter });
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\ninspection_error: 1\nprovenance_invalid: 1\n");
    expect(existsSync(counter)).toBe(false);
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
    installTool(directory, "ffprobe", `printf '%s' '{"format":{"duration":"N/A","tags":{}},"streams":[{"nb_read_frames":"N/A","nb_frames":"240"}]}'`);
    installTool(directory, "ffmpeg", `printf x >> "$FRAME_COUNTER"\nprintf '%s' 'synthetic-frame'`);
    const environment = installTool(directory, "tesseract", `printf '%s\n' '${syntheticHome}'`);

    const result = runGate([animation], { ...environment, FRAME_COUNTER: counter });
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_invalid: 1\n");
    expect(readFileSync(counter, "utf8")).toHaveLength(5);
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("fails closed when protected late video frames cannot be bounded", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const animation = join(directory, "capture.mp4");
    const contents = Buffer.from("deterministic synthetic unbounded long-video fixture");
    writeFileSync(animation, contents);
    writeValidProvenance(directory, "capture.mp4", contents);
    const sampleLog = join(directory, "sample-log");
    installTool(directory, "ffprobe", `printf '%s' '{"format":{"duration":"N/A"},"streams":[{"nb_read_frames":"N/A","nb_frames":"N/A"}]}'`);
    installTool(directory, "ffmpeg", `printf '%s\n' "$*" >> "$SAMPLE_LOG"\nprintf '%s' 'synthetic-frame'`);
    const environment = installTool(directory, "tesseract", "printf '%s' 'synthetic-safe-ocr'");

    const result = runGate([animation], { ...environment, SAMPLE_LOG: sampleLog });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\ninspection_error: 1\nprovenance_invalid: 1\n");
    expect(existsSync(sampleLog)).toBe(false);
    expect(result.stdout.toString()).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("matches a Ukrainian OCR value with configured multilingual language data", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const image = join(directory, "capture.png");
    const contents = redactedPlaceholderPng();
    writeFileSync(image, contents);
    writeValidProvenance(directory, "capture.png", contents);
    const argumentsFile = join(directory, "ocr-arguments");
    const fingerprints = join(directory, "known-values.json");
    const ukrainianValue = ["приватна", "назва", "проєкту"].join("-");
    writeFingerprintCatalog(fingerprints, ukrainianValue);
    const environment = installTool(directory, "tesseract", `printf '%s' "$*" > "$OCR_ARGUMENTS"\nprintf '%s\n' "$OCR_TEXT"`);

    const result = runGate([image], {
      ...environment,
      LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: fingerprints,
      LLV_PRIVACY_OCR_LANGUAGES: "eng+ukr",
      OCR_ARGUMENTS: argumentsFile,
      OCR_TEXT: ukrainianValue,
    });
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nknown_value: 1\nprovenance_invalid: 1\n");
    expect(readFileSync(argumentsFile, "utf8")).toContain("-l eng+ukr");
    expect(output).not.toContain(ukrainianValue);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("fails closed when configured OCR language data is unavailable", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const image = join(directory, "capture.png");
    const contents = redactedPlaceholderPng();
    writeFileSync(image, contents);
    writeValidProvenance(directory, "capture.png", contents);
    const environment = installTool(directory, "tesseract", "exit 1");

    const result = runGate([image], {
      ...environment,
      LLV_PRIVACY_OCR_LANGUAGES: "eng+ukr",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\ninspection_error: 1\nprovenance_invalid: 1\n");
    expect(result.stdout.toString()).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("detects PNG media renamed with a Markdown extension", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const image = join(directory, "capture.md");
    writeFileSync(image, liveCapturePng());

    const result = runGate([image], installTool(directory, "tesseract"));

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe([
      "PRIVACY GATE: FAIL",
      "media_live_source: 1",
      "provenance_missing: 1",
      "",
    ].join("\n"));
    expect(result.stdout.toString()).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("detects video media renamed with a text extension", () => {
    const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(directory);
    const video = join(directory, "capture.txt");
    const signature = Buffer.from("000000186674797069736f6d0000020069736f6d", "hex");
    writeFileSync(video, signature);
    const syntheticHome = ["", "home", "fixture-person", "renamed-video"].join("/");
    installTool(directory, "ffprobe", `printf '%s' '{"format":{"duration":"1"},"streams":[{"duration":"1","nb_frames":"5"}]}'`);
    installTool(directory, "ffmpeg", "printf '%s' 'synthetic-frame'");
    const environment = installTool(directory, "tesseract", `printf '%s' '${syntheticHome}'`);

    const result = runGate([video], environment);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_missing: 1\n");
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

  test("uses trusted scanner and fingerprints when every candidate gate surface is tampered", () => {
    const root = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(root);
    const candidate = join(root, "candidate");
    mkdirSync(candidate);
    runGit(candidate, ["init", "--quiet"]);
    runGit(candidate, ["config", "user.name", "Synthetic Fixture"]);
    runGit(candidate, ["config", "user.email", "fixture@example.invalid"]);
    const tamperedPaths = [
      ".github/workflows/privacy-publication.yml",
      "scripts/privacy-known-value-fingerprints.json",
      "scripts/privacy-publication-gate.test.ts",
      "scripts/privacy-publication-gate.ts",
    ];
    for (const path of [...tamperedPaths, "docs/publication.md"]) {
      const absolute = join(candidate, path);
      mkdirSync(join(absolute, ".."), { recursive: true });
      writeFileSync(absolute, "Synthetic baseline.\n");
    }
    runGit(candidate, ["add", "."]);
    runGit(candidate, ["commit", "--quiet", "-m", "fixture baseline"]);

    for (const path of tamperedPaths) writeFileSync(join(candidate, path), "tampered candidate gate surface\n");
    const knownValue = `fixture-${process.pid}-trusted-tampering-label`;
    writeFileSync(join(candidate, "docs/publication.md"), `${knownValue}\n`);
    const trustedCatalog = join(root, "trusted-fingerprints.json");
    writeFingerprintCatalog(trustedCatalog, knownValue);

    const result = runGateArguments(["--repository", candidate, "--base", "HEAD", "--require-known-values"], {
      LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: trustedCatalog,
      LLV_PRIVACY_KNOWN_VALUES: "",
      LLV_PRIVACY_KNOWN_VALUES_FILE: "",
    });
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nknown_value: 1\n");
    expect(output).not.toContain(knownValue);
    expect(output).not.toContain(candidate);
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects candidate-created adversarial exemptions", () => {
    const root = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(root);
    runGit(root, ["init", "--quiet"]);
    runGit(root, ["config", "user.name", "Synthetic Fixture"]);
    runGit(root, ["config", "user.email", "fixture@example.invalid"]);
    writeFileSync(join(root, "README.md"), "Synthetic baseline.\n");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "--quiet", "-m", "fixture baseline"]);
    const directory = join(root, "privacy-fixtures");
    mkdirSync(directory);
    const image = join(directory, "synthetic-path.png");
    const contents = redactedPlaceholderPng();
    writeFileSync(image, contents);
    const generator = Buffer.from('export const PRIVACY_GENERATOR_RUNTIME = "1.3.3";\nexport const PRIVACY_GENERATOR_VERSION = "fixture-generator-v2";\n');
    writeFileSync(join(directory, "generate-fixture.mjs"), generator);
    writeFileSync(join(directory, "privacy-manifest.json"), JSON.stringify({
      schemaVersion: 2,
      assets: [{
        path: "synthetic-path.png",
        classification: "adversarial-synthetic",
        source: "deterministic-generator",
        generator: "generate-fixture.mjs",
        generatorRuntime: "bun-1.3.3",
        generatorVersion: "fixture-generator-v2",
        generatorSha256: createHash("sha256").update(generator).digest("hex"),
        sourceDigests: [createHash("sha256").update("adversarial-fixture-source").digest("hex")],
        description: "Synthetic adversarial raster for path-detection regression coverage.",
        expectedFindingClasses: ["home_path"],
        sha256: createHash("sha256").update(contents).digest("hex"),
      }],
    }));
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "--quiet", "-m", "candidate exemption"]);
    const syntheticHome = ["", "home", "fixture-person", "records"].join("/");

    const result = runGateArguments(
      ["--repository", root, "--base", "HEAD^", "--paths", image],
      installTool(directory, "tesseract", `printf '%s\\n' '${syntheticHome}'`),
    );
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_invalid: 1\n");
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects live output and source digests that contradict the trusted generator", () => {
    const root = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(root);
    runGit(root, ["init", "--quiet"]);
    runGit(root, ["config", "user.name", "Synthetic Fixture"]);
    runGit(root, ["config", "user.email", "fixture@example.invalid"]);
    writeFileSync(join(root, "README.md"), "Synthetic baseline.\n");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "--quiet", "-m", "fixture baseline"]);
    const directory = join(root, "docs", "acceptance", "issue-290");
    const scriptsDirectory = join(root, "scripts");
    mkdirSync(directory, { recursive: true });
    mkdirSync(scriptsDirectory, { recursive: true });
    const image = join(directory, "readiness-kanban.png");
    const contents = liveCapturePng();
    writeFileSync(image, contents);
    const generator = readFileSync(join(import.meta.dir, "generate-privacy-placeholders.ts"));
    writeFileSync(join(scriptsDirectory, "generate-privacy-placeholders.ts"), generator);
    writeFileSync(join(directory, "privacy-manifest.json"), JSON.stringify({
      schemaVersion: 2,
      assets: [{
        path: "readiness-kanban.png",
        classification: "redacted-placeholder",
        source: "redacted-live-capture",
        generator: "../../../scripts/generate-privacy-placeholders.ts",
        generatorRuntime: "bun-1.3.3",
        generatorVersion: "privacy-placeholders-v2",
        generatorSha256: createHash("sha256").update(generator).digest("hex"),
        sourceDigests: [createHash("sha256").update("candidate-declared-source").digest("hex")],
        description: "Candidate-declared source and output for a live publication capture.",
        sha256: createHash("sha256").update(contents).digest("hex"),
      }],
    }));
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "--quiet", "-m", "candidate publication"]);

    const result = runGateArguments(
      ["--repository", root, "--base", "HEAD^", "--paths", image],
      installTool(root, "tesseract"),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe([
      "PRIVACY GATE: FAIL",
      "media_live_source: 1",
      "provenance_invalid: 1",
      "",
    ].join("\n"));
    expect(result.stdout.toString()).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects candidate-controlled generators that self-certify live media", () => {
    const root = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(root);
    const directory = join(root, "published");
    mkdirSync(directory);
    const image = join(directory, "capture.png");
    const contents = liveCapturePng();
    writeFileSync(image, contents);
    const generator = Buffer.from([
      'export const PRIVACY_GENERATOR_RUNTIME = "1.3.3";',
      'export const PRIVACY_GENERATOR_VERSION = "privacy-placeholders-v2";',
      "",
    ].join("\n"));
    writeFileSync(join(directory, "generate-placeholder.mjs"), generator);
    writeFileSync(join(directory, "privacy-manifest.json"), JSON.stringify({
      schemaVersion: 2,
      assets: [{
        path: "capture.png",
        classification: "redacted-placeholder",
        source: "redacted-live-capture",
        generator: "generate-placeholder.mjs",
        generatorRuntime: "bun-1.3.3",
        generatorVersion: "privacy-placeholders-v2",
        generatorSha256: createHash("sha256").update(generator).digest("hex"),
        sourceDigests: [createHash("sha256").update("candidate-declared-source").digest("hex")],
        description: "Candidate-declared provenance for a live publication capture.",
        sha256: createHash("sha256").update(contents).digest("hex"),
      }],
    }));

    const result = runGateArguments(
      ["--repository", root, "--paths", image],
      installTool(directory, "tesseract"),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe([
      "PRIVACY GATE: FAIL",
      "media_live_source: 1",
      "provenance_invalid: 1",
      "",
    ].join("\n"));
    expect(result.stdout.toString()).not.toContain(directory);
    expect(result.stderr.toString()).toBe("");
  });

  test("allows adversarial exemptions already present in the trusted base", () => {
    const root = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(root);
    runGit(root, ["init", "--quiet"]);
    runGit(root, ["config", "user.name", "Synthetic Fixture"]);
    runGit(root, ["config", "user.email", "fixture@example.invalid"]);
    const directory = join(root, "privacy-fixtures");
    mkdirSync(directory);
    const image = join(directory, "synthetic-path.png");
    const contents = redactedPlaceholderPng();
    writeFileSync(image, contents);
    const generator = Buffer.from('export const PRIVACY_GENERATOR_RUNTIME = "1.3.3";\nexport const PRIVACY_GENERATOR_VERSION = "fixture-generator-v2";\n');
    writeFileSync(join(directory, "generate-fixture.mjs"), generator);
    writeFileSync(join(directory, "privacy-manifest.json"), JSON.stringify({
      schemaVersion: 2,
      assets: [{
        path: "synthetic-path.png",
        classification: "adversarial-synthetic",
        source: "deterministic-generator",
        generator: "generate-fixture.mjs",
        generatorRuntime: "bun-1.3.3",
        generatorVersion: "fixture-generator-v2",
        generatorSha256: createHash("sha256").update(generator).digest("hex"),
        sourceDigests: [createHash("sha256").update("adversarial-fixture-source").digest("hex")],
        description: "Synthetic adversarial raster for path-detection regression coverage.",
        expectedFindingClasses: ["home_path"],
        sha256: createHash("sha256").update(contents).digest("hex"),
      }],
    }));
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "--quiet", "-m", "trusted exemption"]);
    const syntheticHome = ["", "home", "fixture-person", "records"].join("/");

    const result = runGateArguments(
      ["--repository", root, "--base", "HEAD", "--paths", image],
      installTool(directory, "tesseract", `printf '%s\\n' '${syntheticHome}'`),
    );
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
    const generator = Buffer.from('export const PRIVACY_GENERATOR_RUNTIME = "1.3.3";\nexport const PRIVACY_GENERATOR_VERSION = "fixture-generator-v2";\n');
    writeFileSync(join(manifestLinkDirectory, "generate-placeholder.mjs"), generator);
    writeFileSync(externalManifest, JSON.stringify({
      schemaVersion: 2,
      assets: [{
        path: "capture.png",
        classification: "redacted-placeholder",
        source: "redacted-live-capture",
        generator: "generate-placeholder.mjs",
        generatorRuntime: "bun-1.3.3",
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

  test("rejects asset and manifest paths reached through symlinked ancestors", () => {
    const root = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(root);
    const realDirectory = join(root, "real-publication");
    mkdirSync(realDirectory);
    const contents = redactedPlaceholderPng();
    writeFileSync(join(realDirectory, "capture.png"), contents);
    writeValidProvenance(realDirectory, "capture.png", contents);
    const linkedDirectory = join(root, "linked-publication");
    symlinkSync(realDirectory, linkedDirectory);

    const result = runGate(
      [join(linkedDirectory, "capture.png")],
      installTool(root, "tesseract"),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\nunsafe_path: 1\n");
    expect(result.stdout.toString()).not.toContain(root);
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects provenance generators reached through symlinked ancestors", () => {
    const root = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
    temporaryDirectories.push(root);
    const publicationDirectory = join(root, "published");
    const externalDirectory = join(root, "external-generator");
    mkdirSync(publicationDirectory);
    mkdirSync(externalDirectory);
    const image = join(publicationDirectory, "capture.png");
    const contents = redactedPlaceholderPng();
    writeFileSync(image, contents);
    const generator = Buffer.from('export const PRIVACY_GENERATOR_RUNTIME = "1.3.3";\nexport const PRIVACY_GENERATOR_VERSION = "fixture-generator-v2";\n');
    writeFileSync(join(externalDirectory, "generate-placeholder.mjs"), generator);
    symlinkSync(externalDirectory, join(publicationDirectory, "linked-generator"));
    writeFileSync(join(publicationDirectory, "privacy-manifest.json"), JSON.stringify({
      schemaVersion: 2,
      assets: [{
        path: "capture.png",
        classification: "redacted-placeholder",
        source: "redacted-live-capture",
        generator: "linked-generator/generate-placeholder.mjs",
        generatorRuntime: "bun-1.3.3",
        generatorVersion: "fixture-generator-v2",
        generatorSha256: createHash("sha256").update(generator).digest("hex"),
        sourceDigests: [createHash("sha256").update("fixture-source").digest("hex")],
        description: "Synthetic provenance fixture with an ancestor-linked generator.",
        sha256: createHash("sha256").update(contents).digest("hex"),
      }],
    }));

    const result = runGate([image], installTool(root, "tesseract"));

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\nprovenance_invalid: 1\n");
    expect(result.stdout.toString()).not.toContain(root);
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
    const generator = Buffer.from('export const PRIVACY_GENERATOR_RUNTIME = "1.3.3";\nexport const PRIVACY_GENERATOR_VERSION = "fixture-generator-v2";\n');
    const externalGenerator = join(root, "external-generator.mjs");
    writeFileSync(externalGenerator, generator);
    writeFileSync(join(directory, "privacy-manifest.json"), JSON.stringify({
      schemaVersion: 2,
      assets: [{
        path: "capture.png",
        classification: "redacted-placeholder",
        source: "redacted-live-capture",
        generator: "../external-generator.mjs",
        generatorRuntime: "bun-1.3.3",
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
    const generator = Buffer.from('export const PRIVACY_GENERATOR_RUNTIME = "1.3.3";\nexport const packageMetadata = { version: "fixture-generator-v2" };\n');
    writeFileSync(join(directory, "generate-placeholder.mjs"), generator);
    writeFileSync(join(directory, "privacy-manifest.json"), JSON.stringify({
      schemaVersion: 2,
      assets: [{
        path: "capture.png",
        classification: "redacted-placeholder",
        source: "redacted-live-capture",
        generator: "generate-placeholder.mjs",
        generatorRuntime: "bun-1.3.3",
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

  for (const runtimeFixture of [
    { name: "missing", value: undefined },
    { name: "malformed", value: "bun latest!" },
    { name: "mismatched", value: "bun-1.3.14" },
  ]) {
    test(`rejects ${runtimeFixture.name} provenance generator runtime declarations`, () => {
      const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
      temporaryDirectories.push(directory);
      const image = join(directory, "capture.png");
      const contents = redactedPlaceholderPng();
      writeFileSync(image, contents);
      writeValidProvenance(directory, "capture.png", contents);
      const manifestPath = join(directory, "privacy-manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        assets: Array<Record<string, unknown>>;
      };
      if (runtimeFixture.value === undefined) delete manifest.assets[0].generatorRuntime;
      else manifest.assets[0].generatorRuntime = runtimeFixture.value;
      writeFileSync(manifestPath, JSON.stringify(manifest));

      const result = runGate([image], installTool(directory, "tesseract"));

      expect(result.exitCode).toBe(1);
      expect(result.stdout.toString()).toBe("PRIVACY GATE: FAIL\nprovenance_invalid: 1\n");
      expect(result.stdout.toString()).not.toContain(directory);
      expect(result.stderr.toString()).toBe("");
    });
  }

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
      "provenance_invalid: 1",
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
    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_invalid: 1\n");
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
    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 5\nprovenance_invalid: 5\n");
    expect(output).not.toContain(syntheticHome);
    expect(output).not.toContain(root);
    expect(result.stderr.toString()).toBe("");
  });

  for (const fixture of [
    { byteOrder: "le" as const, location: "eXIf" as const },
    { byteOrder: "be" as const, location: "eXIf" as const },
    { byteOrder: "le" as const, location: "trailing payload" as const },
    { byteOrder: "be" as const, location: "trailing payload" as const },
  ]) {
    test(`scans odd-aligned ${fixture.byteOrder.toUpperCase()} UTF-16 in ${fixture.location}`, () => {
      const directory = mkdtempSync(join(tmpdir(), "llv-privacy-gate-"));
      temporaryDirectories.push(directory);
      const syntheticHome = ["", "home", "fixture-person", `${fixture.byteOrder}-metadata`].join("/");
      const payload = oddAlignedUtf16(syntheticHome, fixture.byteOrder);
      const contents = fixture.location === "eXIf"
        ? pngWithExifBytes(payload)
        : Buffer.concat([redactedPlaceholderPng(), payload]);
      const image = join(directory, "capture.png");
      writeFileSync(image, contents);
      writeValidProvenance(directory, "capture.png", contents);

      const result = runGate([image], installTool(directory, "tesseract"));
      const output = result.stdout.toString();

      expect(result.exitCode).toBe(1);
      expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_invalid: 1\n");
      expect(output).not.toContain(syntheticHome);
      expect(output).not.toContain(directory);
      expect(result.stderr.toString()).toBe("");
    });
  }

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

  test("audits issue titles with class-only diagnostics", async () => {
    const syntheticHome = ["", "home", "fixture-person", "issue-title"].join("/");
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = new URL(input);
      if (url.pathname.endsWith("/issues/448")) return Response.json({ body: "", title: syntheticHome });
      if (url.pathname.endsWith("/issues/448/comments")) return Response.json([]);
      return new Response(null, { status: 404 });
    };

    const findings = await auditGithubPublication({
      apiUrl: "https://api.github.test/",
      fetcher,
      number: 448,
      repo: "example/repository",
      requireKnownValues: false,
      token: "synthetic-github-audit-token",
    });
    const output = formatPrivacyReport(findings);

    expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\n");
    expect(output).not.toContain(syntheticHome);
  });

  test("audits pull-request titles with class-only diagnostics", async () => {
    const syntheticIdentifier = ["12345678", "1234", "4abc", "8def", "123456789abc"].join("-");
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = new URL(input);
      if (url.pathname.endsWith("/issues/456")) return Response.json({ body: "", pull_request: {}, title: "" });
      if (url.pathname.endsWith("/issues/456/comments")) return Response.json([]);
      if (url.pathname.endsWith("/pulls/456")) return Response.json({ body: "", title: syntheticIdentifier });
      if (url.pathname.endsWith("/pulls/456/comments")) return Response.json([]);
      if (url.pathname.endsWith("/pulls/456/reviews")) return Response.json([]);
      return new Response(null, { status: 404 });
    };

    const findings = await auditGithubPublication({
      apiUrl: "https://api.github.test/",
      fetcher,
      number: 456,
      repo: "example/repository",
      requireKnownValues: false,
      token: "synthetic-github-audit-token",
    });
    const output = formatPrivacyReport(findings);

    expect(output).toBe("PRIVACY GATE: FAIL\nresource_identifier: 1\n");
    expect(output).not.toContain(syntheticIdentifier);
  });

  test("audits extensionless inline Markdown images", async () => {
    const originalOcrLanguages = process.env.LLV_PRIVACY_OCR_LANGUAGES;
    const syntheticHome = ["", "home", "fixture-person", "extensionless-media"].join("/");
    const media = pngWithCustomMetadata("eXIf", syntheticHome);
    const mediaUrl = "https://github.com/example/repository/rendered/capture";
    const requests: string[] = [];
    const languageResult = Bun.spawnSync({ cmd: ["tesseract", "--list-langs"], stderr: "pipe", stdout: "pipe" });
    const ocrLanguage = languageResult.stdout.toString().split(/\r?\n/).find((language) => /^[a-z0-9_]+$/i.test(language) && language !== "osd");
    process.env.LLV_PRIVACY_OCR_LANGUAGES = ocrLanguage ?? "missing-test-language";
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = new URL(input);
      requests.push(url.href);
      if (url.href === mediaUrl) {
        return new Response(Uint8Array.from(media), { headers: { "content-type": "image/png" } });
      }
      if (url.pathname.endsWith("/issues/448")) {
        return Response.json({ body: `![extensionless](${mediaUrl})`, title: "Synthetic issue" });
      }
      if (url.pathname.endsWith("/issues/448/comments")) return Response.json([]);
      return new Response(null, { status: 404 });
    };

    try {
      const findings = await auditGithubPublication({
        apiUrl: "https://api.github.test/",
        fetcher,
        number: 448,
        repo: "example/repository",
        requireKnownValues: false,
        token: "synthetic-github-audit-token",
      });
      const output = formatPrivacyReport(findings);

      expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_missing: 1\n");
      expect(requests).toHaveLength(3);
      expect(requests.at(-1)).toBe(mediaUrl);
      expect(output).not.toContain(syntheticHome);
    } finally {
      if (originalOcrLanguages === undefined) delete process.env.LLV_PRIVACY_OCR_LANGUAGES;
      else process.env.LLV_PRIVACY_OCR_LANGUAGES = originalOcrLanguages;
    }
  });

  test("audits HTML media across quoted and parse-error attribute delimiters", async () => {
    const originalOcrLanguages = process.env.LLV_PRIVACY_OCR_LANGUAGES;
    const syntheticHome = ["", "home", "fixture-person", "quoted-attribute-media"].join("/");
    const media = pngWithCustomMetadata("eXIf", syntheticHome);
    const mediaPaths = [
      "/user-attachments/assets/quoted-capture",
      "/user-attachments/assets/unquoted-capture",
    ];
    const resolvedMedia = mediaPaths.map((mediaPath) => `https://github.com${mediaPath}`);
    const requests: string[] = [];
    const languageResult = Bun.spawnSync({ cmd: ["tesseract", "--list-langs"], stderr: "pipe", stdout: "pipe" });
    const ocrLanguage = languageResult.stdout.toString().split(/\r?\n/).find((language) => /^[a-z0-9_]+$/i.test(language) && language !== "osd");
    process.env.LLV_PRIVACY_OCR_LANGUAGES = ocrLanguage ?? "missing-test-language";
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = new URL(input);
      requests.push(url.href);
      if (resolvedMedia.includes(url.href)) {
        return new Response(Uint8Array.from(media), { headers: { "content-type": "image/png" } });
      }
      if (url.pathname.endsWith("/issues/448")) {
        return Response.json({
          body: [
            `<img title=">" src="${mediaPaths[0]}">`,
            `<img title=unquoted" src="${mediaPaths[1]}">`,
          ].join("\n"),
          title: "Synthetic issue",
        });
      }
      if (url.pathname.endsWith("/issues/448/comments")) return Response.json([]);
      return new Response(null, { status: 404 });
    };

    try {
      const findings = await auditGithubPublication({
        apiUrl: "https://api.github.test/",
        fetcher,
        number: 448,
        repo: "example/repository",
        requireKnownValues: false,
        token: "synthetic-github-audit-token",
      });
      const output = formatPrivacyReport(findings);

      expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 2\nprovenance_missing: 2\n");
      expect(requests).toHaveLength(4);
      expect(requests.slice(-2).sort()).toEqual(resolvedMedia.toSorted());
      expect(output).not.toContain(syntheticHome);
    } finally {
      if (originalOcrLanguages === undefined) delete process.env.LLV_PRIVACY_OCR_LANGUAGES;
      else process.env.LLV_PRIVACY_OCR_LANGUAGES = originalOcrLanguages;
    }
  });

  test("audits every extensionless source srcset candidate", async () => {
    const originalOcrLanguages = process.env.LLV_PRIVACY_OCR_LANGUAGES;
    const syntheticHome = ["", "home", "fixture-person", "srcset-media"].join("/");
    const media = pngWithCustomMetadata("eXIf", syntheticHome);
    const mediaUrls = [
      "https://github.com/example/repository/rendered/srcset-one",
      "https://github.com/example/repository/rendered/srcset-two",
    ];
    const requests: string[] = [];
    const languageResult = Bun.spawnSync({ cmd: ["tesseract", "--list-langs"], stderr: "pipe", stdout: "pipe" });
    const ocrLanguage = languageResult.stdout.toString().split(/\r?\n/).find((language) => /^[a-z0-9_]+$/i.test(language) && language !== "osd");
    process.env.LLV_PRIVACY_OCR_LANGUAGES = ocrLanguage ?? "missing-test-language";
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = new URL(input);
      requests.push(url.href);
      if (mediaUrls.includes(url.href)) {
        return new Response(Uint8Array.from(media), { headers: { "content-type": "image/png" } });
      }
      if (url.pathname.endsWith("/issues/448")) {
        return Response.json({
          body: `<picture><source srcset="${mediaUrls[0]} 1x, ${mediaUrls[1]} 2x"></picture>`,
          title: "Synthetic issue",
        });
      }
      if (url.pathname.endsWith("/issues/448/comments")) return Response.json([]);
      return new Response(null, { status: 404 });
    };

    try {
      const findings = await auditGithubPublication({
        apiUrl: "https://api.github.test/",
        fetcher,
        number: 448,
        repo: "example/repository",
        requireKnownValues: false,
        token: "synthetic-github-audit-token",
      });
      const output = formatPrivacyReport(findings);

      expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 2\nprovenance_missing: 2\n");
      expect(requests).toHaveLength(4);
      expect(requests.slice(-2).sort()).toEqual(mediaUrls.toSorted());
      expect(output).not.toContain(syntheticHome);
    } finally {
      if (originalOcrLanguages === undefined) delete process.env.LLV_PRIVACY_OCR_LANGUAGES;
      else process.env.LLV_PRIVACY_OCR_LANGUAGES = originalOcrLanguages;
    }
  });

  test("audits relative reference-style Markdown images", async () => {
    const originalOcrLanguages = process.env.LLV_PRIVACY_OCR_LANGUAGES;
    const syntheticHome = ["", "home", "fixture-person", "reference-media"].join("/");
    const media = pngWithCustomMetadata("eXIf", syntheticHome);
    const relativeMedia = "rendered/reference-capture";
    const resolvedMedia = `https://github.com/example/repository/${relativeMedia}`;
    const requests: string[] = [];
    const languageResult = Bun.spawnSync({ cmd: ["tesseract", "--list-langs"], stderr: "pipe", stdout: "pipe" });
    const ocrLanguage = languageResult.stdout.toString().split(/\r?\n/).find((language) => /^[a-z0-9_]+$/i.test(language) && language !== "osd");
    process.env.LLV_PRIVACY_OCR_LANGUAGES = ocrLanguage ?? "missing-test-language";
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = new URL(input);
      requests.push(url.href);
      if (url.href === resolvedMedia) {
        return new Response(Uint8Array.from(media), { headers: { "content-type": "image/png" } });
      }
      if (url.pathname.endsWith("/issues/448")) {
        return Response.json({
          body: `![reference][capture]\n\n[capture]: ${relativeMedia}`,
          title: "Synthetic issue",
        });
      }
      if (url.pathname.endsWith("/issues/448/comments")) return Response.json([]);
      return new Response(null, { status: 404 });
    };

    try {
      const findings = await auditGithubPublication({
        apiUrl: "https://api.github.test/",
        fetcher,
        number: 448,
        repo: "example/repository",
        requireKnownValues: false,
        token: "synthetic-github-audit-token",
      });
      const output = formatPrivacyReport(findings);

      expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_missing: 1\n");
      expect(requests).toHaveLength(3);
      expect(requests.at(-1)).toBe(resolvedMedia);
      expect(output).not.toContain(syntheticHome);
    } finally {
      if (originalOcrLanguages === undefined) delete process.env.LLV_PRIVACY_OCR_LANGUAGES;
      else process.env.LLV_PRIVACY_OCR_LANGUAGES = originalOcrLanguages;
    }
  });

  test("fetches entity-encoded GitHub media references for inspection", async () => {
    const originalOcrLanguages = process.env.LLV_PRIVACY_OCR_LANGUAGES;
    const syntheticHome = ["", "home", "fixture-person", "encoded-media"].join("/");
    const media = pngWithCustomMetadata("eXIf", syntheticHome);
    const requests: string[] = [];
    const encodedMedia = "&#104;&amp;#116;&#116;&#112;&#115;&amp;colon;&sol;&sol;github.com/example/repository/assets/encoded.png";
    const languageResult = Bun.spawnSync({ cmd: ["tesseract", "--list-langs"], stderr: "pipe", stdout: "pipe" });
    const ocrLanguage = languageResult.stdout.toString().split(/\r?\n/).find((language) => /^[a-z0-9_]+$/i.test(language) && language !== "osd");
    process.env.LLV_PRIVACY_OCR_LANGUAGES = ocrLanguage ?? "missing-test-language";
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = new URL(input);
      requests.push(url.href);
      if (url.hostname === "github.com") {
        return new Response(Uint8Array.from(media), { headers: { "content-type": "image/png" } });
      }
      if (url.pathname.endsWith("/issues/448")) {
        return Response.json({ body: `<img src="${encodedMedia}">`, title: "Synthetic issue" });
      }
      if (url.pathname.endsWith("/issues/448/comments")) return Response.json([]);
      return new Response(null, { status: 404 });
    };

    try {
      const findings = await auditGithubPublication({
        apiUrl: "https://api.github.test/",
        fetcher,
        number: 448,
        repo: "example/repository",
        requireKnownValues: false,
        token: "synthetic-github-audit-token",
      });
      const output = formatPrivacyReport(findings);

      expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 1\nprovenance_missing: 1\n");
      expect(requests).toHaveLength(3);
      expect(requests.at(-1)).toBe("https://github.com/example/repository/assets/encoded.png");
      expect(output).not.toContain(syntheticHome);
      expect(output).not.toContain(encodedMedia);
    } finally {
      if (originalOcrLanguages === undefined) delete process.env.LLV_PRIVACY_OCR_LANGUAGES;
      else process.env.LLV_PRIVACY_OCR_LANGUAGES = originalOcrLanguages;
    }
  });

  test("resolves relative GitHub media references before trusted-host inspection", async () => {
    const originalOcrLanguages = process.env.LLV_PRIVACY_OCR_LANGUAGES;
    const syntheticHome = ["", "home", "fixture-person", "relative-media"].join("/");
    const media = pngWithCustomMetadata("eXIf", syntheticHome);
    const requests: Array<{ authorization: string | null; url: string }> = [];
    const languageResult = Bun.spawnSync({ cmd: ["tesseract", "--list-langs"], stderr: "pipe", stdout: "pipe" });
    const ocrLanguage = languageResult.stdout.toString().split(/\r?\n/).find((language) => /^[a-z0-9_]+$/i.test(language) && language !== "osd");
    process.env.LLV_PRIVACY_OCR_LANGUAGES = ocrLanguage ?? "missing-test-language";
    const fetcher = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input);
      requests.push({
        authorization: new Headers(init?.headers).get("authorization"),
        url: url.href,
      });
      if (url.hostname === "github.com" || url.hostname === "raw.githubusercontent.com") {
        return new Response(Uint8Array.from(media), { headers: { "content-type": "image/png" } });
      }
      if (url.pathname.endsWith("/issues/448")) {
        return Response.json({
          body: [
            "![root relative](/user-attachments/assets/capture.png)",
            '<img src="//raw.githubusercontent.com/example/repository/main/capture.png">',
            "![blocked](//127.0.0.2/private.png)",
          ].join("\n"),
          title: "Synthetic issue",
        });
      }
      if (url.pathname.endsWith("/issues/448/comments")) return Response.json([]);
      return new Response(null, { status: 404 });
    };

    try {
      const findings = await auditGithubPublication({
        apiUrl: "https://api.github.test/",
        fetcher,
        number: 448,
        repo: "example/repository",
        requireKnownValues: false,
        token: "synthetic-github-audit-token",
      });
      const output = formatPrivacyReport(findings);

      expect(output).toBe("PRIVACY GATE: FAIL\nhome_path: 2\ninspection_error: 1\nprovenance_missing: 2\n");
      expect(requests).toHaveLength(4);
      expect(requests).toContainEqual({
        authorization: "Bearer synthetic-github-audit-token",
        url: "https://github.com/user-attachments/assets/capture.png",
      });
      expect(requests).toContainEqual({
        authorization: null,
        url: "https://raw.githubusercontent.com/example/repository/main/capture.png",
      });
      expect(requests.some((request) => request.url.includes("127.0.0.2"))).toBe(false);
      expect(output).not.toContain(syntheticHome);
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
