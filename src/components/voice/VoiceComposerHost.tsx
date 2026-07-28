"use client";

import { useEffect, useSyncExternalStore } from "react";

import { TmuxComposerCore } from "@/components/TmuxComposer";
import {
  getLiveCall,
  getServerLiveCall,
  subscribeActiveCall,
} from "@/lib/realtime/activeCall";

import {
  announceVoiceComposerHost,
  forgetVoiceComposerCardProps,
  getServerVoiceSlotsVersion,
  getVoiceComposerCardIds,
  getVoiceComposerCardNode,
  getVoiceComposerCardProps,
  getVoiceComposerCardPropsIds,
  getVoiceSlotsVersion,
  subscribeVoiceSlots,
} from "./voiceSlots";

/**
 * The Viewer-level owner of every conversation card's composer (#691 hoist).
 *
 * The operator's decided requirement: the composer of a call must stay ALIVE and
 * fully functional — dictation, attachments and their object URLs, draft, outbox,
 * receipts, send — while the operator moves between projects and the source card
 * unmounts. A card-scoped `useComposer` cannot promise that, so the machinery is
 * rendered HERE, beside `VoicePipHost` (the panel's owner), and only its FORM is
 * portalled into the place the card publishes. The card and the PiP window are
 * presentation slots; this component owns the lifetimes.
 *
 * One instance per conversation, keyed by the stable card identity:
 * - a mounted card publishes its place and fresh props → the form renders there;
 * - the card leaves while a call is UP on its conversation → the composer parks
 *   hidden, still mounted: the recording keeps recording, object URLs stay valid,
 *   the outbox keeps draining, and the PiP window — whose composer slot the
 *   form's `ComposerBar` portals into independently — keeps its fully working
 *   composer;
 * - the card leaves with no call up on that conversation → the composer unmounts,
 *   exactly as a card-scoped one always did (the draft survives in
 *   sessionStorage either way).
 *
 * Liveness is read from `getLiveCall`, NOT from the retained `getActiveCall`.
 * The retained projection keeps naming the last conversation that had a call so
 * its ended transcript stays on screen — read here, that would park a hidden
 * composer for a call that finished hours ago and never release it.
 *
 * Cards only defer to this host while one is mounted (`announceVoiceComposerHost`),
 * so isolated trees — component tests, the demo renderer — keep today's inline
 * composer without knowing this component exists.
 */
export function VoiceComposerHost() {
  /* One subscription for the whole registry: places, props and host presence all
     notify through it, and the version number is the stable snapshot. */
  useSyncExternalStore(subscribeVoiceSlots, getVoiceSlotsVersion, getServerVoiceSlotsVersion);
  const liveCall = useSyncExternalStore(subscribeActiveCall, getLiveCall, getServerLiveCall);

  useEffect(() => announceVoiceComposerHost(), []);

  /* Every conversation with a card on screen, plus the one whose LIVE call
     outlives its card. */
  const conversationIds = new Set(getVoiceComposerCardIds());
  if (liveCall) conversationIds.add(liveCall.conversationId);

  /* The card's props are retained past its unmount on purpose — a parked composer
     needs something to render with — so nothing retracts them at the seam. This
     is where they stop being needed: a conversation this host no longer renders a
     composer for keeps no `FileEntry` snapshot alive. Runs after commit, so the
     render above always had the props it was about to use. */
  useEffect(() => {
    for (const cardId of getVoiceComposerCardPropsIds()) {
      if (!conversationIds.has(cardId)) forgetVoiceComposerCardProps(cardId);
    }
  });

  return (
    <>
      {[...conversationIds].map((cardId) => {
        const props = getVoiceComposerCardProps(cardId);
        /* A place published before its props lands here for one notify; the props
           publish (same commit) re-renders this host immediately after. */
        if (!props) return null;
        return (
          <TmuxComposerCore
            key={cardId}
            file={props.file}
            pollPaused={props.pollPaused}
            deadHost={props.deadHost}
            sendBlockedReason={props.sendBlockedReason}
            dockNode={getVoiceComposerCardNode(cardId)}
          />
        );
      })}
    </>
  );
}
