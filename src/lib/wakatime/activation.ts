export type WakatimeActivationEnvironment = Readonly<Record<string, string | undefined>>;

/** One activation rule shared by startup and every direct-activity ingress. */
export function wakatimeIntegrationEnabled(
  env: WakatimeActivationEnvironment = process.env,
): boolean {
  return env.LLV_WAKATIME_ENABLED === "1";
}
