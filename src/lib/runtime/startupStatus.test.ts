import { expect, test } from "bun:test";

test("separate bundle module instances share structured startup status", async () => {
  const moduleCopy = (name: string) => `./startupStatus?${name}`;
  const instrumentationCopy = await import(moduleCopy("instrumentation-copy"));
  const routeCopy = await import(moduleCopy("route-copy"));
  try {
    instrumentationCopy.markStructuredHostStartupFailed();
    expect(routeCopy.didStructuredHostStartupFail()).toBe(true);
    routeCopy.markStructuredHostStartupReady();
    expect(instrumentationCopy.didStructuredHostStartupFail()).toBe(false);
  } finally {
    instrumentationCopy.markStructuredHostStartupReady();
  }
});

test("issue 367: the structured startup axis never reports ready before adoption succeeds", async () => {
  const { markStructuredHostStartupFailed, markStructuredHostStartupReady, structuredStartupAxis } = await import(`./startupStatus?${"axis-copy"}`);
  const store = process as typeof process & { __llvStructuredHostStartupFailed?: boolean };
  const previous = store.__llvStructuredHostStartupFailed;
  try {
    delete store.__llvStructuredHostStartupFailed;
    expect(structuredStartupAxis({ LLV_STRUCTURED_HOSTS: "1" })).toBe("pending");
    markStructuredHostStartupFailed();
    expect(structuredStartupAxis({ LLV_STRUCTURED_HOSTS: "1" })).toBe("failed");
    markStructuredHostStartupReady();
    expect(structuredStartupAxis({ LLV_STRUCTURED_HOSTS: "1" })).toBe("ready");
    // Structured hosting is the default, so a bare environment still reports a
    // real axis; only the explicit rollback drops the axis to null.
    expect(structuredStartupAxis({})).toBe("ready");
    expect(structuredStartupAxis({ LLV_STRUCTURED_HOSTS: "0" })).toBeNull();
  } finally {
    if (previous === undefined) delete store.__llvStructuredHostStartupFailed;
    else store.__llvStructuredHostStartupFailed = previous;
  }
});

test("structured startup status retains host adoption progress through failure and recovery", async () => {
  const status = await import(`./startupStatus?${"progress-copy"}`);
  const store = process as typeof process & {
    __llvStructuredHostStartupFailed?: boolean;
    __llvStructuredHostStartupProgress?: unknown;
  };
  const previousFailed = store.__llvStructuredHostStartupFailed;
  const previousProgress = store.__llvStructuredHostStartupProgress;
  try {
    delete store.__llvStructuredHostStartupFailed;
    delete store.__llvStructuredHostStartupProgress;
    status.markStructuredHostStartupProgress({
      phase: "adopting Claude hosts",
      completedHosts: 7,
      totalHosts: 19,
    });
    expect(status.structuredStartupStatus({ LLV_STRUCTURED_HOSTS: "1" })).toMatchObject({
      state: "pending",
      phase: "adopting Claude hosts",
      completedHosts: 7,
      totalHosts: 19,
      updatedAt: expect.any(String),
    });

    status.markStructuredHostStartupFailed();
    expect(status.structuredStartupStatus({ LLV_STRUCTURED_HOSTS: "1" })).toMatchObject({
      state: "failed",
      phase: "adopting Claude hosts",
      completedHosts: 7,
      totalHosts: 19,
    });

    status.markStructuredHostStartupProgress({
      phase: "finalizing structured delivery",
      completedHosts: 19,
      totalHosts: 19,
    });
    expect(status.structuredStartupStatus({ LLV_STRUCTURED_HOSTS: "1" })).toMatchObject({
      state: "failed",
      phase: "finalizing structured delivery",
      completedHosts: 19,
      totalHosts: 19,
    });
    status.markStructuredHostStartupReady();
    expect(status.structuredStartupStatus({ LLV_STRUCTURED_HOSTS: "1" })).toMatchObject({
      state: "ready",
      phase: "ready",
      completedHosts: 19,
      totalHosts: 19,
    });
  } finally {
    if (previousFailed === undefined) delete store.__llvStructuredHostStartupFailed;
    else store.__llvStructuredHostStartupFailed = previousFailed;
    if (previousProgress === undefined) delete store.__llvStructuredHostStartupProgress;
    else store.__llvStructuredHostStartupProgress = previousProgress;
  }
});
