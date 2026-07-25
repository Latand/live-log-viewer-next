/* Structured hosting is the production transport (pane-less spawns, direct
   host delivery, no tmux server in the loop). LLV_STRUCTURED_HOSTS and
   LLV_RUNTIME_EVENTS began as rollout gates that had to be switched on; they
   are rollback switches now, so the default path is the fast one and an
   explicit "0" is what steps back to the legacy behaviour.

   The socket stays deliberately explicit: it is a deployment fact, not a
   policy default, and an unset socket must keep reporting "no runtime host"
   rather than pointing the viewer at a path nothing is listening on. */

/** Any environment record these switches can be read from: `process.env` in
    production, a plain object in a test or a caller-supplied deployment env. */
export type EnvRecord = Readonly<Record<string, string | undefined>>;

/**
 * The body `code` the runtime routes answer with when the deployment carries no
 * runtime plane at all — no socket, or the events switch rolled back — as
 * opposed to a declared host that is momentarily unreachable. The client bus
 * drops its host authority on this code and keeps its fail-safe reconnect for
 * everything else.
 */
export const RUNTIME_PLANE_ABSENT = "runtime-plane-absent";

/**
 * The one reader every rollback switch goes through.
 *
 * An operator reaches for these during an incident, through whatever surface is
 * at hand: a compose `environment:` line, an `env_file` that preserves the
 * trailing space, a quoted shell export. A switch that silently no-ops on
 * `" 0 "` or `'0'` is worse than no switch at all, so the value is trimmed,
 * unquoted, lowercased, and the usual falsey spellings are accepted.
 *
 * Deliberately narrow in the other direction: unset and empty stay ON (absence
 * is not a rollback — that is the whole point of the defaults), and no truthy
 * spelling is invented, so the explicit `1` values in compose and the
 * Dockerfile keep meaning exactly what they meant before.
 */
export function rolledBack(value: string | undefined): boolean {
  if (value === undefined) return false;
  const unquoted = value.trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
  switch (unquoted.trim().toLowerCase()) {
    case "0":
    case "false":
    case "off":
    case "no":
      return true;
    default:
      return false;
  }
}

/** Structured hosts own every conversation unless explicitly rolled back. */
export function structuredHostsEnabled(env: EnvRecord = process.env): boolean {
  return !rolledBack(env.LLV_STRUCTURED_HOSTS);
}

/** Whether the events plane was explicitly rolled back. The viewer and the
    runtime-host process both branch on this one answer, so a dropped variable
    cannot mean "on" in the viewer and "refuse to boot" in the host. */
export function runtimeEventsRolledBack(env: EnvRecord = process.env): boolean {
  return rolledBack(env.LLV_RUNTIME_EVENTS);
}

export function runtimeEventsEnabled(env: EnvRecord = process.env): boolean {
  return !runtimeEventsRolledBack(env) && Boolean(runtimeHostSocket(env));
}

/** Server-side read of the viewer-controls switch. The client read is inlined
    at build time (see `isRuntimeUiEnabled`), so the two legitimately see
    different values; this one answers for the env record the server holds. */
export function runtimeUiEnabled(env: EnvRecord = process.env): boolean {
  return !rolledBack(env.NEXT_PUBLIC_RUNTIME_UI);
}

/** Why the runtime host must refuse to boot, or null to proceed. A started
    runtime-host is always an events host (the compose comment states that as a
    contract), so the refusal survives — it now triggers on the explicit
    rollback instead of on anything short of a literal `1`. */
export function runtimeHostActivationRefusal(env: EnvRecord = process.env): string | null {
  return runtimeEventsRolledBack(env)
    ? "runtime host activation is rolled back by LLV_RUNTIME_EVENTS=0"
    : null;
}

export function runtimeHostSocket(env: EnvRecord = process.env): string | null {
  const value = env.LLV_RUNTIME_HOST_SOCKET?.trim();
  return value || null;
}
