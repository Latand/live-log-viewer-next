import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-artifact-route-"));
const { GET } = await import("./route");

const savedHome = process.env.HOME;
let home = "";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(sandbox, "home-"));
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = savedHome;
  delete process.env.LLV_ARTIFACT_MAX_BYTES;
});
afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function request(query: Record<string, string>, headers: Record<string, string> = {}): NextRequest {
  const url = new URL("http://127.0.0.1:8898/api/artifact");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return new NextRequest(url, { headers: { host: "127.0.0.1", ...headers } });
}

function write(rel: string, content: string | Buffer): string {
  const abs = path.join(home, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

async function errorCode(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { code?: string }).code;
}

test("serves a text artifact with restrictive headers", async () => {
  const abs = write("notes/build.log", "line one\nline two\n");
  const res = await GET(request({ path: abs }));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("accept-ranges")).toBe("bytes");
  expect(res.headers.get("etag")).toMatch(/^"[^"]+"$/);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(res.headers.get("content-disposition")).toBe('inline; filename="build.log"');
  expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(await res.text()).toBe("line one\nline two\n");
});

test("download mode switches to attachment disposition", async () => {
  const abs = write("notes/report.md", "# heading\n");
  const res = await GET(request({ path: abs, download: "1" }));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-disposition")).toBe('attachment; filename="report.md"');
});

test("a control/quote-bearing filename is sanitized in the disposition", async () => {
  const abs = write('weird"name.txt', "x");
  const res = await GET(request({ path: abs }));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-disposition")).toBe('inline; filename="weird_name_.txt"');
});

test("meta mode returns identity and size, never bytes", async () => {
  const abs = write("src/main.ts", "export const answer = 42;\n");
  const res = await GET(request({ path: abs, mode: "meta" }));
  expect(res.status).toBe(200);
  const meta = (await res.json()) as Record<string, unknown>;
  expect(meta.name).toBe("main.ts");
  expect(meta.kind).toBe("text");
  expect(meta.size).toBe(26);
  expect(typeof meta.etag).toBe("string");
  expect(JSON.stringify(meta)).not.toContain("answer");
});

test("byte ranges return 206 with the exact window", async () => {
  const abs = write("big.txt", "0123456789");
  const res = await GET(request({ path: abs }, { range: "bytes=2-5" }));
  expect(res.status).toBe(206);
  expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
  expect(await res.text()).toBe("2345");
});

test("an unsatisfiable range is 416, not a silent full body", async () => {
  const abs = write("big.txt", "0123456789");
  const res = await GET(request({ path: abs }, { range: "bytes=10-" }));
  expect(res.status).toBe(416);
  expect(res.headers.get("content-range")).toBe("bytes */10");
});

test("If-Match with a stale validator reports the file changed", async () => {
  const abs = write("live.log", "before");
  const first = await GET(request({ path: abs }));
  const etag = first.headers.get("etag")!;
  await first.arrayBuffer();
  const ok = await GET(request({ path: abs }, { "if-match": etag }));
  expect(ok.status).toBe(200);
  await ok.arrayBuffer();
  fs.writeFileSync(abs, "after — different mtime/size");
  const changed = await GET(request({ path: abs }, { "if-match": etag }));
  expect(changed.status).toBe(412);
  expect(await errorCode(changed)).toBe("changed");
});

test("paths outside the allowed roots are denied", async () => {
  const outside = path.join(sandbox, "outside.txt");
  fs.writeFileSync(outside, "secret");
  for (const p of [outside, "/etc/hostname", path.join(home, "..", "escape.txt")]) {
    const res = await GET(request({ path: p }));
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("access-denied");
  }
});

test("a symlink under home escaping the root is denied", async () => {
  const outside = path.join(sandbox, "target.txt");
  fs.writeFileSync(outside, "outside bytes");
  const link = path.join(home, "innocent.txt");
  fs.symlinkSync(outside, link);
  const res = await GET(request({ path: link }));
  expect(res.status).toBe(403);
  expect(await errorCode(res)).toBe("access-denied");
});

test("directories and FIFOs are refused as non-files", async () => {
  const dir = path.join(home, "adir.txt");
  fs.mkdirSync(dir);
  const dirRes = await GET(request({ path: dir }));
  expect(dirRes.status).toBe(404);
  expect(await errorCode(dirRes)).toBe("not-a-file");

  const fifo = path.join(home, "pipe.log");
  execSync(`mkfifo ${JSON.stringify(fifo)}`);
  const fifoRes = await GET(request({ path: fifo }));
  expect(fifoRes.status).toBe(404);
  expect(await errorCode(fifoRes)).toBe("not-a-file");
});

test("a missing file is an explicit 404", async () => {
  const res = await GET(request({ path: path.join(home, "gone.txt") }));
  expect(res.status).toBe(404);
  expect(await errorCode(res)).toBe("not-found");
});

test("unsupported extensions — including .jsonl transcripts — are refused", async () => {
  for (const rel of ["archive.zip", "session.jsonl", "noext"]) {
    const abs = write(rel, "content");
    const res = await GET(request({ path: abs }));
    expect(res.status).toBe(415);
    expect(await errorCode(res)).toBe("unsupported");
  }
});

test("content that contradicts the extension is refused", async () => {
  const fakePng = write("shot.png", "<!DOCTYPE html><script>alert(1)</script>");
  const pngRes = await GET(request({ path: fakePng }));
  expect(pngRes.status).toBe(415);
  expect(await errorCode(pngRes)).toBe("mime-mismatch");
  /* meta refuses too: the mismatch surfaces at open time */
  const pngMeta = await GET(request({ path: fakePng, mode: "meta" }));
  expect(pngMeta.status).toBe(415);

  const fakePdf = write("doc.pdf", "just text, no pdf header");
  const pdfRes = await GET(request({ path: fakePdf }));
  expect(pdfRes.status).toBe(415);
  expect(await errorCode(pdfRes)).toBe("mime-mismatch");

  const binaryTxt = write("data.txt", Buffer.from([0x00, 0x01, 0x02, 0x03]));
  const txtRes = await GET(request({ path: binaryTxt }));
  expect(txtRes.status).toBe(415);
  expect(await errorCode(txtRes)).toBe("mime-mismatch");
});

test("a file over the configured byte bound is refused as too large", async () => {
  process.env.LLV_ARTIFACT_MAX_BYTES = "16";
  const abs = write("huge.txt", "x".repeat(64));
  const res = await GET(request({ path: abs }));
  expect(res.status).toBe(413);
  expect(await errorCode(res)).toBe("too-large");
  const meta = await GET(request({ path: abs, mode: "meta" }));
  /* meta still answers, so the client can show size in the oversized state */
  expect(meta.status).toBe(200);
});

test("SVG is served with a sandboxing CSP; PDF passes magic-byte agreement", async () => {
  const svg = write("art.svg", '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const svgRes = await GET(request({ path: svg }));
  expect(svgRes.status).toBe(200);
  expect(svgRes.headers.get("content-type")).toBe("image/svg+xml");
  expect(svgRes.headers.get("content-security-policy")).toContain("sandbox");
  expect(svgRes.headers.get("content-security-policy")).toContain("script-src 'none'");

  const pdf = write("doc.pdf", "%PDF-1.4\n1 0 obj\nendobj\ntrailer\n%%EOF\n");
  const pdfRes = await GET(request({ path: pdf }));
  expect(pdfRes.status).toBe(200);
  expect(pdfRes.headers.get("content-type")).toBe("application/pdf");
});

test("cross-origin callers are rejected before any disk access", async () => {
  const abs = write("ok.txt", "content");
  const res = await GET(request({ path: abs }, { origin: "https://evil.example" }));
  expect(res.status).toBe(403);
});

test("~ and file:// spellings resolve inside the allowed root", async () => {
  write("linked/readme.md", "hello\n");
  for (const spelling of ["~/linked/readme.md", `file://${home}/linked/readme.md`]) {
    const res = await GET(request({ path: spelling }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello\n");
  }
});
