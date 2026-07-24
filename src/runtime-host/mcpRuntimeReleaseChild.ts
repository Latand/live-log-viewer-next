import { McpRuntimeReleaseStore, type McpRuntimePublicationBoundary } from "./mcpRuntimeRelease";

const source = process.env.LLV_MCP_TEST_SOURCE;
const state = process.env.LLV_MCP_TEST_STATE;
const stable = process.env.LLV_MCP_TEST_STABLE;
const revision = process.env.LLV_MCP_TEST_REVISION;
const boundary = process.env.LLV_MCP_TEST_BOUNDARY as McpRuntimePublicationBoundary | undefined;

if (!source || !state || !stable || !revision || !boundary) throw new Error("MCP runtime crash fixture is incomplete");

const store = new McpRuntimeReleaseStore({
  stateDir: state,
  stableRuntimeRoot: stable,
  publicationBoundary: (observed) => {
    if (observed === boundary) process.exit(86);
  },
});

if (process.env.LLV_MCP_TEST_ACTION === "install-launcher") {
  store.installStableLauncher(source);
} else if (process.env.LLV_MCP_TEST_ACTION === "publish-target") {
  const target = process.env.LLV_MCP_TEST_TARGET;
  if (!target) throw new Error("MCP runtime target crash fixture is incomplete");
  store.publishReleaseTarget(target, {
    revision,
    image: `viewer:${revision}`,
    container: "viewer-candidate",
    endpoint: "http://127.0.0.1:18001",
    mcpRuntime: {
      source: "managed",
      revision,
      releaseId: "deploy-crash-boundary",
      artifactDigest: "a".repeat(64),
      stagedAt: "2026-07-23T08:00:00.000Z",
    },
  });
} else {
  store.stagePreparedPackage(source, "deploy-crash-boundary", revision);
}
