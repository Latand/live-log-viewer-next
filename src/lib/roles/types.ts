export type RoleId =
  | "orchestrator"
  | "reviewer"
  | "verifier"
  | "builder"
  | "architect"
  | "cleaner"
  | "prod-auditor"
  | "deployer";

export type RoleEngine = "claude" | "codex";

export type RoleConfig = {
  engine: RoleEngine;
  model: string;
  effort: string;
};

export type RoleParameter = {
  key: string;
  label: string;
  description: string;
  kind: "text" | "integer" | "select";
  required?: boolean;
  options?: readonly string[];
  min?: number;
  max?: number;
};

export type RoleDefinition = {
  id: RoleId;
  name: string;
  description: string;
  config: RoleConfig;
  parameters: readonly RoleParameter[];
  promptScaffold: string;
  safetyFences: readonly string[];
  capabilities: readonly ("read-only" | "production-read" | "production-write" | "spawn")[];
};

export type RoleOverride = {
  config?: Partial<RoleConfig>;
  promptScaffold?: string;
};

export type RoleOverridesFile = {
  schemaVersion: 1;
  overrides: Partial<Record<RoleId, RoleOverride>>;
};

export type RoleParamValues = Record<string, string | number>;

export type ResolvedRole = {
  definition: RoleDefinition;
  config: RoleConfig;
  params: RoleParamValues;
  prompt: string;
  requiresDeploymentConfirmation: boolean;
};
