import type { RoleConfig } from "./types";

/**
 * Fixed variant configs for the builder role's two special param
 * combinations. These intentionally override whatever the base builder
 * config is (including a saved role override): apply-fixes and frontend
 * runs need a specific engine/model regardless. Client-safe (no node:*
 * imports) so the draft pane can mirror the registry's `configForParams`
 * without duplicating the literals and drifting from them.
 */
export const BUILDER_FRONTEND_CONFIG: RoleConfig = { engine: "claude", model: "opus", effort: "high" };
export const BUILDER_APPLY_FIXES_CONFIG: RoleConfig = { engine: "codex", model: "gpt-5.6-terra", effort: "low" };
