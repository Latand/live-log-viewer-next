/*
 * Synthetic fixture generators + capture-home seeding for the issue #875
 * evidence driver. Everything here is generated at runtime: no binary blobs,
 * no identities, no absolute paths in sources.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/* Distinct from every session id the shared demo fixture ships. */
export const S_ID = ["d4d4d4d4", "d4d4", "4d4d", "8d4d", "d4d4d4d4d4d4"].join("-");

/* ── Synthetic fixture generators ─────────────────────────────────────── */

/** A well-formed multi-page PDF, padded with an unused stream object so it is
    large enough (> 2×64 KiB) for pdf.js to switch to byte-range loading. */
export function buildPdf(pages: number, padBytes: number): Buffer {
  const objects: string[] = [];
  const fontId = 3 + pages * 2;
  const padId = fontId + 1;
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(" ");
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages} >>\nendobj\n`);
  for (let i = 0; i < pages; i++) {
    const pageId = 3 + i * 2;
    const contentId = pageId + 1;
    const text = `BT /F1 32 Tf 72 700 Td (Synthetic fixture page ${i + 1} of ${pages}) Tj ET`;
    objects.push(`${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`);
    objects.push(`${contentId} 0 obj\n<< /Length ${text.length} >>\nstream\n${text}\nendstream\nendobj\n`);
  }
  objects.push(`${fontId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
  const pad = "A".repeat(padBytes);
  objects.push(`${padId} 0 obj\n<< /Length ${pad.length} >>\nstream\n${pad}\nendstream\nendobj\n`);

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(body.length);
    body += object;
  }
  const xrefAt = body.length;
  const count = objects.length + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += xref + `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([head, typed, crc]);
}

/** A synthetic gradient PNG with known intrinsic dimensions. */
export function buildPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = Math.floor((x / width) * 255);
      raw[row + 2 + x * 3] = Math.floor((y / height) * 255);
      raw[row + 3 + x * 3] = 160;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function syntheticLog(bytes: number, needleEvery: number): string {
  const lines: string[] = [];
  let size = 0;
  let index = 0;
  while (size < bytes) {
    const line = index % needleEvery === needleEvery - 1
      ? `line ${String(index + 1).padStart(6, "0")} — the needle marker appears here`
      : `line ${String(index + 1).padStart(6, "0")} — synthetic fixture output for the preview evidence run`;
    lines.push(line);
    size += line.length + 1;
    index += 1;
  }
  return lines.join("\n") + "\n";
}

/* ── Fixture seeding into the disposable capture home ─────────────────── */

export function seedArtifacts(home: string, outsideDir: string): void {
  const artifacts = path.join(home, "artifacts");
  fs.mkdirSync(artifacts, { recursive: true });
  fs.writeFileSync(path.join(artifacts, "report.pdf"), buildPdf(3, 220_000));
  fs.writeFileSync(path.join(artifacts, "board.png"), buildPng(64, 40));
  fs.writeFileSync(path.join(artifacts, "run.log"), syntheticLog(600_000, 40));
  fs.writeFileSync(path.join(artifacts, "live.log"), syntheticLog(400_000, 50));
  fs.writeFileSync(path.join(artifacts, "huge.log"), syntheticLog(2 * 1024 * 1024, 100));
  fs.writeFileSync(path.join(artifacts, "broken.png"), "<!DOCTYPE html><p>renamed markup, not a PNG</p>\n");
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, "denied.md"), "outside the allowed roots\n");
  fs.writeFileSync(path.join(outsideDir, "secret.md"), "symlink escape target\n");
  fs.symlinkSync(path.join(outsideDir, "secret.md"), path.join(artifacts, "sneaky.md"));
}

export function seedTranscript(home: string, outsideDir: string): string {
  const projects = path.join(home, ".claude", "projects");
  const atlas = fs.readdirSync(projects).find((dir) => dir.endsWith("-Projects-atlas"));
  if (!atlas) throw new Error("atlas fixture project missing");
  const message = [
    "The build artifacts are ready for review:",
    "",
    "- [build report](~/artifacts/report.pdf)",
    "- [board screenshot](~/artifacts/board.png)",
    "- [full run log](~/artifacts/run.log)",
    "- [live tail](~/artifacts/live.log)",
    "- [huge dump](~/artifacts/huge.log)",
    "- [missing notes](~/artifacts/missing.md)",
    `- [outside notes](${path.join(outsideDir, "denied.md")})`,
    "- [sneaky notes](~/artifacts/sneaky.md)",
    "- [broken shot](~/artifacts/broken.png)",
  ].join("\n");
  const rows = [
    {
      type: "user",
      uuid: ["c1000000", "0000", "4000", "8000", "000000000001"].join("-"),
      timestamp: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
      cwd: "/demo/Projects/atlas",
      message: { role: "user", content: "Link the build artifacts for review." },
    },
    {
      type: "assistant",
      uuid: ["c1000000", "0000", "4000", "8000", "000000000002"].join("-"),
      timestamp: new Date(Date.now() - 3 * 3600 * 1000 + 10_000).toISOString(),
      cwd: "/demo/Projects/atlas",
      message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: message }] },
    },
  ];
  const file = path.join(projects, atlas, `${S_ID}.jsonl`);
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  /* A settled PAST mtime: the shared fixtures carry the 2100 capture clock,
     which reads as "live/working" against real wall time and swaps the settled
     transcript for a live-turn loader. This session must render as a finished
     conversation whose links are on screen. */
  const when = new Date(Date.now() - 3 * 3600 * 1000);
  fs.utimesSync(file, when, when);
  return file;
}

