import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";

function argumentValue(arguments_: string[], flag: string): string | undefined {
  const index = arguments_.indexOf(flag);
  if (index === -1) return undefined;
  const value = arguments_[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function compact(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replaceAll(/[^\p{L}\p{N}]/gu, "");
}

const arguments_ = process.argv.slice(2);
const input = argumentValue(arguments_, "--input");
const output = argumentValue(arguments_, "--output");
if (!input || !output) {
  process.stdout.write("FINGERPRINT CATALOG: FAIL\nconfiguration_error: 1\n");
  process.exit(1);
}

try {
  const inputMetadata = lstatSync(input);
  if (inputMetadata.isSymbolicLink() || !inputMetadata.isFile()) throw new Error("unsafe input");
  if (existsSync(output)) {
    const outputMetadata = lstatSync(output);
    if (outputMetadata.isSymbolicLink() || !outputMetadata.isFile()) throw new Error("unsafe output");
  }
  const fingerprints = new Map<string, { length: number; sha256: string }>();
  for (const line of readFileSync(input, "utf8").split(/\r?\n/)) {
    const value = compact(line.trim());
    if (value.length < 4) continue;
    const sha256 = createHash("sha256").update(value).digest("hex");
    fingerprints.set(`${value.length}:${sha256}`, { length: value.length, sha256 });
  }
  if (fingerprints.size === 0) throw new Error("empty catalog");
  const catalog = {
    schemaVersion: 1,
    normalization: "nfkc-lower-alnum-v1",
    scope: "operator-private-labels",
    fingerprints: [...fingerprints.values()].sort((left, right) => left.length - right.length || left.sha256.localeCompare(right.sha256)),
  };
  writeFileSync(output, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`FINGERPRINT CATALOG: PASS\nfingerprint_count: ${fingerprints.size}\n`);
} catch {
  process.stdout.write("FINGERPRINT CATALOG: FAIL\nconfiguration_error: 1\n");
  process.exitCode = 1;
}
