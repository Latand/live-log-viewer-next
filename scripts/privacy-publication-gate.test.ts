import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

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

function writeValidProvenance(directory: string, name: string, contents: Buffer): void {
  writeFileSync(join(directory, "generate-placeholder.mjs"), "// Deterministic synthetic test generator.\n");
  writeFileSync(join(directory, "privacy-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    assets: [{
      path: name,
      classification: "redacted-placeholder",
      source: "redacted-live-capture",
      generator: "generate-placeholder.mjs",
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
    writeFileSync(join(directory, "generate-fixture.mjs"), "// Deterministic adversarial fixture generator.\n");
    writeFileSync(join(directory, "privacy-manifest.json"), JSON.stringify({
      schemaVersion: 1,
      assets: [{
        path: "synthetic-path.png",
        classification: "adversarial-synthetic",
        source: "deterministic-generator",
        generator: "generate-fixture.mjs",
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
});
