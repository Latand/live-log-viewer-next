import { describe, expect, it } from "bun:test";

import { normalizeResumePanesFile } from "@/lib/resumePanesFile";

describe("normalizeResumePanesFile", () => {
  it("reads the current {serverPid, panes} shape", () => {
    const file = normalizeResumePanesFile({
      serverPid: 4242,
      panes: { "/t/a.jsonl": { paneId: "%1", windowName: "claude-resume" } },
    });
    expect(file.serverPid).toBe(4242);
    expect(file.panes["/t/a.jsonl"]).toEqual({ paneId: "%1", windowName: "claude-resume" });
  });

  it("treats a legacy bare record map as belonging to no known server", () => {
    // The pre-upgrade file was a plain Record<path, record> with no server pid;
    // a null pid forces the first lookup to rebuild instead of trusting ids
    // written under a now-dead server.
    const file = normalizeResumePanesFile({
      "/t/a.jsonl": { paneId: "%1", windowName: "claude-resume" },
    });
    expect(file.serverPid).toBeNull();
    expect(file.panes["/t/a.jsonl"]).toEqual({ paneId: "%1", windowName: "claude-resume" });
  });

  it("drops a non-integer server pid to null", () => {
    const file = normalizeResumePanesFile({ serverPid: "1969479", panes: {} });
    expect(file.serverPid).toBeNull();
  });

  it("tolerates garbage without throwing", () => {
    expect(normalizeResumePanesFile(null)).toEqual({ serverPid: null, panes: {} });
    expect(normalizeResumePanesFile(42)).toEqual({ serverPid: null, panes: {} });
    expect(normalizeResumePanesFile({ panes: "nope" })).toEqual({ serverPid: null, panes: {} });
  });
});
