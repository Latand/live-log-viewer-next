import { describe, expect, test } from "bun:test";

import {
  rolledBack,
  runtimeEventsEnabled,
  runtimeHostActivationRefusal,
  runtimeUiEnabled,
  structuredHostsEnabled,
} from "./flags";

/* The switches are reached for during an incident, through whatever surface is
   at hand. A rollback that silently no-ops because the value arrived padded or
   quoted is worse than no rollback: it will be trusted. */
const ROLLED_BACK = ["0", " 0 ", "\t0\n", "\"0\"", "'0'", "false", "False", "OFF", "no"] as const;
const STILL_ON = [undefined, "", "   ", "1", "true", "on", "yes", "00", "0x0"] as const;

describe("rollback value normalisation", () => {
  test.each(ROLLED_BACK.map((value) => [value] as const))("%p rolls the switch back", (value) => {
    expect(rolledBack(value)).toBeTrue();
    expect(structuredHostsEnabled({ LLV_STRUCTURED_HOSTS: value })).toBeFalse();
    expect(runtimeEventsEnabled({ LLV_RUNTIME_EVENTS: value, LLV_RUNTIME_HOST_SOCKET: "/run/llv/runtime.sock" })).toBeFalse();
    expect(runtimeUiEnabled({ NEXT_PUBLIC_RUNTIME_UI: value })).toBeFalse();
  });

  test.each(STILL_ON.map((value) => [value] as const))("%p leaves the default on", (value) => {
    expect(rolledBack(value)).toBeFalse();
    expect(structuredHostsEnabled({ LLV_STRUCTURED_HOSTS: value })).toBeTrue();
    expect(runtimeEventsEnabled({ LLV_RUNTIME_EVENTS: value, LLV_RUNTIME_HOST_SOCKET: "/run/llv/runtime.sock" })).toBeTrue();
    expect(runtimeUiEnabled({ NEXT_PUBLIC_RUNTIME_UI: value })).toBeTrue();
  });

  test("the socket stays a deployment fact, never a policy default", () => {
    expect(runtimeEventsEnabled({})).toBeFalse();
    expect(runtimeEventsEnabled({ LLV_RUNTIME_HOST_SOCKET: "   " })).toBeFalse();
  });
});

describe("runtime host activation", () => {
  /* The viewer treats the events variable as on-unless-rolled-back. The host
     process must read it the same way, or a deployment that merely drops the
     variable gets a viewer that believes events are live and a host that exits
     at boot — the exact scenario the defaults exist to survive. */
  test("a dropped variable no longer refuses the boot", () => {
    expect(runtimeHostActivationRefusal({})).toBeNull();
    expect(runtimeHostActivationRefusal({ LLV_RUNTIME_EVENTS: "1" })).toBeNull();
  });

  test("the explicit rollback still refuses the boot", () => {
    expect(runtimeHostActivationRefusal({ LLV_RUNTIME_EVENTS: "0" })).toContain("LLV_RUNTIME_EVENTS=0");
    expect(runtimeHostActivationRefusal({ LLV_RUNTIME_EVENTS: " 0 " })).toContain("LLV_RUNTIME_EVENTS=0");
    expect(runtimeHostActivationRefusal({ LLV_RUNTIME_EVENTS: "false" })).toContain("LLV_RUNTIME_EVENTS=0");
  });
});
