export const WAKATIME_CREDENTIAL_ENV = "WAKATIME_API_KEY";

/** Move the environment credential into server-owned memory. The deletion is
    synchronous so later startup work cannot copy it into a child process. */
export function takeWakatimeEnvironmentCredential(environment: NodeJS.ProcessEnv = process.env): string | null {
  const value = environment[WAKATIME_CREDENTIAL_ENV]?.trim() || null;
  delete environment[WAKATIME_CREDENTIAL_ENV];
  return value;
}

/** Copy an environment for a child process while keeping the Viewer-owned
    WakaTime credential inside the server process. */
export function withoutWakatimeCredential(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env[WAKATIME_CREDENTIAL_ENV];
  return env;
}
