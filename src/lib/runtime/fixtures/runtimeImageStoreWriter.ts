import fs from "node:fs";

import { RuntimeImageStore } from "../runtimeImageStore";

const [root, maxBytesValue, tag, readyFile, startFile] = process.argv.slice(2);
if (!root || !maxBytesValue || !tag || !readyFile || !startFile) process.exit(64);

const header = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
  "hex",
);
const data = Buffer.concat([header, Buffer.alloc(4 * 1024 * 1024, tag.charCodeAt(0))]);
fs.writeFileSync(readyFile, "ready");
while (!fs.existsSync(startFile)) Bun.sleepSync(2);

try {
  new RuntimeImageStore(root, { maxBytes: Number(maxBytesValue) }).putMany([{
    base64: data.toString("base64"),
    mime: "image/png",
  }]);
  process.exit(0);
} catch (error) {
  if (error instanceof Error && error.message.includes("quota exceeded")) process.exit(2);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
