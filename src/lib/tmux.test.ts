import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  cdCommandForCwd,
  classifyTmuxAttachSnapshot,
  cleanupTmuxHostIfMatches,
  createSpawnWindow,
  createTmuxEndpointDescriptor,
  renameTmuxWindowForPid,
  resolveTmuxAttach,
  resolveTmuxEndpointContract,
  selectSpawnedAgentProcess,
  tmuxAttachCommands,
  tmuxEndpoint,
  verifyTmuxSpawnBinding,
} from "@/lib/tmux";

describe("renameTmuxWindowForPid guards", () => {
  test("a non-positive pid never touches tmux", async () => {
    expect(await renameTmuxWindowForPid(0, "Name")).toBeNull();
    expect(await renameTmuxWindowForPid(-1, "Name")).toBeNull();
  });

  test("a title that collapses to blank never touches tmux", async () => {
    expect(await renameTmuxWindowForPid(1234, "   ")).toBeNull();
  });
});

describe("cdCommandForCwd", () => {
  test("quotes paths with spaces for a shell cd command", () => {
    expect(cdCommandForCwd("/home/user/project with spaces")).toBe("cd -- '/home/user/project with spaces'");
  });

  test("escapes single quotes in cwd paths", () => {
    expect(cdCommandForCwd("/home/user/it's here")).toBe("cd -- '/home/user/it'\\''s here'");
  });
});

test("reports the configured tmux endpoint", () => {
  expect(tmuxEndpoint()).toBe(process.env.TMUX_TMPDIR || "/tmp");
});

describe("tmux endpoint ownership", () => {
  test("keeps legacy delivery available and reports a stale migration marker", () => {
    expect(resolveTmuxEndpointContract({
      configuredTmpdir: "/tmp",
      externalFlag: "0",
      migrationComplete: true,
      uid: 1000,
    })).toEqual({
      external: false,
      tmuxTmpdir: "/tmp",
      health: {
        status: "degraded",
        code: "migration-marker-endpoint-mismatch",
        configuredTmpdir: "/tmp",
        expectedTmpdir: "/run/user/1000/agent-log-viewer",
        message: "A migration completion marker exists while the Viewer is using /tmp. Legacy tmux delivery remains active; remove the stale marker or complete the supervisor migration.",
      },
    });

    expect(resolveTmuxEndpointContract({
      configuredTmpdir: "/run/user/1000/agent-log-viewer",
      externalFlag: "1",
      migrationComplete: true,
      uid: 1000,
    })).toEqual({
      external: true,
      tmuxTmpdir: "/run/user/1000/agent-log-viewer",
      health: { status: "healthy" },
    });
  });
});

describe("spawn pane fencing", () => {
  const endpoint = createTmuxEndpointDescriptor("/run/user/1000/agent-log-viewer", 1000);
  const server = { pid: 900, startIdentity: "900:start" };

  test("uses the pane id created by new-window while foreign idle panes exist and coordinates renumber", async () => {
    let display = "agents:3.0";
    const calls: string[][] = [];
    const deps = {
      runTmux: async (args: string[]) => {
        calls.push(args);
        if (args[0] === "list-panes") return { code: 0, stdout: "%1\n%2\n", stderr: "" };
        if (args[0] === "new-window") return { code: 0, stdout: "%9\n", stderr: "" };
        return { code: 0, stdout: `900\t%9\t109\t${display}\tcodex-new\tzsh\n`, stderr: "" };
      },
      processIdentity: (pid: number) => `${pid}:start`,
    };

    const binding = await createSpawnWindow({
      session: "agents",
      cwd: "/repo",
      windowName: "codex-new",
      endpoint,
      server,
    }, deps);
    expect(binding).toMatchObject({ paneId: "%9", panePid: { pid: 109 }, target: "%9", display: "agents:3.0" });
    expect(calls[0]).toContain("#{pane_id}");
    expect(calls.flat()).not.toContain("agents:1.0");
    expect(calls.flat()).not.toContain("agents:2.0");

    display = "agents:1.0";
    const current = await verifyTmuxSpawnBinding(binding, endpoint, deps);
    expect(current).toMatchObject({ paneId: "%9", panePid: 109, display: "agents:1.0" });
  });

  test("rejects the shim's legacy underscore-normalized output", async () => {
    const deps = {
      runTmux: async (args: string[]) => args[0] === "list-panes"
        ? { code: 0, stdout: "%1\n%2\n", stderr: "" }
        : { code: 0, stdout: "%9_agents:3.0_109_extra\n", stderr: "" },
      processIdentity: (pid: number) => `${pid}:start`,
    };
    await expect(createSpawnWindow({
      session: "agents",
      cwd: "/repo",
      windowName: "codex-new",
      endpoint,
      server,
    }, deps)).rejects.toThrow("invalid pane id");

    const dockerfile = fs.readFileSync(path.join(process.cwd(), "Dockerfile"), "utf8");
    expect(dockerfile).not.toContain("normalized=$(sed -E");
  });

  test("rejects a pane id that existed before new-window", async () => {
    const deps = {
      runTmux: async (args: string[]) => args[0] === "list-panes"
        ? { code: 0, stdout: "%1\n%2\n", stderr: "" }
        : { code: 0, stdout: "%2\n", stderr: "" },
      processIdentity: (pid: number) => `${pid}:start`,
    };
    await expect(createSpawnWindow({
      session: "agents",
      cwd: "/repo",
      windowName: "codex-new",
      endpoint,
      server,
    }, deps)).rejects.toThrow("pre-existing pane id");
  });

  test("rejects a server flip between new-window and pane verification", async () => {
    const deps = {
      runTmux: async (args: string[]) => {
        if (args[0] === "list-panes") return { code: 0, stdout: "%1\n%2\n", stderr: "" };
        if (args[0] === "new-window") return { code: 0, stdout: "%9\n", stderr: "" };
        return { code: 0, stdout: "901\t%9\t109\tagents:3.0\tcodex-new\tzsh\n", stderr: "" };
      },
      processIdentity: (pid: number) => `${pid}:start`,
    };
    await expect(createSpawnWindow({
      session: "agents",
      cwd: "/repo",
      windowName: "codex-new",
      endpoint,
      server,
    }, deps)).rejects.toThrow("server changed");
  });

  test("selects only the booted agent beneath the created pane", () => {
    const processes = [
      { pid: 201, engine: "codex" as const, argv: ["codex"], cwd: "/repo", tty: 1 },
      { pid: 202, engine: "codex" as const, argv: ["codex"], cwd: "/repo", tty: 1 },
      { pid: 209, engine: "codex" as const, argv: ["codex"], cwd: "/repo", tty: 1 },
    ];
    const parents = new Map([[201, 101], [202, 102], [209, 109], [101, 900], [102, 900], [109, 900]]);
    expect(selectSpawnedAgentProcess(109, "codex", "/repo", processes, (pid) => parents.get(pid) ?? null)?.pid).toBe(209);
    expect(selectSpawnedAgentProcess(110, "codex", "/repo", processes, (pid) => parents.get(pid) ?? null)).toBeNull();
  });
});

describe("endpoint-aware attach commands", () => {
  test("describes default and external supervisor sockets deterministically", () => {
    expect(createTmuxEndpointDescriptor("/tmp", 1000)).toEqual({
      kind: "tmux-tmpdir",
      tmuxTmpdir: "/tmp",
      socketName: "default",
      socketPath: "/tmp/tmux-1000/default",
    });
    expect(createTmuxEndpointDescriptor("/run/user/1000/agent-log-viewer", 1000).socketPath).toBe(
      "/run/user/1000/agent-log-viewer/tmux-1000/default",
    );
  });

  test("builds exact interactive and read-only commands", () => {
    const endpoint = createTmuxEndpointDescriptor("/run/user/1000/agent-log-viewer", 1000);
    expect(tmuxAttachCommands(endpoint, "agents:2.0")).toEqual({
      command: "TMUX_TMPDIR='/run/user/1000/agent-log-viewer' tmux attach-session -t 'agents:2.0'",
      readOnlyCommand: "TMUX_TMPDIR='/run/user/1000/agent-log-viewer' tmux attach-session -r -t 'agents:2.0'",
    });
  });

  test("quotes punctuation and shell-injection-shaped values", () => {
    const endpoint = createTmuxEndpointDescriptor("/run/user/1000/agent log's", 1000);
    const target = "agents:2.0;$(touch pwned) `echo nope` ü space's";
    const commands = tmuxAttachCommands(endpoint, target);
    expect(commands.command).toBe(
      "TMUX_TMPDIR='/run/user/1000/agent log'\\''s' tmux attach-session -t 'agents:2.0;$(touch pwned) `echo nope` ü space'\\''s'",
    );
    expect(() => tmuxAttachCommands(endpoint, "agents:2.0\nnext")).toThrow("unsafe control character");
    expect(() => tmuxAttachCommands(createTmuxEndpointDescriptor("/tmp\0bad", 1000), "agents:2.0")).toThrow("unsafe control character");
  });
});

describe("attach identity classification", () => {
  const expected = {
    tmuxServerPid: 900,
    tmuxServerStartIdentity: "900:one",
    paneId: "%11",
    panePid: 100,
    paneStartIdentity: "100:one",
  };

  test("accepts a renumbered display coordinate with stable identities", () => {
    expect(classifyTmuxAttachSnapshot(expected, {
      tmuxServerPid: 900,
      tmuxServerStartIdentity: "900:one",
      paneId: "%11",
      panePid: 100,
      paneStartIdentity: "100:one",
      target: "agents:8.0",
    })).toBe("ok");
  });

  test("rejects a vanished or replaced pane and PID reuse", () => {
    expect(classifyTmuxAttachSnapshot(expected, {
      tmuxServerPid: 900,
      tmuxServerStartIdentity: "900:one",
      paneId: "%12",
      panePid: 101,
      paneStartIdentity: "101:one",
      target: "agents:2.0",
    })).toBe("stale-pane");
    expect(classifyTmuxAttachSnapshot(expected, {
      tmuxServerPid: 900,
      tmuxServerStartIdentity: "900:one",
      paneId: "%11",
      panePid: 100,
      paneStartIdentity: "100:two",
      target: "agents:2.0",
    })).toBe("stale-pane");
  });

  test("rejects a restarted server even when tmux reuses a pane id", () => {
    expect(classifyTmuxAttachSnapshot(expected, {
      tmuxServerPid: 901,
      tmuxServerStartIdentity: "901:one",
      paneId: "%11",
      panePid: 100,
      paneStartIdentity: "100:one",
      target: "agents:2.0",
    })).toBe("server-restarted");
  });
});

describe("resolveTmuxAttach", () => {
  const expected = {
    tmuxServerPid: 900,
    tmuxServerStartIdentity: "900:one",
    paneId: "%11",
    panePid: 100,
    paneStartIdentity: "100:one",
  };
  const endpoint = createTmuxEndpointDescriptor("/run/user/1000/agent-log-viewer", 1000);

  test("reports stale-pane when a healthy server no longer has the pane", async () => {
    const calls: Array<{ args: string[]; endpointPath: string }> = [];
    const result = await resolveTmuxAttach(expected, endpoint, {
      runTmux: async (args, _input, seenEndpoint) => {
        calls.push({ args, endpointPath: seenEndpoint?.socketPath ?? "" });
        if (calls.length === 1) return { code: 0, stdout: "900\n", stderr: "" };
        return { code: 1, stdout: "", stderr: "can't find pane: %11\n" };
      },
      processIdentity: (pid) => (pid === 900 ? "900:one" : pid === 100 ? "100:one" : null),
    });

    expect(result).toEqual({ ok: false, reason: "stale-pane" });
    expect(calls).toEqual([
      { args: ["display-message", "-p", "#{pid}"], endpointPath: endpoint.socketPath },
      {
        args: [
          "display-message",
          "-p",
          "-t",
          "%11",
          "#{pid}\t#{pane_id}\t#{pane_pid}\t#{session_name}:#{window_index}.#{pane_index}",
        ],
        endpointPath: endpoint.socketPath,
      },
    ]);
  });

  test("keeps pane probe transport and generic command failures unverifiable", async () => {
    for (const paneProbe of [
      async () => { throw new Error("socket read failed"); },
      async () => ({ code: 1, stdout: "", stderr: "lost server\n" }),
    ]) {
      let calls = 0;
      const result = await resolveTmuxAttach(expected, endpoint, {
        runTmux: async () => {
          calls += 1;
          if (calls === 1) return { code: 0, stdout: "900\n", stderr: "" };
          return paneProbe();
        },
        processIdentity: (pid) => (pid === 900 ? "900:one" : null),
      });
      expect(result).toEqual({ ok: false, reason: "tmux-unavailable" });
    }
  });

  test("reports server-restarted before resolving a pane missing from the new server", async () => {
    const calls: Array<{ args: string[]; endpointPath: string }> = [];
    const result = await resolveTmuxAttach(expected, endpoint, {
      runTmux: async (args, _input, seenEndpoint) => {
        calls.push({ args, endpointPath: seenEndpoint?.socketPath ?? "" });
        return { code: 0, stdout: "901\n", stderr: "" };
      },
      processIdentity: (pid) => (pid === 901 ? "901:one" : null),
    });

    expect(result).toEqual({ ok: false, reason: "server-restarted" });
    expect(calls).toEqual([
      { args: ["display-message", "-p", "#{pid}"], endpointPath: endpoint.socketPath },
    ]);
  });
});

describe("cleanupTmuxHostIfMatches", () => {
  const host = {
    kind: "tmux" as const,
    endpoint: "/run/user/1000/agent-log-viewer",
    server: { pid: 900, startIdentity: "900:one" },
    paneId: "%11",
    panePid: { pid: 100, startIdentity: "100:one" },
    windowName: "migration",
    agent: { pid: 101, startIdentity: "101:one" },
    argv: ["claude"],
  };

  test("confirms explicit pane absence and retries unverifiable pane probes", async () => {
    for (const [paneProbe, expected] of [
      [async () => ({ code: 1, stdout: "", stderr: "can't find pane: %11\n" }), "absent"],
      [async () => { throw new Error("socket read failed"); }, "unverifiable"],
      [async () => ({ code: 1, stdout: "", stderr: "lost server\n" }), "unverifiable"],
    ] as const) {
      let calls = 0;
      const result = await cleanupTmuxHostIfMatches(host, {
        runTmux: async () => {
          calls += 1;
          if (calls === 1) return { code: 0, stdout: "900\n", stderr: "" };
          return paneProbe();
        },
        processIdentity: (pid) => (pid === 900 ? "900:one" : null),
      });
      expect(result).toBe(expected);
    }
  });

  test("retries when required server or pane process identity is unavailable", async () => {
    for (const missingIdentityPid of [900, 100]) {
      let calls = 0;
      const result = await cleanupTmuxHostIfMatches(host, {
        runTmux: async () => {
          calls += 1;
          if (calls === 1) return { code: 0, stdout: "900\n", stderr: "" };
          return { code: 0, stdout: "900\t%11\t100\tagents:2.0\n", stderr: "" };
        },
        processIdentity: (pid) => {
          if (pid === missingIdentityPid) return null;
          if (pid === 900) return "900:one";
          if (pid === 100) return "100:one";
          return null;
        },
      });
      expect(result).toBe("unverifiable");
      expect(calls).toBe(missingIdentityPid === 900 ? 1 : 2);
    }
  });
});
