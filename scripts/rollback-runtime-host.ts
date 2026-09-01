#!/usr/bin/env bun

import {
  readRuntimeHostHandoffIntent,
  readRuntimeHostRollbackTarget,
  runtimeHostHandoffIntentFile,
  runtimeHostReleaseFile,
  runtimeHostRollbackIntentFile,
  runtimeHostRollbackTargetFile,
  writeRuntimeHostRelease,
  writeRuntimeHostRollbackIntent,
  type RuntimeHostRollbackTarget,
} from "../src/runtime-host/hostRelease";
import {
  requestRuntimeHostRollback,
  runtimeHostRollbackTargetFromHandoff,
} from "../src/runtime-host/hostRollback";
import { withoutWakatimeCredential } from "../src/lib/wakatime/credential";

const USAGE = "usage: bun scripts/rollback-runtime-host.ts [--execute]";

export function parseRollbackArguments(argv: string[]): { execute: boolean } {
  let execute = false;
  for (const argument of argv) {
    if (argument === "--execute") {
      if (execute) throw new Error(`--execute was given twice\n${USAGE}`);
      execute = true;
      continue;
    }
    throw new Error(`unsupported option ${argument}\n${USAGE}`);
  }
  return { execute };
}

async function docker(argv: string[]): Promise<string> {
  const child = Bun.spawn(["docker", ...argv], {
    stdout: "pipe",
    stderr: "pipe",
    env: withoutWakatimeCredential(process.env),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error((stderr.trim() || "docker command failed").slice(0, 1_000));
  return stdout.trim();
}

export function renderRuntimeHostRollbackPlan(target: RuntimeHostRollbackTarget): string {
  return [
    "runtime-host rollback plan",
    `  failed generation    ${target.active.revision} (${target.active.container})`,
    `  retained generation  ${target.previous.revision} (${target.previous.container})`,
    "",
    "ordered recovery:",
    "  - write the rollback intent and repoint the durable release record",
    "  - enable and start the retained generation under dockerd",
    "  - the retained generation disables and stops the failed generation before taking the singleton fence",
    "  - after acquiring the fence, the retained generation removes the failed container and clears the intent",
    "",
    "Viewer release containers and their agent processes are untouched.",
  ].join("\n");
}

async function main(): Promise<number> {
  const { execute } = parseRollbackArguments(process.argv.slice(2));
  const handoff = readRuntimeHostHandoffIntent(runtimeHostHandoffIntentFile());
  const retained = readRuntimeHostRollbackTarget(runtimeHostRollbackTargetFile());
  const target = handoff ? runtimeHostRollbackTargetFromHandoff(handoff) : retained;
  if (!target) throw new Error("no retained runtime-host rollback target is available");
  console.log(renderRuntimeHostRollbackPlan(target));
  if (!execute) {
    console.error("[runtime-host rollback] plan only; re-run with --execute to start the retained generation");
    return 0;
  }
  await requestRuntimeHostRollback(target, {
    writeIntent: (intent) => writeRuntimeHostRollbackIntent(intent, runtimeHostRollbackIntentFile()),
    writeRelease: (release) => writeRuntimeHostRelease(release, runtimeHostReleaseFile()),
    enablePreviousRestart: async (container) => {
      await docker(["container", "update", "--restart", "unless-stopped", container]);
    },
    startPrevious: async (container) => {
      await docker(["container", "start", container]);
    },
  });
  console.error(`[runtime-host rollback] retained generation ${target.previous.container} is taking recovery authority`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(`[runtime-host rollback] ${error instanceof Error ? error.message : "rollback failed"}`);
    process.exit(1);
  }
}
