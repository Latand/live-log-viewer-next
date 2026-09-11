"use client";

import {
  refreshRuntime,
  sendRuntimeMessage,
  useRuntimeReceiptsForArtifact,
} from "@/hooks/useRuntime";

import { productionNativeQueueDependencies, type NativeQueueDependencies } from "@/hooks/useNativeQueue";

import { useAgentCapabilities } from "./useAgentCapabilities";

export interface TmuxComposerRuntimeDependencies {
  refreshRuntime: typeof refreshRuntime;
  sendRuntimeMessage: typeof sendRuntimeMessage;
  useRuntimeReceiptsForArtifact: typeof useRuntimeReceiptsForArtifact;
  useAgentCapabilities: typeof useAgentCapabilities;
  /** #1629: the native queue transport, so a test can drive the whole control
      loop without a socket. */
  nativeQueue: NativeQueueDependencies;
}

const productionDependencies: TmuxComposerRuntimeDependencies = {
  refreshRuntime,
  sendRuntimeMessage,
  useRuntimeReceiptsForArtifact,
  useAgentCapabilities,
  nativeQueue: productionNativeQueueDependencies,
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
