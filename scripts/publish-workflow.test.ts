import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

const workflow = readFileSync(
  join(import.meta.dir, "..", ".github", "workflows", "publish.yml"),
  "utf8",
);

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function workflowStepScript(stepName: string): string {
  const lines = workflow.split("\n");
  const stepStart = lines.findIndex(
    (line) => line.trim() === `- name: ${stepName}`,
  );
  if (stepStart === -1)
    throw new Error(`Workflow step is missing: ${stepName}`);

  const nextStep = lines.findIndex(
    (line, index) => index > stepStart && /^ {6}- /.test(line),
  );
  const stepEnd = nextStep === -1 ? lines.length : nextStep;
  const runStart = lines.findIndex(
    (line, index) =>
      index > stepStart && index < stepEnd && line.trim() === "run: |",
  );
  if (runStart === -1)
    throw new Error(`Workflow step has no multiline script: ${stepName}`);

  const runIndent = (lines[runStart].match(/^ */)?.[0].length ?? 0) + 2;
  const prefix = " ".repeat(runIndent);
  const script: string[] = [];
  for (const line of lines.slice(runStart + 1, stepEnd)) {
    if (line.length === 0) {
      script.push("");
      continue;
    }
    if (!line.startsWith(prefix)) break;
    script.push(line.slice(runIndent));
  }
  return script.join("\n");
}

const verifyPublishedPackage = workflowStepScript(
  "Verify published package version",
);
const publishPackage = workflowStepScript("Publish package with OIDC").replace(
  /\$\{\{\s*steps\.package\.outputs\.tarball\s*\}\}/g,
  "$NPM_TEST_TARBALL",
);

type VerifyScenario = {
  expectedIntegrity?: string;
  publishedThisRun?: boolean;
  registryIntegrity?: string;
  sequence: string;
  tagVersion?: string;
};

function linesFrom(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

function installNodeEvalShim(bin: string): void {
  const node = join(bin, "node");
  writeFileSync(
    node,
    [
      "#!/bin/sh",
      'if [ "$1" != "-e" ]; then exit 93; fi',
      'script="$2"',
      "shift 2",
      'exec "$NPM_TEST_BUN" -e "$script" "$@"',
      "",
    ].join("\n"),
  );
  chmodSync(node, 0o755);
}

function runVerifyScenario({
  expectedIntegrity = "sha512-fixture-integrity",
  publishedThisRun = true,
  registryIntegrity = "sha512-fixture-integrity",
  sequence,
  tagVersion = "1.2.3",
}: VerifyScenario) {
  const directory = mkdtempSync(join(tmpdir(), "llv-publish-verify-"));
  temporaryDirectories.push(directory);
  const bin = join(directory, "bin");
  const home = join(directory, "home");
  const config = join(directory, "config");
  const state = join(directory, "state");
  const runner = join(directory, "runner");
  const temporary = join(directory, "tmp");
  mkdirSync(bin);
  mkdirSync(home);
  mkdirSync(config);
  mkdirSync(state);
  mkdirSync(runner);
  mkdirSync(temporary);

  const calls = join(directory, "npm-calls");
  const counter = join(directory, "npm-version-count");
  const sleeps = join(directory, "sleep-calls");
  const output = join(directory, "github-output");
  const summary = join(directory, "github-summary");
  const npm = join(bin, "npm");
  writeFileSync(
    npm,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "$NPM_TEST_CALLS"',
      'if [ "$1" != "view" ]; then exit 90; fi',
      'case "$3" in',
      "  version)",
      "    count=0",
      '    if [ -f "$NPM_TEST_COUNTER" ]; then count="$(cat "$NPM_TEST_COUNTER")"; fi',
      "    count=$((count + 1))",
      '    printf \'%s\\n\' "$count" > "$NPM_TEST_COUNTER"',
      '    response="$(printf \'%s\\n\' "$NPM_TEST_SEQUENCE" | awk -F, -v field="$count" \'{ value = $field; if (value == "") value = $NF; print value }\')"',
      '    case "$response" in',
      "      404) printf 'npm error code E404\\n' >&2; exit 1 ;;",
      "      fatal) printf 'npm error code E403 synthetic registry refusal\\n' >&2; exit 43 ;;",
      '      visible) printf \'"%s"\\n\' "$NPM_TEST_VERSION" ;;',
      "      *) exit 92 ;;",
      "    esac",
      "    ;;",
      '  dist-tags) printf \'{"%s":"%s"}\\n\' "$NPM_TEST_TAG" "$NPM_TEST_TAG_VERSION" ;;',
      '  dist.integrity) printf \'"%s"\\n\' "$NPM_TEST_REGISTRY_INTEGRITY" ;;',
      "  *) exit 91 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(npm, 0o755);
  installNodeEvalShim(bin);

  const sleep = join(bin, "sleep");
  writeFileSync(
    sleep,
    '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "$NPM_TEST_SLEEPS"\n',
  );
  chmodSync(sleep, 0o755);

  const result = Bun.spawnSync({
    cmd: ["bash", "-c", verifyPublishedPackage],
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: home,
      XDG_CONFIG_HOME: config,
      LLV_STATE_DIR: state,
      TMPDIR: temporary,
      RUNNER_TEMP: runner,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      PACKAGE_NAME: "fixture-package",
      PACKAGE_VERSION: "1.2.3",
      PUBLISHED_THIS_RUN: publishedThisRun ? "true" : "false",
      PUBLISH_TAG: "latest",
      EXPECTED_INTEGRITY: expectedIntegrity,
      NPM_TEST_CALLS: calls,
      NPM_TEST_COUNTER: counter,
      NPM_TEST_SLEEPS: sleeps,
      NPM_TEST_SEQUENCE: sequence,
      NPM_TEST_VERSION: "1.2.3",
      NPM_TEST_TAG: "latest",
      NPM_TEST_TAG_VERSION: tagVersion,
      NPM_TEST_REGISTRY_INTEGRITY: registryIntegrity,
      NPM_TEST_BUN: process.execPath,
    },
    stderr: "pipe",
    stdout: "pipe",
  });

  return {
    calls: linesFrom(calls),
    exitCode: result.exitCode,
    outputs: linesFrom(output),
    sleeps: linesFrom(sleeps),
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
    summary: existsSync(summary) ? readFileSync(summary, "utf8") : "",
  };
}

test("tag pushes and manual recovery checkout the requested immutable release tag", () => {
  expect(workflow).toContain('      - "v*"');
  expect(workflow).toContain("  workflow_dispatch:");
  expect(workflow).toContain("      tag:");
  expect(workflow).toContain("        required: true");
  expect(workflow).toContain(
    "RELEASE_TAG: ${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name }}",
  );
  expect(workflow).toContain("ref: refs/tags/${{ env.RELEASE_TAG }}");
  expect(workflow).toContain("fetch-depth: 0");
});

test("publication verifies the immutable tag identity before installing dependencies", () => {
  const verification = workflow.indexOf("name: Verify immutable release tag");
  const install = workflow.indexOf("bun install --frozen-lockfile");

  expect(verification).toBeGreaterThan(-1);
  expect(verification).toBeLessThan(install);
  expect(workflow).toContain('if [[ ! "$RELEASE_TAG" =~ ^v');
  expect(workflow).toContain('package_version="$(node -p "require(\'./package.json\').version")"');
  expect(workflow).toContain('tag_object="$(git rev-parse --verify "refs/tags/${RELEASE_TAG}")"');
  expect(workflow).toContain('tag_type="$(git cat-file -t "$tag_object")"');
  expect(workflow).toContain('tag_commit="$(git rev-parse --verify "refs/tags/${RELEASE_TAG}^{commit}")"');
  expect(workflow).toContain('checkout_commit="$(git rev-parse --verify HEAD)"');
  expect(workflow).toContain('git ls-remote origin "refs/tags/${RELEASE_TAG}" "refs/tags/${RELEASE_TAG}^{}"');
  expect(workflow).toContain('if [ "$tag_object" != "$remote_tag_object" ] || [ "$tag_commit" != "$remote_tag_commit" ]; then');
  expect(workflow).toContain('if [ "$checkout_commit" != "$tag_commit" ]; then');
});

test("the exact npm package is built before a narrow hermetic release gate", () => {
  const packageStep = workflow.indexOf("name: Build and inspect npm package");
  const releaseGate = workflow.indexOf("name: Run hermetic release gate");

  expect(packageStep).toBeGreaterThan(-1);
  expect(releaseGate).toBeGreaterThan(packageStep);
  expect(workflow).toContain('npm pack --pack-destination "$package_dir"');
  expect(workflow).toContain("package/bin/cli.mjs");
  expect(workflow).toContain("package/bin/mcp-server.mjs");
  expect(workflow).toContain("package/dist/mcp-server.mjs");
  expect(workflow).toContain("package/dist/standalone/server.js");
  expect(workflow).toContain('node "$extract_dir/package/bin/cli.mjs" --version');
  expect(workflow).toContain(
    "bun test bin/server-runtime.test.ts bin/mcp-server.test.ts docs/media/issue-626/evidence.test.ts",
  );
  expect(workflow).not.toMatch(/^\s*- run: bun test\s*$/m);
  expect(workflow).not.toContain("deepen-to-evidence-revision.sh");
});

test("registry preflight makes trusted publication idempotent and verifies the result", () => {
  const preflight = workflow.indexOf("name: Check npm registry");
  const packageStep = workflow.indexOf("name: Build and inspect npm package");
  const publish = workflow.indexOf("name: Publish package with OIDC");
  const verify = workflow.indexOf("name: Verify published package version");

  expect(workflow).toContain(
    "group: npm-publish-${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name }}",
  );
  expect(preflight).toBeGreaterThan(-1);
  expect(preflight).toBeLessThan(packageStep);
  expect(workflow).toContain('npm view "${package_name}@${package_version}" version --json');
  expect(workflow).toContain("grep -q 'E404'");
  expect(workflow).toContain("if: steps.registry.outputs.exists == 'false'");
  expect(publish).toBeGreaterThan(packageStep);
  expect(workflow).toContain('npm publish "${{ steps.package.outputs.tarball }}"');
  expect(verify).toBeGreaterThan(publish);
  expect(workflow).toContain('npm view "${PACKAGE_NAME}@${PACKAGE_VERSION}" version --json');
  expect(workflow).toContain("id-token: write");
  expect(workflow).not.toContain("NODE_AUTH_TOKEN");
});

test("publication captures the integrity printed for the exact tarball and tag", () => {
  const directory = mkdtempSync(join(tmpdir(), "llv-publish-output-"));
  temporaryDirectories.push(directory);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const calls = join(directory, "npm-calls");
  const output = join(directory, "github-output");
  const tarball = join(directory, "fixture-package.tgz");
  const npm = join(bin, "npm");
  writeFileSync(
    npm,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "$NPM_TEST_CALLS"',
      'printf \'{"fixture-package":{"name":"fixture-package","version":"1.2.3","integrity":"sha512-fixture-integrity"}}\\n\'',
      "",
    ].join("\n"),
  );
  chmodSync(npm, 0o755);
  installNodeEvalShim(bin);

  const result = Bun.spawnSync({
    cmd: ["bash", "-c", publishPackage],
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      GITHUB_OUTPUT: output,
      PACKAGE_NAME: "fixture-package",
      PACKAGE_VERSION: "1.2.3",
      PUBLISH_TAG: "latest",
      NPM_TEST_BUN: process.execPath,
      NPM_TEST_CALLS: calls,
      NPM_TEST_TARBALL: tarball,
    },
    stderr: "pipe",
    stdout: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(linesFrom(calls)).toEqual([`publish ${tarball} --tag latest --json`]);
  expect(linesFrom(output)).toEqual([
    "integrity=sha512-fixture-integrity",
    "tag=latest",
  ]);
  expect(result.stdout.toString()).toContain(
    '"integrity":"sha512-fixture-integrity"',
  );
  expect(result.stderr.toString()).toBe("");
});

test("publish verification backs off through E404 before checking tag and integrity", () => {
  const result = runVerifyScenario({ sequence: "404,404,visible" });

  expect(result.exitCode).toBe(0);
  expect(
    result.calls.filter((call) => call.endsWith(" version --json")),
  ).toHaveLength(3);
  expect(result.calls.some((call) => call.endsWith(" dist-tags --json"))).toBe(
    true,
  );
  expect(
    result.calls.some((call) => call.endsWith(" dist.integrity --json")),
  ).toBe(true);
  expect(result.sleeps).toEqual(["5", "10"]);
  expect(result.outputs).toContain("visibility=visible");
  expect(result.stdout).toContain(
    "Verified fixture-package@1.2.3, dist-tag latest, and dist.integrity",
  );
  expect(result.stderr).toBe("");
});

test("an already-published visible version passes without a publish integrity output", () => {
  const result = runVerifyScenario({
    expectedIntegrity: "",
    publishedThisRun: false,
    sequence: "visible",
  });

  expect(result.exitCode).toBe(0);
  expect(result.outputs).toContain("visibility=visible");
  expect(
    result.calls.some((call) => call.endsWith(" dist.integrity --json")),
  ).toBe(true);
});

test("publish verification fails on the first non-E404 registry error", () => {
  const result = runVerifyScenario({ sequence: "fatal" });

  expect(result.exitCode).toBe(43);
  expect(result.calls).toHaveLength(1);
  expect(result.sleeps).toEqual([]);
  expect(result.stderr).toContain("E403 synthetic registry refusal");
});

test("a successful publish timeout reports a pending visibility outcome", () => {
  const result = runVerifyScenario({ sequence: "404" });

  expect(result.exitCode).toBe(0);
  expect(
    result.calls.filter((call) => call.endsWith(" version --json")),
  ).toHaveLength(11);
  expect(result.sleeps).toEqual([
    "5",
    "10",
    "20",
    "30",
    "45",
    "60",
    "75",
    "90",
    "120",
    "120",
  ]);
  expect(result.outputs).toContain("visibility=pending");
  expect(result.stdout).toContain("Published, not yet visible");
  expect(result.summary).toContain("Published, not yet visible");
});

test("publish verification rejects a dist-tag that points elsewhere", () => {
  const result = runVerifyScenario({
    sequence: "visible",
    tagVersion: "1.2.2",
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(
    "dist-tag latest points at 1.2.2, expected 1.2.3",
  );
});

test("publish verification rejects registry integrity drift", () => {
  const result = runVerifyScenario({
    registryIntegrity: "sha512-other-fixture-integrity",
    sequence: "visible",
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(
    "dist.integrity does not match the published tarball",
  );
});
