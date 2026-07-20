export const WAKATIME_CREDENTIAL_ENV = "WAKATIME_API_KEY";

/** Discard the unsupported environment credential without materializing it. */
export function discardWakatimeEnvironmentCredential(
  environment: Record<string, string | undefined> = process.env,
): void {
  delete environment[WAKATIME_CREDENTIAL_ENV];
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
