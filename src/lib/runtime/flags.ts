/* Structured hosting is the production transport (pane-less spawns, direct
   host delivery, no tmux server in the loop). LLV_STRUCTURED_HOSTS and
   LLV_RUNTIME_EVENTS began as rollout gates that had to be switched on; they
   are rollback switches now, so the default path is the fast one and an
   explicit "0" is what steps back to the legacy behaviour.

   The socket stays deliberately explicit: it is a deployment fact, not a
   policy default, and an unset socket must keep reporting "no runtime host"
   rather than pointing the viewer at a path nothing is listening on. */

/** Structured hosts own every conversation unless explicitly rolled back. */
export function structuredHostsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LLV_STRUCTURED_HOSTS !== "0";
}

export function runtimeEventsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LLV_RUNTIME_EVENTS !== "0" && Boolean(runtimeHostSocket(env));
}

export function runtimeHostSocket(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.LLV_RUNTIME_HOST_SOCKET?.trim();
  return value || null;
}
