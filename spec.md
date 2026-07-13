# Issue #166: Isolate real-CLI integration-test sessions

Run the Codex app-server and Claude broker integration suites with fresh temporary homes so their real session artifacts never enter the user's scanned roots.

## Acceptance criteria

AC1: Every Codex integration run sets `CODEX_HOME` to a fresh temporary directory, uses only the minimal copied file credential, and removes the directory during teardown.

AC2: Every Claude integration run sets both `HOME` and `CLAUDE_CONFIG_DIR` to a fresh temporary directory, uses only the minimal copied subscription credential, and removes the directory during teardown.

AC3: A missing binary, missing credential, unsafe credential source, or failed isolated-home authentication probe keeps the existing graceful-skip behavior.

AC4: Each real integration test asserts that its produced rollout or transcript exists beneath its temporary home.

AC5: Codex late attach, steering, and restart resume coverage remains unchanged; Claude late attach, restart resume, and permission-answer coverage remains unchanged.

AC6: Running the focused integration suites creates zero new files containing the ZEBRA-149, ORCHID-150, or ACK-150 markers under `~/.codex/sessions` and `~/.claude/projects`.

## Validation gates

- `bun test`
- `bunx tsc --noEmit`
- `bun test src/lib/runtime/codexAppServerHost.integration.test.ts src/lib/runtime/claudeStreamBrokerHost.integration.test.ts`
- marker-file comparison under `~/.codex/sessions` and `~/.claude/projects`
