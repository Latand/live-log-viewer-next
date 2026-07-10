import { describe, expect, test } from "bun:test";

import {
  cdCommandForCwd,
  classifyTmuxAttachSnapshot,
  createTmuxEndpointDescriptor,
  resolveTmuxAttach,
  tmuxAttachCommands,
  tmuxEndpoint,
} from "@/lib/tmux";

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
