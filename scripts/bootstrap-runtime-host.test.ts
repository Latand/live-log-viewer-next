import { expect, test } from "bun:test";
import fs from "node:fs";

import { parseArguments } from "./bootstrap-runtime-host";

const source = fs.readFileSync(new URL("./bootstrap-runtime-host.ts", import.meta.url), "utf8");

test("issue 1216: the bootstrap plans by default and never mutates without an explicit mode", () => {
  expect(parseArguments([])).toEqual({ revision: "origin/main", mode: "plan" });
  expect(parseArguments(["a".repeat(40)])).toEqual({ revision: "a".repeat(40), mode: "plan" });
  expect(parseArguments(["--stage"])).toEqual({ revision: "origin/main", mode: "stage" });
  expect(parseArguments(["a".repeat(40), "--hand-over"])).toEqual({ revision: "a".repeat(40), mode: "hand-over" });
});

test("issue 1216: the bootstrap refuses arguments it does not understand", () => {
  expect(() => parseArguments(["--force"])).toThrow("unsupported option --force");
  expect(() => parseArguments(["main"])).toThrow("invalid revision: use origin/main or a full lowercase commit SHA");
  expect(() => parseArguments(["a".repeat(40), "b".repeat(40)])).toThrow("only one revision may be given");
});

/* The machine this runs on owns live agent sessions, so the statement of what
   will be stopped has to precede every mutation — the image build, the
   staging, and the predecessor stop alike. */
test("issue 1216: the plan is rendered before anything is built, staged, or stopped", () => {
  const planAt = source.indexOf("console.log(renderRuntimeHostBootstrapPlan(plan))");
  const buildAt = source.indexOf("await buildRuntimeHostImage(revision, image)");
  const executeAt = source.indexOf("await executeRuntimeHostBootstrap(plan, candidate,");

  expect(planAt).toBeGreaterThanOrEqual(0);
  expect(buildAt).toBeGreaterThan(planAt);
  expect(executeAt).toBeGreaterThan(buildAt);
});

/* An operator stages now and hands over when they are ready, so the successor
   this script creates has to wait without the #518 deadline — that bound
   exists for a hand-over already in flight, and here there is none until the
   operator starts one. */
test("issue 1216: the bootstrap stages its successor parked rather than on the deployment fence budget", () => {
  expect(source).toContain('fenceWait: "parked"');
  expect(source).not.toContain("LLV_RUNTIME_HOST_FENCE_WAIT_MS");
});

/* The bootstrap replaces the runtime-host generation and nothing else. A
   Viewer container stop or removal here would take down the promoted release
   and the agent sessions inside it. */
test("issue 1216: the bootstrap never stops or removes a Viewer release container", () => {
  expect(source).not.toContain('"container", "rm"');
  expect(source).not.toContain("retireRelease");
  expect(source).not.toContain("switchTarget");
  /* The single stop it performs is the predecessor runtime-host container,
     reached only through the hand-over port. */
  expect(source.match(/"container", "stop"/g)).toHaveLength(1);
});
