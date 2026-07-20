export const WAKATIME_CREDENTIAL_ENV = "WAKATIME_API_KEY";

export interface CapturedWakatimeEnvironmentCredential {
  value: string;
  sourceStamp: string;
}

export interface WakatimeEnvironmentCredentialStore {
  capture(environment?: NodeJS.ProcessEnv): void;
  read(): CapturedWakatimeEnvironmentCredential | null;
}

/** Owns the environment credential in a closure that is absent from process
    environment copies, child inheritance, diagnostics, and durable state. */
export function createWakatimeEnvironmentCredentialStore(): WakatimeEnvironmentCredentialStore {
  let value: string | null = null;
  let generation = 0;
  return {
    capture(environment = process.env) {
      const replacement = environment[WAKATIME_CREDENTIAL_ENV]?.trim() || null;
      delete environment[WAKATIME_CREDENTIAL_ENV];
      if (replacement && replacement !== value) {
        value = replacement;
        generation += 1;
      }
    },
    read() {
      return value ? { value, sourceStamp: `environment:${generation}` } : null;
    },
  };
}

export const wakatimeEnvironmentCredentialStore = createWakatimeEnvironmentCredentialStore();

/** Copy an environment for a child process while keeping the Viewer-owned
    WakaTime credential inside the server process. */
export function withoutWakatimeCredential(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env[WAKATIME_CREDENTIAL_ENV];
  return env;
}
