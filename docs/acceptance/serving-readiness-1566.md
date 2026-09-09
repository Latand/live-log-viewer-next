# Serving readiness repair (#1566)

The production deployment of `5978075a8db59a9c5f7697a54f190d30ab86024a`
rolled back after adoption was ready. The trusted local gateway adds the
release credential to loopback-addressed requests. The old verifier expected
its unauthenticated stable-listener request to receive 403; that request received
200. The direct Viewer correctly refused it with 403. The phase text only
reported adoption, concealing the failed HTTP gate. The earlier standalone
qualification had no token or trusted gateway and missed this configuration.

The rejection probe now uses an untrusted Host value through the same listener.
The gateway's existing DNS-rebinding boundary leaves that request unauthenticated,
and the actual Viewer gate returns 403. Successful probes still use the normal
listener and the release credential. Progress includes the failed health gate.

Promoted serving verification has no fixed total deadline in either the
readiness loop or the host command adapter. HTTP probes and Docker inspection
have 5-second bounds; MCP probes retain their existing bound. Transient probe
failures remain pending. Positive candidate exit or disappearance ends the wait.
The single-deployment status response includes `servingProgress` while waiting.

`DELETE /api/runtime/deployments/<deploymentId>` explicitly cancels a deployment
in `post-promotion-health`. It records cancellation intent, interrupts and joins
the verifier process, and lets the coordinator perform its existing rollback.
The phase remains nonterminal until that cleanup settles. Cancellation is
idempotent and survives coordinator recovery. Cross-origin requests are refused.

## Production timing

Durations below come from durable deployment events. Adoption phases were sampled
by the host's phase logger, so their intervals are approximate and are not CPU
profiles.

| Phase | Duration |
| --- | ---: |
| Admission to building | 0.008 s |
| Building, dependency/MCP staging and source cleanup | 154.565 s |
| Starting candidate | 0.537 s |
| Candidate health, including runtime-host rehearsal | 23.803 s |
| Promotion and activation handover | 5.351 s |
| Post-promotion serving verification | 120.048 s |
| Rollback | 4.754 s |

Total request-to-terminal time was 309.065 seconds (event-record rounding differs
by one millisecond). MCP staging was recorded at 07:37:08.839 UTC, HTTP precheck at
07:37:44.849, runtime rehearsal at 07:37:50.633, activation publication at
07:38:08.194, and target restoration at 07:40:16.771.

The phase logger first saw transcript refresh at 07:38:24.141, adoption of two
hosts at 07:38:29.141, historical fallback publication at 07:38:49.794, pending
spawn recovery at 07:39:25.080, and ready at 07:39:40.081. Readiness was therefore
observed about 92 seconds after activation and over 33 seconds before the outer
timeout. Waiting longer could never satisfy the old authentication assertion.

Precheck runs against a passive candidate: it proves HTTP/assets/MCP and rehearses
a separate private runtime host. Structured recovery starts only after the target
flip grants ownership. Transcript refresh, adoption, historical publication and
pending-spawn recovery were deferred until promotion. Root/assets/capability and
MCP checks are repeated intentionally through the stable listener after promotion.
The runtime-host rehearsal is not repeated by `verify-promoted`.

Acceleration priorities from the available measurements:

1. Remove the impossible authentication assertion: at least 33 seconds of waiting
   after observed readiness, plus rollback, were wasted in this attempt.
2. Profile the 154.565-second build/staging bucket before optimizing it. The code
   builds MCP in the image and then installs dependencies/builds MCP again for
   host staging. Reusing the built artifact is a concrete candidate, but this
   ledger cannot isolate its savings. The 34.733 seconds after the MCP staging
   timestamp also include durable publication and source cleanup; they cannot
   be attributed entirely to compilation or fsync. Retired image/container
   artifacts were already absent, preventing a finer retrospective breakdown.
3. Historical publication occupied about 35.3 seconds between sampled phase
   transitions. The journal records 1,192 session-status events in that window
   across the two provider producer kinds. Investigate unchanged-history
   suppression or batching while preserving current evidence; those counts
   include concurrent producers and are not a candidate-only CPU profile.
4. Pending-spawn recovery occupied about 15 seconds between sampled transitions;
   preserve fresh operation evidence while investigating repeated reads.

No speculative acceleration changes are included in this repair.

## Executable evidence and shipping boundary

- Real TCP gateway regression: old request received 200 instead of 403; repaired
  request receives 403 while credentialed requests remain 200.
- Readiness reaches success after 900 seconds of simulated waiting; cancellation,
  candidate exit and transient-inspection behavior are separate checks.
- The actual frozen `bdf4b85658802c2e1765382c5aef04a6585980a7` command adapter and
  repaired adapter ran the same 125-second serving fixture concurrently. The old
  adapter failed at 120.023 seconds; the repaired adapter passed at 125.015 seconds.
  The fixture proves the outer-process deadline, not application startup latency.
- Real frozen predecessor runtime host to repaired successor: takeover 504 ms;
  listener and socket each answered 27/27 probes over 15 seconds.
- Cancellation through the real Unix client/server and HTTP route remains
  nonterminal until the verifier settles, then follows rollback. A separate
  executable test proves cancellation removes the verifier process group.
- Read-only production checks found restored Viewer/MCP revision `88e5a950` and
  runtime-host revision `bdf4b856`. Five current structured registrations had live
  processes with matching start identities. The Viewer reported four startup
  adoptions ready. This is a current observation, not a complete before/after
  proof for every live conversation; retained synthetic preservation evidence
  remains in the predecessor acceptance document.

A candidate-only API deployment cannot change the old host's loaded timeout or
probe implementation: host succession is downstream of promoted verification.
There is no host-first bootstrap operation in the current Viewer API.

Root must resolve the API-only mandate boundary before using the existing host
bootstrap CLI. From a checkout of the reviewed shipping revision, with the real
operator environment, first render the plan (no lifecycle mutation):

```sh
bun scripts/bootstrap-runtime-host.ts "$SHIP_SHA"
```

After root authorizes the named predecessor handover:

```sh
bun scripts/bootstrap-runtime-host.ts "$SHIP_SHA" --hand-over
```

`--hand-over` builds/stages the successor before stopping the one predecessor
named in the plan. Optional `--stage` builds/stages without stopping it. The
bootstrap preserves Viewer containers and their engine processes. Confirm the
new host owns both endpoints, then root calls `deploy_exact_sha` with the full
merged SHA and one stable request ID. Poll that deployment to terminal success
and verify matching Viewer/MCP/runtime identities and conversation preservation.
No production bootstrap or deployment was performed by this worker. The prior
rollback-compatibility finding remains a known follow-up.
