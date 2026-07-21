export const WAKATIME_CREDENTIAL_ENV = "WAKATIME_API_KEY";

/** Discard the unsupported environment credential without materializing it. */
export function discardWakatimeEnvironmentCredential(
  environment: Record<string, string | undefined> = process.env,
): void {
  delete environment[WAKATIME_CREDENTIAL_ENV];
}

/** Drop the unsupported credential from Docker-style `NAME=value` entries so
    an inspected container environment can be cloned into a new container
    without the credential's name or value ever entering the clone. */
export function withoutWakatimeCredentialEntries(entries: readonly string[]): string[] {
  return entries.filter((entry) => entry.split("=", 1)[0] !== WAKATIME_CREDENTIAL_ENV);
}

/** Copy an environment while omitting the unsupported credential name before
    its value can be read into the snapshot. */
export function withoutWakatimeCredential(
  base: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  for (const key of Object.keys(base)) {
    if (key === WAKATIME_CREDENTIAL_ENV) continue;
    env[key] = base[key];
  }
  return env;
}
