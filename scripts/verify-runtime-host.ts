#!/usr/bin/env bun
/* #1254: verify the runtime host under a runtime, before that runtime ships.
 *
 * The Bun pin moved and only the Viewer was exercised. The runtime host runs
 * under the same Bun, owns the stable listener, and performs the release
 * succession; nobody started it under the new runtime until production did.
 *
 *   bun scripts/verify-runtime-host.ts                    # this checkout's bun
 *   bun scripts/verify-runtime-host.ts --runtime /path/to/bun
 *
 * It starts two runtime-host generations under that interpreter, drives one
 * singleton-fence succession, and holds both endpoints the succession handed
 * over. Nothing it touches is shared: a private state directory removed on
 * exit, a private socket, an ephemeral loopback port. It never binds the
 * stable port and never reads the operator's state directory. The deployment
 * gate runs the same rehearsal inside the candidate image.
 *
 * Exit status is the verdict; the evidence is printed as JSON.
 */

import { runRuntimeHostRehearsal } from "../src/runtime-host/hostRehearsalRun";

const USAGE = "usage: bun scripts/verify-runtime-host.ts [--runtime <bun binary>] [--hold-ms <milliseconds>]";

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value\n${USAGE}`);
  return value;
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

const runtimeBin = option(argv, "--runtime");
const holdMs = option(argv, "--hold-ms");
const report = await runRuntimeHostRehearsal({
  ...(runtimeBin ? { runtimeBin } : {}),
  ...(holdMs ? { holdWindowMs: Number(holdMs) } : {}),
});

console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  console.error(`runtime-host verification failed under ${report.runtime}: ${report.detail ?? "no detail"}`);
  process.exit(1);
}
console.error(
  `runtime-host verified under ${report.runtime}:`
  + ` succession completed in ${report.succession.successorTookOverMs}ms,`
  + ` stable listener answered ${report.listener.answered}/${report.listener.polls}`
  + ` and the runtime socket ${report.socket.answered}/${report.socket.polls}`
  + ` over ${Math.round(report.listener.windowMs / 1_000)}s`,
);
