import { constants as FS, type promises as fsp } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { classifyArtifact } from "@/lib/artifact/classify";
import { artifactEtag, artifactLimits, dispositionFilename, parseByteRange, sniffAgrees } from "@/lib/artifact/serve";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The ONE narrow resource route behind the issue #875 document preview: serves
 * the bytes of a single previewable artifact (PDF, inert image, bounded text)
 * that a conversation linked, and nothing else.
 *
 * Access model — identical to /api/image, the existing local-bytes route: the
 * same-origin/Host gate IS the operator authority on this loopback service
 * (see `page.tsx`), and the allowed-root policy confines reads to the
 * operator's home, where every agent workspace and transcript artifact lives.
 *
 * Containment is enforced twice (lexical resolve, then realpath) so neither
 * `..` traversal nor a symlink under home may reach outside it; the final open
 * is O_NOFOLLOW against the resolved real path, and everything after — the
 * regular-file check, the size bound, the validator, the sniff and every
 * streamed byte — reads through that one file descriptor, so a rename or
 * replacement mid-response can never splice a different file's bytes in.
 */

type FailCode =
  | "access-denied"
  | "not-found"
  | "not-a-file"
  | "unsupported"
  | "mime-mismatch"
  | "too-large"
  | "changed";

interface FailBody extends ApiError {
  code: FailCode;
}

const FAIL_STATUS: Record<FailCode, number> = {
  "access-denied": 403,
  "not-found": 404,
  "not-a-file": 404,
  unsupported: 415,
  "mime-mismatch": 415,
  "too-large": 413,
  changed: 412,
};

function fail(code: FailCode, error: string): NextResponse<FailBody> {
  return NextResponse.json({ error, code }, { status: FAIL_STATUS[code] });
}

/* $HOME first: it is what the isolated demo/evidence runtimes (and tests)
   repoint, and Bun's os.homedir() ignores the env override. */
function homeRoot(): string {
  return path.resolve(process.env.HOME || os.homedir());
}

function resolveLocal(raw: string): string {
  let p = raw.replace(/^file:\/\//, "");
  if (p === "~" || p.startsWith("~/")) p = path.join(homeRoot(), p.slice(1));
  return path.resolve(p);
}

function underRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/** How much of the head the extension agreement looks at. */
const SNIFF_BYTES = 512;
/** One streamed read; also the natural rhythm the deadline is checked at. */
const STREAM_CHUNK = 64 * 1024;

function baseHeaders(mime: string, etag: string, name: string, download: boolean): Headers {
  const headers = new Headers({
    "content-type": mime,
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    etag,
    "content-disposition": `${download ? "attachment" : "inline"}; filename="${dispositionFilename(name)}"`,
  });
  /* Everything the preview serves is inert data. PDF is exempted from the
     sandbox directive only because browser PDF viewers refuse sandboxed
     documents on "open externally", and a PDF response can never script the
     app origin; SVG (and everything else) stays fully sandboxed, so even a
     direct navigation to the raw URL renders in an origin-less, script-less
     document. */
  headers.set(
    "content-security-policy",
    mime === "application/pdf"
      ? "default-src 'none'; object-src 'none'"
      : "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'",
  );
  return headers;
}

/**
 * Streams `[start, end]` from the pinned descriptor, honouring the request's
 * AbortSignal (the preview closing cancels the fetch) and the configured time
 * budget. The descriptor is closed on completion, cancellation and error —
 * exactly once.
 */
function streamWindow(
  handle: fsp.FileHandle,
  start: number,
  end: number,
  signal: AbortSignal,
  timeBudgetMs: number,
): ReadableStream<Uint8Array> {
  let position = start;
  const deadline = Date.now() + timeBudgetMs;
  let done = false;
  const finish = async () => {
    if (done) return;
    done = true;
    await handle.close().catch(() => {});
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal.aborted || Date.now() > deadline) {
        await finish();
        controller.error(new Error(signal.aborted ? "client aborted" : "artifact time budget exceeded"));
        return;
      }
      const want = Math.min(STREAM_CHUNK, end - position + 1);
      if (want <= 0) {
        await finish();
        controller.close();
        return;
      }
      const buffer = Buffer.alloc(want);
      try {
        const { bytesRead } = await handle.read(buffer, 0, want, position);
        if (bytesRead <= 0) {
          /* The pinned inode ended early (truncated in place): end the body
             rather than hang — the client's validator round-trip reports it. */
          await finish();
          controller.close();
          return;
        }
        position += bytesRead;
        controller.enqueue(new Uint8Array(buffer.subarray(0, bytesRead)));
      } catch (error) {
        await finish();
        controller.error(error);
      }
    },
    async cancel() {
      await finish();
    },
  });
}

export async function GET(req: NextRequest): Promise<NextResponse<FailBody> | NextResponse> {
  /* Same gate as every other loopback route: a drive-by page or DNS rebind
     must not pull local file bytes out of this service. */
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  const raw = req.nextUrl.searchParams.get("path") ?? "";
  if (!raw) return NextResponse.json({ error: "path is required" }, { status: 400 });

  const abs = resolveLocal(raw);
  const home = homeRoot();
  if (!underRoot(abs, home)) return fail("access-denied", "path is outside the allowed roots");

  const classified = classifyArtifact(abs);
  if (!classified) return fail("unsupported", "not a previewable artifact type");
  const { kind, mime } = classified;
  const name = path.basename(abs);

  /* Resolve symlinks, then re-check containment: ~/x.pdf → /anywhere must not
     read outside the root. The home root itself is realpathed so a symlinked
     home directory compares canonically. */
  let real: string;
  let realHome: string;
  try {
    realHome = await fs.realpath(home);
    real = await fs.realpath(abs);
  } catch {
    return fail("not-found", "file not found");
  }
  if (!underRoot(real, realHome)) return fail("access-denied", "path is outside the allowed roots");

  /* O_NOFOLLOW: realpath resolved every link above; a symlink appearing at the
     final component between then and now is a race, refused. O_NONBLOCK keeps
     a FIFO from wedging the open — its fstat below rejects it anyway. */
  let handle: fsp.FileHandle;
  try {
    handle = await fs.open(real, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fail("not-found", "file not found");
    if (code === "ELOOP" || code === "EMLINK") return fail("access-denied", "path is outside the allowed roots");
    if (code === "EISDIR") return fail("not-a-file", "not a regular file");
    return fail("access-denied", "file is not readable");
  }

  /* Everything below reads through the pinned descriptor. */
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close();
      return fail("not-a-file", "not a regular file");
    }

    const etag = artifactEtag(stat);
    const limits = artifactLimits();
    const download = req.nextUrl.searchParams.get("download") === "1";

    if (req.nextUrl.searchParams.get("mode") === "meta") {
      await handle.close();
      return NextResponse.json(
        { name, kind, mime, size: stat.size, mtimeMs: Math.round(stat.mtimeMs), etag },
        { headers: { "cache-control": "private, no-store" } },
      );
    }

    const ifMatch = req.headers.get("if-match");
    if (ifMatch !== null && ifMatch !== etag) {
      await handle.close();
      return fail("changed", "file changed since the preview opened");
    }

    if (stat.size > limits.maxBytes) {
      await handle.close();
      return fail("too-large", "artifact exceeds the configured byte bound");
    }

    const head = Buffer.alloc(Math.min(SNIFF_BYTES, stat.size));
    if (head.length > 0) await handle.read(head, 0, head.length, 0);
    if (!sniffAgrees(mime, head)) {
      await handle.close();
      return fail("mime-mismatch", "file content does not match its extension");
    }

    const headers = baseHeaders(mime, etag, name, download);
    const range = parseByteRange(req.headers.get("range"), stat.size);
    if (range === "unsatisfiable") {
      await handle.close();
      headers.set("content-range", `bytes */${stat.size}`);
      return new NextResponse(null, { status: 416, headers });
    }

    const window = range ?? { start: 0, end: stat.size - 1 };
    const length = stat.size === 0 ? 0 : window.end - window.start + 1;
    headers.set("content-length", String(Math.max(length, 0)));
    if (range) headers.set("content-range", `bytes ${range.start}-${range.end}/${stat.size}`);
    if (length <= 0) {
      await handle.close();
      return new NextResponse(null, { status: range ? 206 : 200, headers });
    }
    const body = streamWindow(handle, window.start, window.end, req.signal, limits.timeBudgetMs);
    return new NextResponse(body, { status: range ? 206 : 200, headers });
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}
