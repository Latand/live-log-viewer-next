import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

/* The job in `bun-runtime.yml` is the answer to "nobody here can reproduce
   that": it runs the runtime verification at the pull request's own commit so
   the evidence has a SHA on it. A job that runs those checks and then does not
   care what they said would be worse than no job, because it produces the
   artefact a reviewer asked for without the substance. That property is what
   this file holds. */

const repositoryRoot = path.join(import.meta.dir, "..");
const workflowSource = fs.readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "bun-runtime.yml"),
  "utf8",
);
const dockerfile = fs.readFileSync(path.join(repositoryRoot, "Dockerfile"), "utf8");

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  "continue-on-error"?: unknown;
  with?: Record<string, string>;
}

const workflow = Bun.YAML.parse(workflowSource) as {
  jobs: Record<string, { steps: WorkflowStep[] }>;
};
const steps = workflow.jobs["bun-runtime"].steps;
const scripts = steps.map((step) => step.run ?? "");

test("the job performs the runtime verification the pull request cannot prove locally", () => {
  // The Viewer half: the compiled server runtimes load, and the served build
  // answers 200. The host half: a completed succession, endpoints held.
  expect(scripts).toContain("bun scripts/verify-viewer-runtime.ts");
  expect(scripts).toContain("bun scripts/verify-runtime-host.ts");
  expect(scripts.some((script) => script.includes("bun run build"))).toBe(true);
});

test("no step can fail without failing the job", () => {
  for (const step of steps) {
    expect(step["continue-on-error"]).toBeUndefined();
    // A conditional step is a step that can decline to run, and a check that
    // did not run reports nothing while the job still reports success.
    expect(step.if).toBeUndefined();
  }
  for (const script of scripts) {
    for (const swallow of ["|| true", "|| echo", "set +e", "continue-on-error"]) {
      expect(script).not.toContain(swallow);
    }
    // The pinned-interpreter and pin-resolution steps are pipelines, where a
    // failure in any but the last command is invisible without `pipefail`.
    if (script.includes("|")) expect(script).toContain("set -euo pipefail");
  }
});

test("the interpreter under test is the pin the image ships, not a version written here", () => {
  const setupBun = steps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
  expect(setupBun?.with?.["bun-version"]).toBe("${{ steps.pin.outputs.version }}");
  // The Dockerfile's three pins agree — `dockerfile-permissions.test.ts` holds
  // that — so resolving them here is what makes a future move self-verifying.
  expect(workflowSource).toContain("npm install -g bun@[0-9]+\\.[0-9]+\\.[0-9]+");
  expect(dockerfile).toContain("npm install -g bun@");
});

test("the job runs at the pull request's own commit", () => {
  const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  expect(checkout?.with?.ref).toContain("github.event.pull_request.head.sha");
});
