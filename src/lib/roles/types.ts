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

type RoleParameterBase = {
  key: string;
  label: string;
  description: string;
  required?: boolean;
};

export type RoleParameter = RoleParameterBase & ({
  kind: "text";
  default?: string;
} | {
  kind: "integer";
  default?: number;
  min?: number;
  max?: number;
} | {
  kind: "select";
  default?: string;
  options?: readonly string[];
});

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
  "prompt": string;
  requiresDeploymentConfirmation: boolean;
};
