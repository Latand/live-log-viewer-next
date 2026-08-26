import { durableSemanticTitle } from "@/lib/title";

import type { AgentRegistry, SpawnRequest } from "./registry";

const LEGACY_FIXTURE_TITLE = "Exercise legacy spawn fixture";
const adaptedRegistries = new WeakSet<AgentRegistry>();

function titledFixtureRequest(input: SpawnRequest): SpawnRequest {
  if (process.env.NODE_ENV !== "test") throw new Error("legacy spawn fixtures are test-only");
  return {
    ...input,
    launchProfile: {
      ...(input.launchProfile ?? {}),
      title: durableSemanticTitle(input.launchProfile?.title) ?? LEGACY_FIXTURE_TITLE,
    },
  };
}

export function beginLegacySpawnFixture(
  registry: AgentRegistry,
  input: SpawnRequest,
): ReturnType<AgentRegistry["beginSpawnRequest"]> {
  return registry.beginSpawnRequest(titledFixtureRequest(input));
}

export function beginLegacySpawnReceiptFixture(
  registry: AgentRegistry,
  ...[engine, cwd, launchProfile = {}]: Parameters<AgentRegistry["beginSpawn"]>
): ReturnType<AgentRegistry["beginSpawn"]> {
  return registry.beginSpawn(engine, cwd, {
    ...launchProfile,
    title: durableSemanticTitle(launchProfile.title) ?? LEGACY_FIXTURE_TITLE,
  });
}

/**
 * Opt-in adapter for older tests whose subject predates semantic spawn titles.
 * Each adapted call still crosses the real registry admission boundary with a
 * semantic title. Production callers and title-admission tests use AgentRegistry
 * directly and retain the missing-title rejection contract.
 */
export function withLegacySpawnFixtureTitles<T extends AgentRegistry>(registry: T): T {
  if (process.env.NODE_ENV !== "test") throw new Error("legacy spawn fixtures are test-only");
  if (adaptedRegistries.has(registry)) return registry;

  const beginSpawnRequest = registry.beginSpawnRequest.bind(registry);
  registry.beginSpawnRequest = ((input: SpawnRequest) => (
    beginSpawnRequest(titledFixtureRequest(input))
  )) as T["beginSpawnRequest"];
  adaptedRegistries.add(registry);
  return registry;
}
