"use client";

import {
  refreshRuntime,
  sendRuntimeMessage,
  useRuntimeReceiptsForArtifact,
} from "@/hooks/useRuntime";

import { useAgentCapabilities } from "./useAgentCapabilities";

export interface TmuxComposerRuntimeDependencies {
  refreshRuntime: typeof refreshRuntime;
  sendRuntimeMessage: typeof sendRuntimeMessage;
  useRuntimeReceiptsForArtifact: typeof useRuntimeReceiptsForArtifact;
  useAgentCapabilities: typeof useAgentCapabilities;
}

const productionDependencies: TmuxComposerRuntimeDependencies = {
  refreshRuntime,
  sendRuntimeMessage,
  useRuntimeReceiptsForArtifact,
  useAgentCapabilities,
};

let testDependencies: Partial<TmuxComposerRuntimeDependencies> | null = null;

export function tmuxComposerRuntimeDependencies(): TmuxComposerRuntimeDependencies {
  return testDependencies === null
    ? productionDependencies
    : { ...productionDependencies, ...testDependencies };
}

/** Lifecycle-scoped test seam. Tests install it in setup and clear it in cleanup. */
export function setTmuxComposerRuntimeDependenciesForTests(
  dependencies: Partial<TmuxComposerRuntimeDependencies> | null,
): void {
  testDependencies = dependencies;
}
