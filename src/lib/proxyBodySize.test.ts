import { expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { getCloneableBody } from "next/dist/server/body-streams";

import nextConfig from "../../next.config";
import { MAX_INBOX_FILES_TOTAL_BYTES } from "./filePolicy";
import { admitRuntimeImagePayload } from "./runtime/runtimeImageAdmission";
import { MAX_STRUCTURED_IMAGE_TOTAL_BYTES } from "./runtime/runtimeImageStore";

function png(bytes: number) {
  const data = Buffer.alloc(bytes);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
  data.write("IHDR", 12, "ascii");
  return { mime: "image/png", base64: data.toString("base64") };
}

async function throughProxy(value: unknown, limit = nextConfig.experimental?.proxyClientMaxBodySize) {
  if (limit !== undefined && typeof limit !== "number") throw new Error("Expected a byte limit");
  const wire = Buffer.from(JSON.stringify(value));
  const incoming = new Readable({ read() {} });
  const body = getCloneableBody(incoming as unknown as IncomingMessage, limit);
  const clone = body.cloneBodyStream();
  const proxyRead = (async () => {
    for await (const _chunk of clone) { /* Consume the proxy's copy. */ }
  })();
  for (let offset = 0; offset < wire.length; offset += 64 * 1024) {
    incoming.push(wire.subarray(offset, offset + 64 * 1024));
  }
  incoming.push(null);
  await proxyRead;
  await body.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString());
}

test("four admitted images survive the installed Next proxy clone", async () => {
  const images = Array.from({ length: 4 }, () => png(3 * 1024 * 1024));
  expect(admitRuntimeImagePayload({ images }).error).toBeNull();
  const received = await throughProxy({ text: "Inspect these images", images });
  expect(received.images).toEqual(images);
  expect(received.text).toBe("Inspect these images");
});

test("the combined supported image and file payload reaches the route intact", async () => {
  const images = Array.from({ length: 4 }, () => png(MAX_STRUCTURED_IMAGE_TOTAL_BYTES / 4));
  const files = Array.from({ length: 2 }, (_, i) => ({
    name: `attachment-${i}.bin`, mime: "application/octet-stream",
    base64: Buffer.alloc(MAX_INBOX_FILES_TOTAL_BYTES / 2).toString("base64"),
  }));
  const received = await throughProxy({ text: "Inspect attachments", images, files });
  expect(received.images.map((image: { base64: string }) => image.base64.length))
    .toEqual(images.map(image => image.base64.length));
  expect(received.files.map((file: { base64: string }) => file.base64.length))
    .toEqual(files.map(file => file.base64.length));
});

test("transport capacity preserves the runtime image admission limit", async () => {
  const images = Array.from({ length: 4 }, () => png(5 * 1024 * 1024));
  const received = await throughProxy({ images });
  expect(admitRuntimeImagePayload(received).error?.status).toBe(413);
});

test("the old 10 MiB boundary reproduces the invalid JSON incident", async () => {
  const images = Array.from({ length: 4 }, () => png(3 * 1024 * 1024));
  await expect(throughProxy({ images }, 10 * 1024 * 1024)).rejects.toBeInstanceOf(SyntaxError);
});
