#!/usr/bin/env bun
/* #1248: verify the Viewer's build under the interpreter that will serve it.
 *
 * The Bun pin moved to 1.4.0 once already and was rolled back the same hour.
 * The build had said nothing about the move, because it cannot: `next build`
 * produces the same artifact under either interpreter. The compiled app-page
 * runtime then fails to load below 1.4.0, and a server that cannot load it
 * answers 500 on every route — which is what production got, from a green
 * build and a passing suite.
 *
 * This is the Viewer half of "verified under a runtime". Given a finished
 * build in the working directory it:
 *
 *   1. require()s every compiled Next server runtime and every bundle this
 *      repository builds into `.next/server`, each reported by name; and
 *   2. starts the served application the way `package.json` starts it, on an
 *      ephemeral loopback port, and requires `GET /` to answer 200.
 *
 * The interpreter under test is the one this script runs under, so it is
 * exercised by being used rather than named in a flag:
 *
 *   bun scripts/verify-viewer-runtime.ts        # this bun serves the build
 *
 * Nothing it touches is shared: the loads and the server both run against a
 * private HOME, config, state and temporary directory removed on exit, on a
 * port the kernel hands out. It never binds the stable port and never reads
 * the operator's state directory. `verify-runtime-host.ts` is the other half —
 * the process that owns the stable listener — and the two together are what a
 * Bun pin has to survive before it is proposed for promotion.
 *
 * Exit status is the verdict; the evidence is printed as JSON.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const USAGE = "usage: bun scripts/verify-viewer-runtime.ts [--load-modules]";

/** The module whose load failure answered 500 on every route (#1248). */
export const REQUIRED_SERVER_RUNTIME = "app-page.runtime.prod.js";
/** Where Next keeps the compiled server runtimes the served application loads. */
export const COMPILED_SERVER_DIR = path.join("node_modules", "next", "dist", "compiled", "next-server");
/** Where this repository's own server bundles land. */
export const BUILT_SERVER_DIR = path.join(".next", "server");
/** Loaded first, as the served application loads it. */
const NODE_ENVIRONMENT = path.join("node_modules", "next", "dist", "server", "node-environment.js");

/** How the module probe names its report inside the child's output. */
const MODULE_REPORT_PREFIX = "[viewer runtime] modules ";
/** A module that has not loaded within this is a failure, not a slow load. */
const MODULE_BUDGET_MS = 180_000;
/** The served application must answer within this of being started. */
const START_BUDGET_MS = 120_000;
const START_POLL_MS = 250;
/** Bounded tail of a child's own output, kept with a failure. */
const LOG_LINES = 40;

export interface ViewerModuleFailure {
  /** Repository-relative, because that is what a reader can go and open. */
  module: string;
  error: string;
}

export interface ViewerRuntimeEvidence {
  checkedAt: string;
  /** What was exercised, for the record: `bun 1.4.0`. */
  runtime: string;
  modules: { probed: number; loaded: number; failures: ViewerModuleFailure[] };
  served: { status: number; bytes: number; readyMs: number } | null;
  ok: boolean;
  detail?: string;
  log?: string[];
}

/**
 * Everything the served application loads out of a finished build, named
 * relative to `root`: the compiled Next server runtimes, and the bundles this
 * repository builds itself. Manifests are data those bundles read rather than
 * modules anyone requires, and the per-route chunks are reached through the
 * webpack runtime rather than by path, so neither is a load the server
 * performs and neither is here.
 */
export function servedRuntimeModules(root: string): string[] {
  const modules = [NODE_ENVIRONMENT];
  for (const directory of [COMPILED_SERVER_DIR, BUILT_SERVER_DIR]) {
    const absolute = path.join(root, directory);
    if (!fs.existsSync(absolute)) continue;
    const names = fs.readdirSync(absolute, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
      .map((entry) => entry.name)
      .sort();
    for (const name of names) {
      if (directory === COMPILED_SERVER_DIR && !name.endsWith(".runtime.prod.js")) continue;
      if (directory === BUILT_SERVER_DIR && name.endsWith("-manifest.js")) continue;
      modules.push(path.join(directory, name));
    }
  }
  return modules;
}

/**
 * What has to be in that list for a clean report to mean anything. A probe
 * that loads nothing also reports no failures, so an absent build — or a
 * rename that empties the glob — has to be a failure here rather than a pass
 * downstream.
 */
export function missingRequiredModules(modules: string[]): string[] {
  const missing: string[] = [];
  if (!modules.includes(path.join(COMPILED_SERVER_DIR, REQUIRED_SERVER_RUNTIME))) {
    missing.push(path.join(COMPILED_SERVER_DIR, REQUIRED_SERVER_RUNTIME));
  }
  if (!modules.some((module) => module.startsWith(BUILT_SERVER_DIR + path.sep))) {
    missing.push(path.join(BUILT_SERVER_DIR, "*.js"));
  }
  return missing;
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? "unknown error";
}

/** Load every module in `root`'s build, in this process, and report each one. */
export function loadServedRuntimeModules(root: string): ViewerModuleFailure[] {
  const require = createRequire(path.join(root, "package.json"));
  const failures: ViewerModuleFailure[] = [];
  for (const module of servedRuntimeModules(root)) {
    try {
      require(path.join(root, module));
    } catch (error) {
      failures.push({ module, error: firstLine(error) });
    }
  }
  return failures;
}

/** An unused loopback port, claimed and released so the server can bind it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") return reject(new Error("no ephemeral port was assigned"));
      probe.close(() => resolve(address.port));
    });
  });
}

/**
 * The environment both children get. Built rather than inherited, so neither
 * the loads nor the server can reach a live state directory, journal or socket
 * belonging to whoever started this. The image pins production, and what is
 * under test must see the same.
 */
function sandboxEnvironment(sandbox: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_RUNTIME_UI: "1",
    HOME: sandbox,
    XDG_CONFIG_HOME: path.join(sandbox, "config"),
    TMPDIR: path.join(sandbox, "tmp"),
    LLV_STATE_DIR: path.join(sandbox, "state"),
  };
}

function collector(child: ChildProcess, label: string): () => string[] {
  const lines: string[] = [];
  const collect = (chunk: unknown) => {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      lines.push(`${label}: ${line}`);
      if (lines.length > LOG_LINES) lines.shift();
    }
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.on("error", (error) => collect(`failed to start: ${error.message}`));
  return () => [...lines];
}

/**
 * Load the build's server modules in a child under this same interpreter.
 *
 * A child, and not this process, for two reasons the probe found the hard way:
 * a worker bundle keeps a handle open once loaded and never lets its process
 * exit, and a module loaded here would read the caller's own HOME rather than
 * the private one. A module that never returns is a failure at the budget.
 */
async function probeModules(root: string, sandbox: string): Promise<{ failures: ViewerModuleFailure[]; log: string[]; detail?: string }> {
  const child = spawn(process.execPath, [path.join(root, "scripts", "verify-viewer-runtime.ts"), "--load-modules"], {
    cwd: root,
    env: sandboxEnvironment(sandbox),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  const log = collector(child, "modules");
  let overran = false;
  const timer = setTimeout(() => { overran = true; child.kill("SIGKILL"); }, MODULE_BUDGET_MS);
  const code = await new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("exit", resolve);
  });
  clearTimeout(timer);
  const marker = output.lastIndexOf(MODULE_REPORT_PREFIX);
  if (marker < 0) {
    /* A module that never returns is a module that did not load, so the budget
       is a verdict rather than a retry. */
    const why = overran
      ? `the module probe did not finish within ${Math.round(MODULE_BUDGET_MS / 1_000)}s`
      : code === null
        ? "the module probe could not be started"
        : `the module probe exited ${code} without reporting`;
    return { failures: [], log: log(), detail: why };
  }
  const line = output.slice(marker + MODULE_REPORT_PREFIX.length).split("\n")[0] ?? "";
  return { failures: JSON.parse(line) as ViewerModuleFailure[], log: log() };
}

/**
 * Start the served application — the same command `package.json` starts it
 * with, under this interpreter — and ask it for the document once it answers.
 * Any status counts as "answered": what the status IS is the assertion, and
 * accepting one before reading is the mistake that let a 500 pass for a page.
 */
async function serveOnce(root: string, sandbox: string): Promise<{ status: number; bytes: number; readyMs: number; log: string[]; detail?: string }> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    ["--bun", "node_modules/.bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: root, env: { ...sandboxEnvironment(sandbox), PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const log = collector(child, "server");
  let exited = false;
  child.once("exit", () => { exited = true; });
  const started = Date.now();
  try {
    for (;;) {
      if (exited) return { status: 0, bytes: 0, readyMs: Date.now() - started, log: log(), detail: "the served application exited before it answered" };
      try {
        const probe = await fetch(origin, { redirect: "manual" });
        await probe.arrayBuffer();
        break;
      } catch {
        if (Date.now() - started >= START_BUDGET_MS) {
          return {
            status: 0,
            bytes: 0,
            readyMs: START_BUDGET_MS,
            log: log(),
            detail: `the served application did not answer within ${Math.round(START_BUDGET_MS / 1_000)}s of starting`,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
      }
    }
    const readyMs = Date.now() - started;
    try {
      const response = await fetch(origin, { headers: { accept: "text/html" } });
      const body = await response.text();
      return { status: response.status, bytes: body.length, readyMs, log: log() };
    } catch (error) {
      /* It answered the readiness probe and then did not answer this. Whatever
         it was, the document did not arrive, and the log says what the server
         made of it. */
      return { status: 0, bytes: 0, readyMs, log: log(), detail: `the served application dropped GET /: ${firstLine(error)}` };
    }
  } finally {
    child.kill("SIGTERM");
  }
}

export async function verifyViewerRuntime(root: string): Promise<ViewerRuntimeEvidence> {
  const checkedAt = new Date().toISOString();
  const runtime = `bun ${Bun.version}`;
  const modules = servedRuntimeModules(root);
  const missing = missingRequiredModules(modules);
  const verdict = (
    probed: number,
    failures: ViewerModuleFailure[],
    served: ViewerRuntimeEvidence["served"],
    failure: { detail: string; log: string[] } | null,
  ): ViewerRuntimeEvidence => ({
    checkedAt,
    runtime,
    modules: { probed, loaded: probed - failures.length, failures },
    served,
    ok: failure === null,
    ...(failure ? { detail: failure.detail } : {}),
    ...(failure && failure.log.length > 0 ? { log: failure.log } : {}),
  });

  if (missing.length > 0) {
    return verdict(0, [], null, { detail: `there is no build to load here: ${missing.join(", ")} is missing`, log: [] });
  }

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-viewer-runtime-"));
  fs.mkdirSync(path.join(sandbox, "tmp"), { recursive: true, mode: 0o700 });
  try {
    const loads = await probeModules(root, sandbox);
    if (loads.detail) return verdict(modules.length, loads.failures, null, { detail: loads.detail, log: loads.log });
    if (loads.failures.length > 0) {
      /* The names here and the errors in `failures`: one failing load explains
         the other four, and repeating the same sentence five times buries it. */
      const named = loads.failures.map((failure) => failure.module).join(", ");
      return verdict(modules.length, loads.failures, null, {
        detail: `${loads.failures.length} of ${modules.length} server modules did not load under ${runtime}`
          + ` (${named}): ${loads.failures[0].error}`,
        log: [],
      });
    }

    const served = await serveOnce(root, sandbox);
    const evidence = { status: served.status, bytes: served.bytes, readyMs: served.readyMs };
    if (served.detail) return verdict(modules.length, [], evidence, { detail: served.detail, log: served.log });
    if (served.status !== 200) {
      return verdict(modules.length, [], evidence, {
        detail: `the served application answered GET / with ${served.status} under ${runtime}`,
        log: served.log,
      });
    }
    if (served.bytes === 0) {
      /* A 200 carrying nothing is a served document in the same sense an error
         page is one: the status was the only thing that arrived. */
      return verdict(modules.length, [], evidence, {
        detail: `the served application answered GET / with 200 and an empty document under ${runtime}`,
        log: served.log,
      });
    }
    return verdict(modules.length, [], evidence, null);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  if (argv.includes("--load-modules")) {
    console.log(MODULE_REPORT_PREFIX + JSON.stringify(loadServedRuntimeModules(process.cwd())));
    /* A loaded worker bundle holds a handle open, and this process has said
       everything it has to say. */
    process.exit(0);
  }

  const report = await verifyViewerRuntime(process.cwd());
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    console.error(`viewer verification failed under ${report.runtime}: ${report.detail ?? "no detail"}`);
    process.exit(1);
  }
  console.error(
    `viewer verified under ${report.runtime}:`
    + ` ${report.modules.loaded}/${report.modules.probed} server modules loaded`
    + ` and GET / answered ${report.served?.status} in ${report.served?.bytes} bytes`
    + ` ${Math.round((report.served?.readyMs ?? 0) / 1_000)}s after start`,
  );
  process.exit(0);
}
