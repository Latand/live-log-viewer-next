# Issue #1003: Carry the runtime home through production adapter builds

Fix the production Viewer deployment path so the runtime-host adapter passes its validated `$HOME` into Docker as `LLV_RUNTIME_HOME`. Candidate images must bake the same home into the uid-1000 passwd entry and runtime `HOME`, allowing OpenSSH to resolve the mounted operator credentials during Git-over-SSH operations. Preserve the existing Dockerfile and Compose credential model, and add a regression gate around the adapter build path that production deploys actually use.

## Acceptance criteria

AC1: The runtime-host adapter validates that its `HOME` value is present and absolute before candidate build work mutates deployment state.

AC2: The adapter's candidate `docker build` invocation passes `--build-arg LLV_RUNTIME_HOME=<runtime-host HOME>` as one argument value without shell interpolation.

AC3: The candidate Dockerfile continues to use `LLV_RUNTIME_HOME` for both the runtime `HOME` environment and the uid-1000 passwd home.

AC4: The adapter integration test executes the `build-candidate` action, captures its Docker invocation, and asserts the `LLV_RUNTIME_HOME` build argument independently of Compose interpolation.

AC5: Product source changes remain within the deployment adapter, Docker configuration, and related-test scope; runtime flows, API routes, and UI remain unchanged.

AC6: After the next approved fresh production deploy through `scripts/rebuild.sh`, `getent passwd 1000` reports the same home as `$HOME` inside the serving container.

AC7: After that deploy, `git ls-remote` over SSH to the repository succeeds from the serving container using the mounted operator credentials.

AC8: Focused adapter tests, TypeScript type checking, diff checks, and publication privacy gates pass without a deployment or container restart during implementation.

## Validation gates

- `bun run build:mcp` to generate the ignored MCP bundle required by the complete adapter test file in a fresh worktree
- `bun test scripts/runtime-host-viewer-adapter.test.ts`
- `bunx tsc --noEmit`
- `git diff --check`
- `bun scripts/privacy-publication-gate.ts --base origin/main`
- `bun run privacy:check`

## Deployment boundary

Production deployment and runtime acceptance for AC6 and AC7 remain scheduled for the next operator-approved deploy.
