import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureCanonicalMirror, resolveCanonicalRevision } from "./canonicalMirror";

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

test("restart replaces an interrupted initial clone with a validated mirror", async () => {
  const deploymentDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-canonical-mirror-"));
  sandboxes.push(deploymentDir);
  const mirrorDir = path.join(deploymentDir, "canonical.git");
  const incomingDir = `${mirrorDir}.incoming`;
  const validMirrors = new Set<string>();
  const calls: string[][] = [];
  let cloneAttempts = 0;
  const run = async (argv: string[]): Promise<string> => {
    calls.push(argv);
    if (argv[0] === "git" && argv[1] === "clone") {
      cloneAttempts += 1;
      const destination = argv.at(-1)!;
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, cloneAttempts === 1 ? "partial" : "HEAD"), "fixture");
      if (cloneAttempts === 1) throw new Error("clone interrupted");
      validMirrors.add(destination);
      return "";
    }
    if (argv.includes("rev-parse")) {
      const gitDir = argv[argv.indexOf("--git-dir") + 1]!;
      if (!validMirrors.has(gitDir)) throw new Error("invalid bare repository");
      return "true";
    }
    return "";
  };

  await expect(ensureCanonicalMirror({ deploymentDir, mirrorDir, remote: "ssh://canonical" }, { run })).rejects.toThrow("clone interrupted");
  expect(fs.existsSync(mirrorDir)).toBe(false);
  expect(fs.existsSync(path.join(incomingDir, "partial"))).toBe(true);

  await ensureCanonicalMirror({ deploymentDir, mirrorDir, remote: "ssh://canonical" }, { run });

  expect(cloneAttempts).toBe(2);
  expect(fs.existsSync(path.join(mirrorDir, "HEAD"))).toBe(true);
  expect(fs.existsSync(incomingDir)).toBe(false);
  expect(calls.some((argv) => argv.includes("set-url"))).toBe(true);
  expect(calls.some((argv) => argv.includes("fetch"))).toBe(true);
});

function resolver(objects: Record<string, string>) {
  const queries: string[] = [];
  let ensured = 0;
  const run = async (argv: string[]): Promise<string> => {
    const query = argv.at(-1)!;
    queries.push(query);
    const resolved = objects[query];
    if (resolved === undefined) throw new Error("fatal: Needed a single revision");
    return resolved;
  };
  return { queries, run, ensureMirror: async () => { ensured += 1; }, ensuredCount: () => ensured };
}

test("a canonical branch ref resolves to the tip commit the mirror holds", async () => {
  const tip = "a".repeat(40);
  const fixture = resolver({ "refs/heads/main^{commit}": tip, "refs/heads/agent/lane^{commit}": "b".repeat(40) });

  await expect(resolveCanonicalRevision("origin/main", { mirrorDir: "/mirror", remote: "ssh://canonical" }, fixture)).resolves.toBe(tip);
  await expect(resolveCanonicalRevision("refs/heads/main", { mirrorDir: "/mirror", remote: "ssh://canonical" }, fixture)).resolves.toBe(tip);
  await expect(resolveCanonicalRevision("refs/heads/agent/lane", { mirrorDir: "/mirror", remote: "ssh://canonical" }, fixture)).resolves.toBe("b".repeat(40));
  expect(fixture.ensuredCount()).toBe(3);
});

test("an exact revision is peeled to a commit, so a well-formed SHA the mirror lacks is a miss (#1032)", async () => {
  const present = "c".repeat(40);
  const absent = "d".repeat(40);
  const fixture = resolver({ [`${present}^{commit}`]: present });

  await expect(resolveCanonicalRevision(present, { mirrorDir: "/mirror", remote: "ssh://canonical" }, fixture)).resolves.toBe(present);
  await expect(resolveCanonicalRevision(absent, { mirrorDir: "/mirror", remote: "ssh://canonical" }, fixture))
    .rejects.toThrow(`revision ${absent} not found in the canonical repository (fetched from ssh://canonical)`);
  expect(fixture.queries).toEqual([`${present}^{commit}`, `${absent}^{commit}`]);
});

test("a request that names neither a branch of the canonical repository nor a SHA never reaches git", async () => {
  const fixture = resolver({});

  for (const requested of ["refs/tags/v1", "main", "HEAD", "refs/heads/main~1", "--upload-pack=touch"]) {
    await expect(resolveCanonicalRevision(requested, { mirrorDir: "/mirror", remote: "ssh://canonical" }, fixture))
      .rejects.toThrow("deployment revision must be origin/main, a canonical branch ref, or a full commit SHA");
  }
  expect(fixture.queries).toEqual([]);
  expect(fixture.ensuredCount()).toBe(0);
});
