# Round 3: model effort scales and built-in launch defaults

Starting HEAD: `4ca6ee11f0f3556896a64fac2bf447fce7ad6ccf`.
Merge base with the local `origin/main`: `dc3f17391f7b64d9bcf6a9ffd0363e185917a83a`.

## Repository sweep before edits

Commands:

```sh
rtk proxy rg -n 'isEngineEffort|CODEX_SOL_MODEL|gpt-5\.6-sol' --glob '!**/*test*' --glob '!**/*fixture*' --glob '!bun.lock' --glob '!package-lock.json'
rtk proxy rg -n 'ENGINE_EFFORTS' src --glob '!*test*'
```

Every production `isEngineEffort` caller at the starting HEAD:

| Caller | Disposition |
| --- | --- |
| `src/lib/pipelines/store.ts:59` | Validate persisted effective roles using their model scale. Creation and edited stages round-trip at Astra max/ultra. |
| `src/lib/flows/commands.ts:71` | Validate merged reviewer overrides using their model scale. Errors name the model and its actual options. |
| `src/components/draft/AgentLaunchControls.tsx:199` | Engine switches explicitly select `defaultModelFor`; preserve effort supported by that selected model. |
| `src/components/pipelines/StagePlaceholderPane.tsx:137` | Retained deliberately. Switching engine sends `model:null`, leaving the CLI model unresolved. The pipeline resolver uses the base engine scale for that null model. Added a comment and high/max switch coverage. |

`src/lib/agent/efforts.ts` defines the engine-wide helper; `src/lib/agent/cli.ts` re-exports it. Both remain available for the legitimate unresolved-model case.

Every production hardcoded Sol selection/reference:

| Location | Disposition |
| --- | --- |
| `src/lib/telegram/reportRunner.ts:540` | Built-in report launch now uses `defaultModelFor("codex")`, currently Astra. |
| `src/lib/agent/models.ts:12` | Keep the Sol constant: explicit Sol is supported. |
| `src/lib/agent/models.ts:18` | Keep Sol image-input capability membership. |
| `src/lib/agent/models.ts:47` | Keep Sol in the selectable model catalog. |

Other sweep matches were excluded by purpose, even where their filenames did not say test: `src/lib/state/hotStateStores.sqliteChild.ts:48` is a concurrent-store test child; `scripts/npm-package-smoke.mjs:80` is a fake app-server model-list response. README, research/design documents, and screenshot harness/capture/generate-stills files are documentation and fixtures. Their explicit/historical Sol references remain unchanged.

The direct `ENGINE_EFFORTS` sweep additionally found `ReasoningControls`, `FlowDialog.RoleEditor`, and `GroupOverridePanel.EffortSelect`. All now render the selected model's scale. Group override engine reset still uses the base scale through `effortScale(next, null)`, because it clears the model. The remaining direct reads in `efforts.ts` define the Claude scale and unknown/null Codex fallback; they are intentional.

No seed or migration code changed. Saved operator choices remain untouched. Explicit Sol max/ultra succeeds. Luna/ultra and Claude/ultra return `low, medium, high, xhigh, max` in their errors.

## Exact test invocation

Tests ran sequentially in foreground shell processes, one path per Bun invocation. This runner was saved as `/tmp/llv-round3/run`:

```bash
#!/bin/bash
set -o pipefail
file=$1
phase=$2
scratch=$(mktemp -d /tmp/llv-round3/check-XXXXXX)
mkdir -p "$scratch"/{home,config,state,tmp,claude,codex}
HOME="$scratch/home" XDG_CONFIG_HOME="$scratch/config" LLV_STATE_DIR="$scratch/state" TMPDIR="$scratch/tmp" LLV_CLAUDE_HOME="$scratch/claude" LLV_CODEX_HOME="$scratch/codex" bun test "$file" > "/tmp/llv-round3/logs/${phase}-$(basename "$file").log" 2>&1
code=$?
tail -n 6 "/tmp/llv-round3/logs/${phase}-$(basename "$file").log"
echo "EXIT=$code FILE=$file"
exit "$code"
```

For every path in the results table, the exact foreground command was:

```sh
rtk proxy bash /tmp/llv-round3/run '<path>' final
```

Some independent files were executed by a sequential shell `for` loop around that same runner. No Bun invocation received multiple paths. Log filenames use basenames, so successive store/route suites replace earlier raw logs; the per-path results below retain their observed counts.

## RED evidence

Tests were first run before their production fixes. The final regression tests were also copied into a separate `git archive 4ca6ee11` tree with the same dependency directory, then replayed against unchanged baseline production code using:

```sh
rtk proxy bash /tmp/llv-round3/run '<path>' baseline-red
```

All seven baseline invocations exited 1. Their GREEN counterparts exited 0.

| Regression test file | RED pass/fail | Quoted RED evidence | GREEN pass/fail |
| --- | --- | --- | --- |
| `src/lib/pipelines/store.test.ts` | 11/2 | `PipelineStoreError: refusing to persist a malformed pipeline record` | 13/0 |
| `src/lib/flows/commands.set-roles.test.ts` | 19/6 | `Received: "invalid reviewer role override"`; the unsupported-model cases expected model-specific option errors | 25/0 |
| `src/lib/telegram/reportRunner.test.ts` | 43/1 | `Expected: "gpt-6-astra"`, `Received: "gpt-5.6-sol"` | 44/0 |
| `src/components/draft/AgentLaunchControls.dom.test.tsx` | 5/1 | `Expected: "max"`, `Received: ""` | 6/0 |
| `src/components/scheme/GroupOverridePanel.render.test.tsx` | 5/2 | `Expected to contain: "value=\"ultra\" selected=\"\""` | 7/0 |
| `src/components/ReasoningControls.render.test.tsx` | 0/3 | `Expected to contain: "value=\"max\" selected=\"\""` | 3/0 |
| `src/components/flows/FlowDialog.dom.test.tsx` | 0/3 | `Expected: "max"`, `Received: ""` | 3/0 |

Pipeline tests exercise both initial persistence and subsequent stage edits. Flow tests persist Astra and explicit Sol at max/ultra, and check rejection preserves the prior role. Selector tests cover Astra/Sol and Luna's supported maximum; stage engine-switch tests preserve the intentional unresolved-model behavior.

## Final test results

| Test path | Pass | Fail |
| --- | ---: | ---: |
| `src/lib/pipelines/store.test.ts` | 13 | 0 |
| `src/lib/flows/commands.test.ts` | 4 | 0 |
| `src/lib/flows/commands.set-roles.test.ts` | 25 | 0 |
| `src/lib/flows/commands.durable.test.ts` | 7 | 0 |
| `src/lib/flows/store.test.ts` | 17 | 0 |
| `src/lib/workflows/store.test.ts` | 24 | 0 |
| `src/lib/workflows/store-isolation.test.ts` | 1 | 0 |
| `src/lib/roles/store.test.ts` | 6 | 0 |
| `src/lib/roles/registry.test.ts` | 9 | 0 |
| `src/lib/orchestrator/seatCommand.test.ts` | 68 | 0 |
| `src/app/api/spawn/route.test.ts` | 57 | 0 |
| `src/app/api/spawn/route.binding.test.ts` | 6 | 0 |
| `src/app/api/tasks/[id]/spawn/route.test.ts` | 12 | 0 |
| `src/app/api/tasks/[id]/spawn/route.binding.test.ts` | 6 | 0 |
| `src/lib/agent/efforts.test.ts` | 14 | 0 |
| `src/lib/agent/models.test.ts` | 8 | 0 |
| `src/lib/agent/reconfigure.test.ts` | 5 | 0 |
| `src/lib/pipelines/roles.test.ts` | 26 | 0 |
| `src/lib/pipelines/engine.test.ts` | 231 | 0 |
| `src/lib/mcp/bindings.test.ts` | 51 | 0 |
| `src/lib/runtime/spawnTransport.test.ts` | 26 | 0 |
| `src/components/RuntimePill.dom.test.tsx` | 16 | 0 |
| `src/components/runtimeProfile.test.ts` | 11 | 0 |
| `src/components/ReasoningControls.render.test.tsx` | 3 | 0 |
| `src/components/flows/FlowDialog.dom.test.tsx` | 3 | 0 |
| `src/components/draft/AgentLaunchControls.dom.test.tsx` | 6 | 0 |
| `src/components/pipelines/StagePlaceholderPane.dom.test.tsx` | 11 | 0 |
| `src/components/scheme/GroupOverridePanel.render.test.tsx` | 7 | 0 |
| `src/components/scheme/GroupOverridePanel.dom.test.tsx` | 11 | 0 |
| `src/lib/telegram/reportRunner.test.ts` | 44 | 0 |

Total: 728 passing tests across 30 files.

Additional check: `src/app/api/spawn/route.admission.test.ts` returned 7 pass / 1 fail on both the changed tree and unchanged starting HEAD. In both, `an operator capability caller without src proceeds as a silent root (#341)` reports `Expected: 202`, `Received: 400`. Commands used the runner with `final` and `baseline` phases respectively. This additional suite is not a green gate; the baseline comparison does not establish the root cause. It was left outside this patch.

An intermediate commands test caught an overbroad assumption about cleared flow models. The final implementation preserves the original null-model validation, and the full commands suite passes. An initial TypeScript run found an extra `onCreated` prop in the new test; that prop was removed.

TypeScript command:

```bash
rtk proxy bash -c 'scratch=$(mktemp -d /tmp/llv-round3/tsc-XXXXXX); mkdir -p "$scratch"/{home,config,state,tmp}; HOME="$scratch/home" XDG_CONFIG_HOME="$scratch/config" LLV_STATE_DIR="$scratch/state" TMPDIR="$scratch/tmp" bunx tsc --noEmit --incremental false > /tmp/llv-round3/tsc.log 2>&1; code=$?; cat /tmp/llv-round3/tsc.log; echo "EXIT=$code"; exit "$code"'
```

TypeScript final result: exit 0, no diagnostics.

The four prohibited files have no diff. Verification is local; no hosted CI or deployment is claimed.
