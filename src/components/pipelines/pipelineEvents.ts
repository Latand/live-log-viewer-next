/**
 * Pipeline client-cache events, in their own module so the data layer
 * (hooks/useFiles) and the mutation layer (pipelineModel) can share them
 * without importing each other.
 */

/** A mutation that changes more than the pipeline record itself (spawns/kills
    agents, closes flows) — subscribers refetch the full board snapshot. */
export const PIPELINES_CHANGED_EVENT = "llv:pipelines-changed";

/** A pipeline record was patched into the client cache in place (an optimistic
    apply or a PATCH/POST echo) — subscribers re-read the cache, no refetch. */
export const PIPELINES_PATCHED_EVENT = "llv:pipelines-patched";
