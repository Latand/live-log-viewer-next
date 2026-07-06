import { describe, expect, test } from "bun:test";

import { allowedKillTarget, consumeKillTarget, noteSessionTargets } from "./resources";

describe("kill-target allowlist", () => {
  test("nothing is killable before a snapshot exists", () => {
    noteSessionTargets([]);
    expect(allowedKillTarget("agents:1.0")).toBeNull();
    expect(allowedKillTarget("")).toBeNull();
  });

  test("only targets from the last snapshot pass, each with its pane id and pid", () => {
    noteSessionTargets([
      { target: "agents:1.0", ref: { panePid: 111, paneId: "%11" } },
      { target: "agents:2.0", ref: { panePid: 222, paneId: "%22" } },
    ]);
    expect(allowedKillTarget("agents:1.0")).toEqual({ panePid: 111, paneId: "%11" });
    expect(allowedKillTarget("agents:2.0")).toEqual({ panePid: 222, paneId: "%22" });
    expect(allowedKillTarget("agents:3.0")).toBeNull();
    expect(allowedKillTarget("main:0.0")).toBeNull();
  });

  test("a new snapshot replaces the allowlist, never accumulates", () => {
    noteSessionTargets([{ target: "agents:1.0", ref: { panePid: 111, paneId: "%11" } }]);
    noteSessionTargets([{ target: "agents:2.0", ref: { panePid: 222, paneId: "%22" } }]);
    expect(allowedKillTarget("agents:1.0")).toBeNull();
    expect(allowedKillTarget("agents:2.0")).toEqual({ panePid: 222, paneId: "%22" });
  });

  test("a consumed target no longer passes — tmux may reuse its coordinates", () => {
    noteSessionTargets([
      { target: "agents:1.0", ref: { panePid: 111, paneId: "%11" } },
      { target: "agents:2.0", ref: { panePid: 222, paneId: "%22" } },
    ]);
    consumeKillTarget("agents:1.0");
    expect(allowedKillTarget("agents:1.0")).toBeNull();
    expect(allowedKillTarget("agents:2.0")).toEqual({ panePid: 222, paneId: "%22" });
  });
});
