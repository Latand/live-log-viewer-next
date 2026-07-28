"use client";

import { useEffect, useSyncExternalStore } from "react";

import { TmuxComposerCore } from "@/components/TmuxComposer";
import {
  getActiveCall,
  getServerActiveCall,
  subscribeActiveCall,
} from "@/lib/realtime/activeCall";

import {
  announceVoiceComposerHost,
  getServerVoiceSlotsVersion,
  getVoiceComposerCardIds,
  getVoiceComposerCardNode,
  getVoiceComposerCardProps,
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
 * - the card leaves while its conversation has (or last had) the call → the
 *   composer parks hidden, still mounted: the recording keeps recording, object
 *   URLs stay valid, the outbox keeps draining, and the PiP window — whose
 *   composer slot the form's `ComposerBar` portals into independently — keeps
 *   its fully working composer;
 * - the card leaves with no call on that conversation → the composer unmounts,
 *   exactly as a card-scoped one always did (the draft survives in
 *   sessionStorage either way).
 *
 * Cards only defer to this host while one is mounted (`announceVoiceComposerHost`),
 * so isolated trees — component tests, the demo renderer — keep today's inline
 * composer without knowing this component exists.
 */
export function VoiceComposerHost() {
  /* One subscription for the whole registry: places, props and host presence all
     notify through it, and the version number is the stable snapshot. */
  useSyncExternalStore(subscribeVoiceSlots, getVoiceSlotsVersion, getServerVoiceSlotsVersion);
  const activeCall = useSyncExternalStore(subscribeActiveCall, getActiveCall, getServerActiveCall);

  useEffect(() => announceVoiceComposerHost(), []);

  /* Every conversation with a card on screen, plus the one whose call outlives
     its card (`activeCall` retains the last call's conversation on purpose). */
  const conversationIds = new Set(getVoiceComposerCardIds());
  if (activeCall) conversationIds.add(activeCall.conversationId);

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
