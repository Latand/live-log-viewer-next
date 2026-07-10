import { describe, expect, test } from "bun:test";

import {
  type AttachApiBody,
  attachUrl,
  copiedKey,
  isRecoverable,
  performAttachCopy,
  pickCommand,
  reasonKey,
  resolveAttach,
} from "./attach";

const ATTACH = "TMUX_TMPDIR='/run/user/1000/agent-log-viewer' tmux attach-session -t 'agents:2.0'";
const READONLY = "TMUX_TMPDIR='/run/user/1000/agent-log-viewer' tmux attach-session -r -t 'agents:2.0'";
const okBody: AttachApiBody = { attach: { target: "agents:2.0", command: ATTACH, readOnlyCommand: READONLY } };

/** A minimal fetch double: resolves to a Response-like object with the given
    status and JSON body, or rejects when `throws` is set (network failure). */
function fakeFetch(status: number, body: unknown, opts: { throws?: boolean; unparseable?: boolean } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (opts.throws) throw new Error("offline");
    return {
      status,
      json: async () => {
        if (opts.unparseable) throw new Error("bad json");
        return body;
      },
    } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("attachUrl", () => {
  test("keys the resolve by target and percent-encodes punctuation", () => {
    expect(attachUrl("agents:2.0")).toBe("/api/tmux?attach=1&target=agents%3A2.0");
    expect(attachUrl("weird name/1.0")).toBe("/api/tmux?attach=1&target=weird%20name%2F1.0");
  });
});

describe("pickCommand", () => {
  test("selects the command for each kind", () => {
    expect(pickCommand("attach", okBody)).toBe(ATTACH);
    expect(pickCommand("readonly", okBody)).toBe(READONLY);
  });

  test("returns null when the requested field is missing or empty", () => {
    expect(pickCommand("attach", { attach: { command: "" } })).toBeNull();
    expect(pickCommand("readonly", { attach: { command: ATTACH } })).toBeNull();
    expect(pickCommand("attach", {})).toBeNull();
  });
});

describe("resolveAttach", () => {
  test("200 returns the picked command per kind", () => {
    expect(resolveAttach("attach", 200, okBody)).toEqual({ ok: true, command: ATTACH });
    expect(resolveAttach("readonly", 200, okBody)).toEqual({ ok: true, command: READONLY });
  });

  test("200 with a malformed body degrades to tmux-unavailable", () => {
    expect(resolveAttach("attach", 200, {})).toEqual({ ok: false, reason: "tmux-unavailable" });
  });

  test("409 surfaces the machine-readable stale reasons verbatim", () => {
    expect(resolveAttach("attach", 409, { reason: "stale-pane" })).toEqual({ ok: false, reason: "stale-pane" });
    expect(resolveAttach("attach", 409, { reason: "server-restarted" })).toEqual({ ok: false, reason: "server-restarted" });
  });

  test("503 and 400 map to endpoint-unavailable and bad-request", () => {
    expect(resolveAttach("attach", 503, { reason: "tmux-unavailable" })).toEqual({ ok: false, reason: "tmux-unavailable" });
    expect(resolveAttach("attach", 400, { reason: "tmux-unavailable" })).toEqual({ ok: false, reason: "tmux-unavailable" });
    expect(resolveAttach("attach", 400, {})).toEqual({ ok: false, reason: "bad-request" });
  });
});

describe("failure classification", () => {
  test("only endpoint-side failures are refresh-recoverable", () => {
    expect(isRecoverable("stale-pane")).toBe(true);
    expect(isRecoverable("server-restarted")).toBe(true);
    expect(isRecoverable("tmux-unavailable")).toBe(true);
    expect(isRecoverable("bad-request")).toBe(false);
    expect(isRecoverable("network")).toBe(false);
    expect(isRecoverable("clipboard")).toBe(false);
  });

  test("every reason and copied kind maps to a distinct message key", () => {
    const reasons = ["stale-pane", "server-restarted", "tmux-unavailable", "bad-request", "network", "clipboard"] as const;
    const keys = reasons.map(reasonKey);
    expect(new Set(keys).size).toBe(reasons.length);
    expect(copiedKey("attach")).toBe("attach.copied");
    expect(copiedKey("readonly")).toBe("attach.copiedReadonly");
  });
});

describe("performAttachCopy", () => {
  test("resolves fresh, uncached, and copies the full command", async () => {
    const { fn, calls } = fakeFetch(200, okBody);
    const copied: string[] = [];
    const result = await performAttachCopy("agents:2.0", "attach", {
      fetch: fn,
      copy: async (text) => {
        copied.push(text);
        return true;
      },
    });
    expect(result).toEqual({ ok: true, command: ATTACH });
    expect(copied).toEqual([ATTACH]);
    expect(calls[0].url).toBe("/api/tmux?attach=1&target=agents%3A2.0");
    expect((calls[0].init as RequestInit).cache).toBe("no-store");
  });

  test("read-only copies the -r command", async () => {
    const { fn } = fakeFetch(200, okBody);
    const copied: string[] = [];
    const result = await performAttachCopy("agents:2.0", "readonly", { fetch: fn, copy: async (t) => (copied.push(t), true) });
    expect(result).toEqual({ ok: true, command: READONLY });
    expect(copied).toEqual([READONLY]);
  });

  test("a clipboard rejection surfaces as a clipboard failure", async () => {
    const { fn } = fakeFetch(200, okBody);
    const result = await performAttachCopy("agents:2.0", "attach", { fetch: fn, copy: async () => false });
    expect(result).toEqual({ ok: false, reason: "clipboard" });
  });

  test("a stale 409 never touches the clipboard", async () => {
    const { fn } = fakeFetch(409, { reason: "stale-pane" });
    let copyCalled = false;
    const result = await performAttachCopy("agents:2.0", "attach", {
      fetch: fn,
      copy: async () => ((copyCalled = true), true),
    });
    expect(result).toEqual({ ok: false, reason: "stale-pane" });
    expect(copyCalled).toBe(false);
  });

  test("a network failure resolves to a network reason without throwing", async () => {
    const { fn } = fakeFetch(0, null, { throws: true });
    const result = await performAttachCopy("agents:2.0", "attach", { fetch: fn, copy: async () => true });
    expect(result).toEqual({ ok: false, reason: "network" });
  });

  test("an unparseable 200 body degrades to tmux-unavailable", async () => {
    const { fn } = fakeFetch(200, null, { unparseable: true });
    const result = await performAttachCopy("agents:2.0", "attach", { fetch: fn, copy: async () => true });
    expect(result).toEqual({ ok: false, reason: "tmux-unavailable" });
  });
});
