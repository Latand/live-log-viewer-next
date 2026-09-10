import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { normalizedCodexHistoryContent } from "./codexHistoryReader";
import type { NativeQueueInput } from "./nativeCodexQueue";
import type { NativeQueueVersion } from "./nativeQueueContracts";

/** Native queue admission serializes local images as data URLs. Match those
 * bytes to the frozen image refs before restoring their prepared representation.
 * A changed image or an unproven conversion remains a payload conflict. */
export function normalizeNativeQueueObservation(version: NativeQueueVersion, observed: NativeQueueInput[]): NativeQueueInput[] | null {
  if (!version.input || observed.length !== version.input.length) return null;
  let imageIndex = 0;
  return observed.map((value, index) => {
    const expected = version.input![index]!;
    if (expected.type !== "localImage") return value;
    const image = version.images[imageIndex++];
    if (value.type !== "image" || typeof value.url !== "string" || !image) return value;
    const match = value.url.match(/^data:(image\/[a-z]+);base64,([A-Za-z0-9+/]*={0,2})$/);
    if (!match || match[1] !== image.mime) return value;
    const bytes = Buffer.from(match[2]!, "base64");
    if (bytes.length !== image.bytes || createHash("sha256").update(bytes).digest("hex") !== image.sha256) return value;
    const { type: _type, url: _url, ...rest } = value;
    return { ...rest, type: "localImage" as const, path: expected.path as string };
  });
}

export function nativeQueueInputMatches(version: NativeQueueVersion, observed: NativeQueueInput[]): boolean {
  const normalized = normalizeNativeQueueObservation(version, observed);
  return !!version.input && !!normalized
    && isDeepStrictEqual(normalizedCodexHistoryContent(version.input), normalizedCodexHistoryContent(normalized));
}
