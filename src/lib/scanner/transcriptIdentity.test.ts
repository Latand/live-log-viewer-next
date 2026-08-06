import { mkdir, mkdtemp, rm } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { canonicalizeTranscriptPaths, createTranscriptPathCanonicalizer } from "./transcriptIdentity";

test("an account home symlinked into the shared store resolves to the walked root", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-transcript-identity-"));
  try {
    const shared = path.join(base, "shared", "claude", "projects");
    const accountProjects = path.join(base, "account", "projects");
    await mkdir(path.join(shared, "-repo"), { recursive: true });
    await mkdir(path.dirname(accountProjects), { recursive: true });
    fs.symlinkSync(shared, accountProjects);

    const canonicalize = createTranscriptPathCanonicalizer([shared], [accountProjects]);
    expect(canonicalize(path.join(accountProjects, "-repo", "live.jsonl")))
      .toBe(path.join(shared, "-repo", "live.jsonl"));
    /* Already canonical, and a path under no known root, both pass through. */
    expect(canonicalize(path.join(shared, "-repo", "live.jsonl")))
      .toBe(path.join(shared, "-repo", "live.jsonl"));
    expect(canonicalize("/elsewhere/live.jsonl")).toBe("/elsewhere/live.jsonl");
    /* A deleted transcript still canonicalizes: only the root prefix is resolved. */
    expect(canonicalize(path.join(accountProjects, "-repo", "deleted.jsonl")))
      .toBe(path.join(shared, "-repo", "deleted.jsonl"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("an alias that names a different tree, or no alias at all, leaves paths untouched", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-transcript-identity-distinct-"));
  try {
    const walked = path.join(base, "walked");
    const other = path.join(base, "other");
    await mkdir(walked, { recursive: true });
    await mkdir(other, { recursive: true });

    expect(createTranscriptPathCanonicalizer([walked], [other])(path.join(other, "a.jsonl")))
      .toBe(path.join(other, "a.jsonl"));
    expect(createTranscriptPathCanonicalizer([], [other])(path.join(other, "a.jsonl")))
      .toBe(path.join(other, "a.jsonl"));
    /* A root that does not exist contributes no rewrite instead of throwing. */
    expect(createTranscriptPathCanonicalizer([path.join(base, "missing")], [other])(path.join(other, "a.jsonl")))
      .toBe(path.join(other, "a.jsonl"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("canonicalizing a path set keeps both forms so either still matches", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-transcript-identity-set-"));
  try {
    const shared = path.join(base, "shared");
    const alias = path.join(base, "alias");
    await mkdir(shared, { recursive: true });
    fs.symlinkSync(shared, alias);
    const canonicalize = createTranscriptPathCanonicalizer([shared], [alias]);

    const canonical = canonicalizeTranscriptPaths(new Set([path.join(alias, "pin.jsonl")]), canonicalize);
    expect(canonical).toEqual(new Set([path.join(alias, "pin.jsonl"), path.join(shared, "pin.jsonl")]));
    expect(canonicalizeTranscriptPaths(undefined, canonicalize)).toBeUndefined();
    expect(canonicalizeTranscriptPaths(new Set(), canonicalize)).toEqual(new Set());
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
