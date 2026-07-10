export function runtimeEventsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LLV_RUNTIME_EVENTS === "1" && Boolean(env.LLV_RUNTIME_HOST_SOCKET);
}

export function runtimeHostSocket(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.LLV_RUNTIME_HOST_SOCKET?.trim();
  return value || null;
}
