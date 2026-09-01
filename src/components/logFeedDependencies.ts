"use client";

import { useLogTail } from "@/hooks/useLogTail";

export interface LogFeedDependencies {
  useLogTail: typeof useLogTail;
}

const productionDependencies: LogFeedDependencies = { useLogTail };
let testDependencies: Partial<LogFeedDependencies> | null = null;

export function logFeedDependencies(): LogFeedDependencies {
  return testDependencies === null
    ? productionDependencies
    : { ...productionDependencies, ...testDependencies };
}

/** Lifecycle-scoped test seam. Tests install it in setup and clear it in cleanup. */
export function setLogFeedDependenciesForTests(
  dependencies: Partial<LogFeedDependencies> | null,
): void {
  testDependencies = dependencies;
}
