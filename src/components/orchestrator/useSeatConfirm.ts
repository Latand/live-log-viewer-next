"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { AgentLaunchDraft, LaunchDraftStorage } from "@/components/draft/AgentLaunchControls";
import { applySpawnedConversationSnapshot } from "@/hooks/useFiles";
import { requestFilesRefresh } from "@/lib/filesEvents";
import { useLocale } from "@/lib/i18n";
import { derivedSpawnTitle } from "@/lib/title";

import {
  classifySpawnResponse,
  createSpawnAttempt,
  provisionalSpawnFile,
  type SpawnResponseBody,
} from "../draftSpawn";
import {
  classifySeatFailure,
  newSeatRequestId,
  seatRequestSettled,
  type OrchestratorSeatStatus,
  type SeatSubmitFailure,
} from "./seatState";

/**
 * ONE durable confirm, for both of the panel's designation flows (PRD #976).
 *
 * Create (`POST /api/orchestrator/seat`) and rotate (`POST
 * /api/orchestrator/rotate`) are the same promise in two places: exactly one
 * designation per submission, no matter how the reply goes. Both routes complete
 * an ALREADY-COMPLETED intent when their key is replayed, which is what makes a
 * retry converge instead of designating — or rotating — twice. That discipline
 * lives here, once, so the two flows cannot drift apart:
 *
 *  - ONE `clientRequestId` per submission, minted on the first confirm and
 *    PERSISTED, so a double-click, a reload mid-POST and an ambiguous retry all
 *    land on the same durable intent.
 *  - A TERMINAL refusal releases the key: the server recorded that intent as
 *    failed, and replaying it would re-deliver the ORIGINAL mandate rather than
 *    the corrected one.
 *  - An AMBIGUOUS failure (transport loss, opaque 5xx) KEEPS it: a worker may
 *    exist, so the retry replays and converges.
 *  - A SUCCESSFUL reply keeps it too. «Accepted» is not «the seat moved»: until
 *    the durable read shows where it landed, a Confirm pressed again from the
 *    same still-open draft has to replay, not designate a second time.
 *  - A kept key is released the moment the durable read says where it landed —
 *    held longer it becomes a trap, because a replay of a completed intent is
 *    answered with the old seat and creates nothing at all.
 */

/** The launch parameters a provisional card needs while the transcript catches
    up. Everything else about the request is the caller's own body. */
export interface SeatConfirmLaunch {
  draft: AgentLaunchDraft;
  cwd: string;
  /** The text delivered as the first message, for the optimistic bubble. */
  firstMessage: string;
}

export interface SeatConfirmFlow {
  submitting: boolean;
  failure: SeatSubmitFailure | null;
  /**
   * Post the confirm. `body` is everything but `clientRequestId`, which this
   * flow owns; `replayRequestId` re-posts an EXISTING durable intent by its own
   * key, which completes that intent with ITS original mandate.
   */
  submit: (input: { body: Record<string, unknown>; launch: SeatConfirmLaunch }, replayRequestId?: string | null) => Promise<void>;
}

export function useSeatConfirm(options: {
  /** The confirm route: the seat route, or the rotate route. */
  url: string;
  project: string;
  /** Where this flow's unsettled key is kept, keyed apart from the other's.
      STABLE across renders — it is a dependency of the submit callback. */
  storage: LaunchDraftStorage;
  /** The field name inside that storage holding the unsettled key. */
  field: string;
  status: OrchestratorSeatStatus | null;
  refresh: () => Promise<void>;
}): SeatConfirmFlow {
  const { url, project, storage, field, status, refresh } = options;
  const { t } = useLocale();
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<SeatSubmitFailure | null>(null);
  /* The guard has to be SYNCHRONOUS: two clicks in one event batch both read
     the same render's `submitting`, so a state flag alone lets the second one
     through. The route would still converge them onto one designation (same
     key), but the second reply would land as a spurious in-progress error over
     a perfectly good confirm. */
  const inFlight = useRef(false);

  /* A key kept through an unknown outcome is released the moment the seat read
     says where it landed. (The stale banner from that same submission is retired
     in the derivation, which needs no state of its own.) */
  useEffect(() => {
    if (inFlight.current) return;
    const stored = storage.read(field);
    if (stored && seatRequestSettled(status, stored)) storage.write(field, "");
  }, [storage, field, status]);

  const submit = useCallback(async (
    input: { body: Record<string, unknown>; launch: SeatConfirmLaunch },
    replayRequestId?: string | null,
  ) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const stored = replayRequestId || storage.read(field);
    const clientRequestId = stored || newSeatRequestId();
    if (storage.read(field) !== clientRequestId) storage.write(field, clientRequestId);
    setSubmitting(true);
    setFailure(null);
    const at = Date.now();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input.body, clientRequestId }),
      });
      const body = (await response.json().catch(() => null)) as (SpawnResponseBody & { code?: string }) | null;
      if (response.ok && body?.ok !== false) {
        /* The key is NOT released here. A reply that says «done» stops short of
           saying WHERE it landed; the durable read is what says so, and the
           effect above releases the key the moment it does. Releasing it here
           left a window: the refresh below can fail or answer stale, the draft
           it was submitted from stays open on the old incumbent, and the next
           Confirm mints a FRESH key — which is a second designation, or a
           second rotation. Held, that same Confirm replays this key and the
           seat command converges it onto the one intent. */

        /* Instant attach (issue #919's path): the receipt already names the
           durable conversation, so the panel opens the live window now instead
           of waiting a poll for the files feed to catch up. */
        const outcome = classifySpawnResponse(response.status, response.ok, body);
        if (outcome.kind === "launched") {
          const { draft, cwd, firstMessage } = input.launch;
          const provisional = provisionalSpawnFile(
            createSpawnAttempt(clientRequestId, at, {
              title: derivedSpawnTitle("orchestrator", firstMessage, project),
              engine: draft.engine,
              model: draft.model,
              cwd,
              effort: draft.effort,
              fast: draft.engine === "codex" && draft.speed ? draft.speed === "fast" : null,
              accountId: draft.launchAccountId,
              ["prompt"]: firstMessage,
              images: [],
              src: "",
            }),
            outcome,
            project,
          );
          if (provisional) applySpawnedConversationSnapshot(provisional);
        }
        requestFilesRefresh();
      } else {
        const classified = classifySeatFailure(response.status, body, clientRequestId);
        /* A terminal refusal is durably recorded server-side; the next attempt
           carries a fresh key so an edited mandate is the one delivered. */
        if (classified?.kind === "terminal") storage.write(field, "");
        setFailure(classified);
      }
    } catch {
      /* Transport loss proves nothing: the designation may well have landed,
         so the key is KEPT and the retry replays onto the same receipt. */
      setFailure({ kind: "ambiguous", error: t("orchPanel.transportLost"), clientRequestId });
    } finally {
      inFlight.current = false;
      setSubmitting(false);
      await refresh();
    }
  }, [url, project, storage, field, refresh, t]);

  return { submitting, failure, submit };
}
