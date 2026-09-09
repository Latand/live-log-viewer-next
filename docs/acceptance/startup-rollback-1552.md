# Startup and rollback verification for #1552

## Incumbent compatibility follow-up

Status: **incomplete; deployment bootstrap remains blocked**. This follow-up
builds on `dcd5f0f12e90d84d4ad787f4da353e7723edaf56`. The retained independent
review identified two P1 compatibility failures against incumbent
`bdf4b85658802c2e1765382c5aef04a6585980a7`.

The candidate capability now reports `releaseReady: false` while its serving
structured startup is pending or failed, or its delivery controller is
unavailable. Passive candidate health and hot-state activation remain available.
The regression uses verbatim frozen incumbent consumers; the independent
packaged check also imports the complete original module from the frozen tree.
The original response failed this check; the repaired response passes.

The rollback defect remains unresolved. The frozen adapter writes a fence that
drops `activationOwner`, then starts its own checkpoints without waiting for
Viewer acknowledgement or positive owner death. The candidate's monitor and
the adapter therefore run concurrently. Candidate-only owner metadata cannot
make that older consumer wait. Keeping a startup lease until owned hosts finish
releasing would cover a subset of startup interleavings; it would not establish
an acknowledgement barrier for rollback after startup finishes or between
startup attempts. No such partial timing workaround was introduced.

The rehearsal now drives rollback through the isolated Viewer API and actual
incumbent host, coordinator and executable adapter. Before starting processes it
checks all incumbent source, scripts, launchers and configuration against the
pinned Git object. Supplying successor source is a tested rejection. The old
in-process coordinator fixture has been removed from the execution path.
Container/build/precheck/promotion setup remains a fixture. A deliberately slow
serving endpoint forces the incumbent's actual 120-second action timeout;
rollback retains its actual 90-second limit. This qualifies rollback behavior
and does not establish a complete successful deployment or host succession.

Fresh verification:

- 476 targeted tests passed: the previous 475 tests plus the capability
  regression below. Nonincremental TypeScript, standalone Viewer/MCP build and
  whole-diff privacy with commit/known-value checks passed. Separate runtime-host
  succession took 503 ms; both endpoints answered 27/27 probes over 15 seconds.
- Frozen-incumbent baseline API timeout: terminal failed at 129.111 seconds with
  `agent registry rollback mirror did not converge after 2 attempts`; candidate
  remained alive and the target was not restored. Six original provider inputs,
  pending keys/payloads and both external workers were preserved.
- Repaired candidate through the stable Viewer API: terminal failed at 127.641
  seconds with the same rollback convergence error; candidate exit and target
  restoration remain unproven. All six original inputs, pending key/payload,
  deferred spawn and both external workers were preserved; zero late historical
  publications or candidate mutations were observed. This remains a failing gate.
- Repaired packaged ordinary startup, no injected delay: ready at 53.461 seconds,
  six original sends delivered with exact provider matches, six hosted writers
  retained, pipeline creation passed, deferred spawn and both external workers
  preserved. Both actual verifier modules rejected all 145 pending samples and
  accepted the final ready sample. This measures startup, not deployment succession.
- The previous ordinary review measured 43.732 seconds. Both ordinary results fit
  the incumbent's 120-second limit. The historical 158.087-second run below includes
  an intentional 135-second hold and does not establish unavoidable startup time.

The fresh 2,568-file package manifest digest is
`e110db8ed152d878e2dc0d14d13a4e741564b9a511728510574ac4559548edc6`.

For incumbent rollback, export the pinned tree to a new directory, supply its
frozen dependencies, then run:

```sh
python3 scripts/verify-packaged-startup.py --viewer "$PACKAGE" \
  --runtime-source "$FROZEN_INCUMBENT" --bun "$BUN" --rollback
```

The runtime source must match the pinned incumbent. Keep the retained source,
packages and run evidence. A complete old-host to new-Viewer/runtime success
and forced-timeout rollback proof, followed by fresh independent review, are
still required before `DEPLOY_BOOTSTRAP_PROVEN` or release readiness.

Additional manifest entries:

- `src/app/api/runtime/deployments/capabilities/v1/route.ts`
- `src/app/api/runtime/deployments/capabilities/v1/route.test.ts` (one regression)
- `src/runtime-host/fixtures/incumbentDeploymentHealth.ts`
- `src/lib/runtime/fixtures/packagedIncumbentAdapter.py`

## Retained predecessor evidence

The following measurements describe the previous head and its successor-adapter
rehearsal. They do not qualify the frozen incumbent. The follow-up above supersedes
its bootstrap assessment.


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
