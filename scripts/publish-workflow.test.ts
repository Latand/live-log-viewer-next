import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";

const workflow = readFileSync(
  join(import.meta.dir, "..", ".github", "workflows", "publish.yml"),
  "utf8",
);

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
