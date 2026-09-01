#!/usr/bin/env bun-container

import path from "node:path";

import {
  probeRuntimeHostSuccessor,
  runtimeHostGenerationFromEnvironment,
} from "../src/runtime-host/runtimeHostStartup";

function runtimeHostSocket(environment: NodeJS.ProcessEnv): string {
  const configured = environment.LLV_RUNTIME_HOST_SOCKET?.trim();
  if (configured) return configured;
  const config = environment.XDG_CONFIG_HOME
    || path.join(environment.HOME || "/home/user", ".config");
  return path.join(config, "agent-log-viewer", "state", "runtime-host.sock");
}

export async function checkRuntimeHost(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const generation = runtimeHostGenerationFromEnvironment(environment);
  await probeRuntimeHostSuccessor(runtimeHostSocket(environment), generation, { timeoutMs: 3_000 });
}

if (import.meta.main) {
  try {
    await checkRuntimeHost();
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "runtime-host health probe failed");
    process.exit(1);
  }
}
