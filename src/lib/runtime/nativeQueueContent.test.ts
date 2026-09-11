import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { nativeQueueInputMatches } from "./nativeQueueContent";
import type { NativeQueueVersion } from "./nativeQueueContracts";

test("native local-image serialization requires the frozen attachment bytes and order", () => {
  const bytes = Buffer.from("synthetic image bytes");
  const version: NativeQueueVersion = { revision: 1, operationId: "op", text: "caption", contentDigest: "digest",
    images: [{ sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, mime: "image/png" }],
    input: [{ type: "localImage", path: "fixtures/image.png" }, { type: "text", text: "caption" }] };
  const input = [{ type: "image" as const, url: `data:image/png;base64,${bytes.toString("base64")}`, detail: null }, { type: "text" as const, text: "caption", text_elements: [] }];
  expect(nativeQueueInputMatches(version, input)).toBeTrue();
  expect(nativeQueueInputMatches(version, [{ ...input[0]!, url: `data:image/png;base64,${Buffer.from("changed image bytes").toString("base64")}` }, input[1]!])).toBeFalse();
  expect(nativeQueueInputMatches(version, [...input].reverse())).toBeFalse();
  expect(nativeQueueInputMatches(version, [input[0]!, { ...input[1]!, text: "changed caption" }])).toBeFalse();
  expect(nativeQueueInputMatches(version, [{ ...input[0]!, detail: "high" }, input[1]!])).toBeFalse();
});
