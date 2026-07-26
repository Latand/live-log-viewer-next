import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Atomic, durable JSON state write: temp file, fsync, rename, fsync the
 * directory. A plain `writeFileSync` + `rename` publishes a name that may point
 * at unwritten data after a crash, which for an append-only durable record is
 * indistinguishable from losing history.
 *
 * Mirrors the pattern the board and account stores already use, factored out so
 * every durable state file in `state/` is written the same way.
 */
export function writeJsonDurably(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temp, target);
    const directory = fs.openSync(path.dirname(target), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(temp, { force: true });
  }
}
