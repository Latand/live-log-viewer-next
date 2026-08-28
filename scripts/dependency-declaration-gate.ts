import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// A merge, not a branch, is what changes the default branch's dependencies.
// #1246 arrived that way: a pull request that had branched before a dependency
// bump was updated onto the default branch, the update resolved package.json
// and bun.lock to the branch's older side, and the revert landed inside a pull
// request whose description was about something else entirely. Nobody chose it,
// nobody reviewed it, and the same mechanism could undo a security update.
//
// So the comparison here is the merge result against the base - which is what
// the checkout already is under `pull_request`, where HEAD is the pull
// request's merge ref - and the rule is about silence rather than about change:
// a dependency version the merge would move has to be named somewhere a reader
// looks. An ordinary bump names its packages already (Dependabot lists every
// one of them), so this stays quiet for the changes people actually make, and
// fires on the one nobody wrote down.

export const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bundledDependencies",
  "bundleDependencies",
  "overrides",
  "resolutions",
] as const;

export type DependencyChange = {
  section: string;
  name: string;
  from: string | null;
  to: string | null;
};

type PackageManifest = Record<string, unknown>;

const entries = (manifest: PackageManifest, section: string): Map<string, string> => {
  const value = manifest[section];
  const result = new Map<string, string>();
  if (Array.isArray(value)) {
    // bundledDependencies is a name list rather than a version map.
    for (const name of value) if (typeof name === "string") result.set(name, "bundled");
    return result;
  }
  if (!value || typeof value !== "object") return result;
  for (const [name, requirement] of Object.entries(value as Record<string, unknown>)) {
    result.set(name, typeof requirement === "string" ? requirement : JSON.stringify(requirement));
  }
  return result;
};

export function dependencyChanges(base: PackageManifest, merged: PackageManifest): DependencyChange[] {
  const changes: DependencyChange[] = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const before = entries(base, section);
    const after = entries(merged, section);
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      const from = before.get(name) ?? null;
      const to = after.get(name) ?? null;
      if (from !== to) changes.push({ section, name, from, to });
    }
  }
  return changes.sort((left, right) => left.name.localeCompare(right.name));
}

// A package counts as declared when its own name appears in the text a reviewer
// reads. The boundaries keep one name from standing in for another: a
// description that names `eslint-config-next` has not declared `next`.
export function declaresPackage(declaration: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_./@-])${escaped}(?![A-Za-z0-9_./-])`, "i").test(declaration);
}

export function describeChange(change: DependencyChange): string {
  if (change.from === null) return `${change.name} added as ${change.to} in ${change.section}`;
  if (change.to === null) return `${change.name} removed from ${change.section} (was ${change.from})`;
  return `${change.name} ${change.from} -> ${change.to} in ${change.section}`;
}

export type GateInput = {
  basePackage: PackageManifest;
  mergedPackage: PackageManifest;
  baseLockfile: string | null;
  mergedLockfile: string | null;
  /** Title and body of the pull request, or null when no pull request payload is available. */
  declaration: string | null;
};

export type GateVerdict = {
  ok: boolean;
  changes: DependencyChange[];
  failures: string[];
  notes: string[];
};

export function dependencyDeclarationVerdict(input: GateInput): GateVerdict {
  const changes = dependencyChanges(input.basePackage, input.mergedPackage);
  const failures: string[] = [];
  const notes: string[] = [];

  if (changes.length === 0) {
    notes.push("The merge result changes no package.json dependency entry");
    return { ok: true, changes, failures, notes };
  }

  // The lockfile rule from #1156: a resolved tree the manifest no longer
  // describes is the other way a dependency change reaches the image unread.
  if (input.baseLockfile === input.mergedLockfile) {
    failures.push(
      `The merge would change ${changes.length} dependency ${changes.length === 1 ? "entry" : "entries"}`
      + " without changing bun.lock: "
      + changes.map(describeChange).join("; "),
    );
  }

  if (input.declaration === null) {
    notes.push("No pull request description available; the declaration rule was not applied");
    return { ok: failures.length === 0, changes, failures, notes };
  }

  const undeclared = changes.filter((change) => !declaresPackage(input.declaration ?? "", change.name));
  if (undeclared.length > 0) {
    failures.push(
      "The merge would change dependency versions this pull request does not mention: "
      + undeclared.map(describeChange).join("; ")
      + ". Name each package in the pull request description - or drop the change from the branch if the"
      + " merge is reverting somebody else's.",
    );
  }
  return { ok: failures.length === 0, changes, failures, notes };
}

const readManifest = (revision: string, repository: string): PackageManifest => {
  const raw = execFileSync("git", ["-C", repository, "show", `${revision}:package.json`], { encoding: "utf8" });
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error(`${revision}:package.json is not an object`);
  return parsed as PackageManifest;
};

// The lockfile is compared by its blob id: identical content is the whole
// question, and the file is far too large to read for it.
const readLockfileId = (revision: string, repository: string): string | null => {
  try {
    return execFileSync("git", ["-C", repository, "rev-parse", `${revision}:bun.lock`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};

const argument = (name: string): string | null => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
};

if (import.meta.main) {
  const repository = argument("repository") ?? process.cwd();
  const merged = argument("merge") ?? "HEAD";
  // Under `pull_request` the checkout is the merge ref, so its first parent is
  // the base commit the merge would land on. That is the revision this compares
  // against unless the caller names one.
  const base = argument("base") ?? `${merged}^1`;
  const declarationFile = argument("declaration");

  const verdict = dependencyDeclarationVerdict({
    basePackage: readManifest(base, repository),
    mergedPackage: readManifest(merged, repository),
    baseLockfile: readLockfileId(base, repository),
    mergedLockfile: readLockfileId(merged, repository),
    declaration: declarationFile === null ? null : readFileSync(declarationFile, "utf8"),
  });

  for (const note of verdict.notes) console.log(note);
  if (verdict.changes.length > 0) {
    console.log(`Dependency entries the merge would change, against ${base}:`);
    for (const change of verdict.changes) console.log(`  ${describeChange(change)}`);
  }
  for (const failure of verdict.failures) console.error(`::error::${failure}`);
  if (!verdict.ok) process.exit(1);
  // Only claim the declaration rule passed when it actually ran: a dispatched
  // run has no pull request to read, and saying otherwise would report a check
  // that never happened.
  if (verdict.changes.length > 0 && declarationFile !== null) {
    console.log("Every changed package is named in the pull request description");
  }
}
