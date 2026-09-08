# Startup and rollback verification for #1552

Base: `88e5a9508be2802266734056d6436f3168201cad`.
The preserved implementation commit is `aff60edc251ede29190b7ca687aceb2f87fa44ac`.
The successor adopted that commit by fast-forward. The original checkout was clean and was left unchanged. The successor adds provider-side delivery evidence, an explicit rollback wall-clock bound, and a regression for partial host registration.

The implementation batches independent historical work in groups of 16 and joins every started operation. Pending launches retain fresh evidence reads. Retirement aborts and joins startup, releases registered and unpublished owned hosts, and acquires rollback checkpoint leases asynchronously. The activation owner must acknowledge its own fence while alive; the adapter may checkpoint only after positive owner death. Registered hosts keep draining while unregistered targets retain their original pending operations.

Promoted serving verification has a 300-second inner budget inside the runtime-host action's 360-second deadline. A shortened rehearsal action also shortens its inner budget. The 90-second rollback action deadline is unchanged.

## Validation

All runs used Bun 1.4.0, explicit test paths, empty private HOME, XDG configuration, runtime state and provider homes, and a short private TMPDIR. Each targeted file ran in a separate process. Tests and rehearsals used their own child handles and ephemeral endpoints.

- Standalone Next Viewer and MCP build: passed.
- Nonincremental TypeScript: passed.
- Targeted tests: 475 passed across the files below. The adapter suite's initial run lacked the not-yet-built MCP bundle; its complete post-build rerun passed.
- Runtime host: singleton succession in 503 ms; stable listener and runtime socket each answered 27/27 probes over 15 seconds, including abandoned peers.
- Whole-diff privacy gate, known-value fingerprints and commit checks: passed before publication.

The recovered baseline packaged artifact failed rollback after 125.806 seconds with `pipeline state is busy`, left the candidate running, and recorded 45 late historical publications. Recovered repaired artifacts reached readiness in 164.264 seconds and rollback in 64.967 seconds. These earlier observations establish provenance; the final successor runs below qualify the additional evidence assertions.

| Final packaged run | Observed outcome |
| --- | --- |
| Headroom, historical replies held until 135 s; snapshot delay 3 s, other RPC delay 5 ms | Ready at 158.087 s, within 300 s; six hosted writers retained; subsequent pipeline creation persisted; exit 0 |
| Forced rollback, verify action limited to 120 s | Terminal rolled-back at 66.566 s, within the asserted 215 s bound; candidate exited 0; target restored; no orphan readiness |
| Restored Viewer | Ready 35.021 s after rollback observation; all six original receipts delivered |
| Both runs: original provider inputs | Exactly six, each matched to its unchanged original request; three expected recovery continuations counted separately |
| Both runs: preservation | Both independent HTTP workers alive with unchanged recorded ownership; deferred spawn receipt, original key and payload unchanged |
| Both runs: late work | Zero historical publications after the fence; zero candidate mutations after checkpoint acknowledgement or target restoration |

The exact provider-evidence matcher was also evaluated against retained inputs with one record removed, duplicated, altered in payload, or assigned a different operation ID. Each corrupted case failed; the intact control passed. Final runs required no forced child cleanup. The relay records broken-pipe events from intentionally delayed responses; these are transport observations and did not become process failures.

The immutable standalone package contains 2,568 files. Its manifest digest is
`af2fdeef2319f3fa8a59edfb1f4f3485262ac6d7c9c27998bc9124df65b5732a`:
SHA-256 over sorted relative filenames, NUL, each file's SHA-256, and newline.
Production source matches the preserved repair commit; successor changes concern verification.

Reproduction commands, after assigning empty private state/provider homes and
building with `LLV_STANDALONE=1 NEXT_PUBLIC_RUNTIME_UI=1 bun run build`:

```sh
python3 scripts/verify-packaged-startup.py --viewer "$PACKAGE" \
  --runtime-source "$RUNTIME_SOURCE" --bun "$BUN" \
  --snapshot-delay-ms 3000 --rpc-delay-ms 5 --hold-startup-ms 135000
python3 scripts/verify-packaged-startup.py --viewer "$PACKAGE" \
  --runtime-source "$RUNTIME_SOURCE" --bun "$BUN" \
  --rollback --verify-timeout-ms 120000
```

`PACKAGE` contains `.next/standalone` plus `bin`, `dist`, `public` and
`.next/static`. `RUNTIME_SOURCE` is the exact candidate source for these
rehearsals. `BUN` is a Bun 1.4.0 binary. The harness independently creates empty
private homes and state, clears inherited credentials, and uses local provider fixtures.

The packaged fixture contains 6,623 retained receipts, 8,078 conversations, 5,188 entries and 1,719 held deliveries. It runs actual standalone instrumentation, transcript refresh, both native host wrappers, the runtime journal, delivery controller and SQLite admission. Providers are local protocol implementations. Both external workers are separate HTTP processes with independently recorded ownership. A deferred spawn retains its original key and payload.

Provider evidence matches each of the six immutable journal requests to one observed provider input. Codex inputs must retain the original operation ID and its deduplication envelope. Claude inputs use the exact unique fixture payload and session because its input protocol carries no client key. Expected interrupted-turn continuations are counted separately with their exact key and payload contract. Receipt-only success is insufficient. Candidate mutations after checkpoint acknowledgement or target restoration, late historical publication, and orphan readiness fail qualification.

Forced rollback uses the actual coordinator, command adapter, authority, journal, checkpoint and restored standalone Viewer. Container inspection and candidate prechecks are fixture setup. Its 120-second action limit produces a 60-second inner serving limit; terminal rollback must occur within the action limit plus the existing 90-second rollback limit and a 5-second observation allowance. Candidate clean exit and restored readiness are independent assertions. Teardown may force only an exact private runtime-host child after all preservation observations; that is recorded separately and does not establish graceful production host shutdown.

This evidence does not qualify a container image, live provider authentication, or production deployment. Root owns those release checks and one fresh independent review.

## Bootstrap blocker

The incumbent runtime host still has its old 120-second verify-promoted deadline loaded. The new 360-second value becomes effective only when a new host generation runs. `deploy_exact_sha` delegates to that incumbent; its host-handoff phase follows promoted verification. A larger deadline in candidate source therefore cannot bootstrap itself.

Current source and `docs/docker.md` provide `bun scripts/bootstrap-runtime-host.ts <exact-main-sha>` with plan, `--stage`, and `--hand-over` modes. The 13 bootstrap and 36 successor tests passed. This path stages a parked successor and explicitly stops the predecessor runtime-host container. It is a production lifecycle action beyond this builder's authorization. The image-build path also removes its own canonical bootstrap worktree, so the preservation restriction must be accounted for before selecting it. No bootstrap command was executed against production.

No bootstrap path through the currently exposed `deploy_exact_sha` capability that avoids this lifecycle boundary has been established. This remains a release blocker requiring the root orchestrator's decision. A successful isolated rehearsal does not waive it. After a supported bootstrap, root must verify the exact merged runtime-host revision and then perform the ordinary exact-SHA deployment and live continuity checks. Existing pending operator sends and launches remain untouched.

## Targeted tests

| File | Passed |
| --- | ---: |
| `src/lib/runtime/startup.test.ts` | 87 |
| `src/lib/runtime/startupFinalization.integration.test.ts` | 12 |
| `src/lib/runtime/structuredDeliveryQueue.test.ts` | 63 |
| `src/lib/runtime/structuredDeliveryController.test.ts` | 1 |
| `src/lib/runtime/structuredDeliveryRebind.test.ts` | 13 |
| `src/lib/runtime/structuredSpawn.integration.test.ts` | 84 |
| `src/lib/runtime/structuredSpawn.terminalize.test.ts` | 20 |
| `src/lib/state/hotStateStores.sqlite.test.ts` | 24 |
| `src/instrumentation.test.ts` | 43 |
| `src/runtime-host/deploymentHealth.test.ts` | 18 |
| `src/runtime-host/deploymentAdapter.test.ts` | 18 |
| `src/runtime-host/deploymentHotState.test.ts` | 15 |
| `scripts/runtime-host-viewer-adapter.test.ts` | 28 |
| `src/runtime-host/hostBootstrap.test.ts` | 13 |
| `src/runtime-host/hostSuccessor.test.ts` | 36 |

## File manifest

The complete implementation and test scope relative to the base is:

- `scripts/runtime-host-viewer-adapter.ts`
- `scripts/verify-packaged-startup.py`
- `src/lib/flows/store.ts`
- `src/lib/pipelines/store.ts`
- `src/lib/runtime/fixtures/packagedExternalWorker.py`
- `src/lib/runtime/fixtures/packagedProvider.py`
- `src/lib/runtime/fixtures/packagedRollback.ts`
- `src/lib/runtime/fixtures/packagedStartupSeed.ts`
- `src/lib/runtime/startup.ts`
- `src/lib/runtime/startupFinalization.integration.test.ts`
- `src/lib/runtime/startupWork.ts`
- `src/lib/runtime/structuredDeliveryController.ts`
- `src/lib/runtime/structuredDeliveryQueue.ts`
- `src/lib/runtime/structuredDeliveryRebind.test.ts`
- `src/lib/runtime/structuredSpawn.terminalize.test.ts`
- `src/lib/runtime/structuredSpawn.ts`
- `src/lib/state/hotStateAuthority.ts`
- `src/lib/state/hotStateStores.sqlite.test.ts`
- `src/lib/state/sqliteStateStore.ts`
- `src/lib/viewerInstrumentation.ts`
- `src/lib/workflows/store.ts`
- `src/runtime-host/deploymentAdapter.ts`
- `src/runtime-host/deploymentHealth.test.ts`
- `src/runtime-host/deploymentHealth.ts`
- `src/runtime-host/deploymentHotState.ts`

This evidence document is the remaining documentation-only addition. Local raw logs, provider input comparisons, immutable standalone package, and source digests are retained under `.artifacts/startup-recovery/`; the per-run directories are recorded in the packaged logs. Private paths and live identities are excluded from this document.
