import { canonicalTranscriptTarget, readTranscriptHosts } from "@/lib/agent/transcriptHost";
import { applyConversationAction, CONVERSATION_ACTIONS } from "@/lib/conversation/actions";
import { deliverConversationMessage, reconfigureConversation } from "@/lib/delivery";
import { allowedKillTarget, consumeKillTarget } from "@/lib/resources";
import { completedFileScan } from "@/lib/scanner/scanCache";
import { dispatchStructuredControl } from "@/lib/runtime/structuredControls";
import {
  captureTmuxAttachReference,
  collectImagePayloads,
  killPane,
  panePidOf,
  resolveRequestedTmuxTarget,
  resolveTmuxAttach,
  tmuxEndpointDescriptor,
} from "@/lib/tmux";
import { recordDirectOperatorWakatimeActivity } from "@/lib/wakatime/operatorActivity";

export interface ConversationHostDependencies {
  canonicalTranscriptTarget: typeof canonicalTranscriptTarget;
  readTranscriptHosts: typeof readTranscriptHosts;
  applyConversationAction: typeof applyConversationAction;
  conversationActions: readonly string[];
  deliverConversationMessage: typeof deliverConversationMessage;
  reconfigureConversation: typeof reconfigureConversation;
  allowedKillTarget: typeof allowedKillTarget;
  consumeKillTarget: typeof consumeKillTarget;
  completedFileScan: typeof completedFileScan;
  dispatchStructuredControl: typeof dispatchStructuredControl;
  enqueueStructuredMessage: typeof import("@/lib/runtime/structuredMessageDelivery").enqueueStructuredMessage;
  captureTmuxAttachReference: typeof captureTmuxAttachReference;
  collectImagePayloads: typeof collectImagePayloads;
  killPane: typeof killPane;
  panePidOf: typeof panePidOf;
  resolveRequestedTmuxTarget: typeof resolveRequestedTmuxTarget;
  resolveTmuxAttach: typeof resolveTmuxAttach;
  tmuxEndpointDescriptor: typeof tmuxEndpointDescriptor;
  recordDirectOperatorWakatimeActivity: typeof recordDirectOperatorWakatimeActivity;
}

const productionDependencies: ConversationHostDependencies = {
  canonicalTranscriptTarget,
  readTranscriptHosts,
  applyConversationAction,
  conversationActions: CONVERSATION_ACTIONS,
  deliverConversationMessage,
  reconfigureConversation,
  allowedKillTarget,
  consumeKillTarget,
  completedFileScan,
  dispatchStructuredControl,
  enqueueStructuredMessage: async (...args) => {
    const { enqueueStructuredMessage } = await import("@/lib/runtime/structuredMessageDelivery");
    return enqueueStructuredMessage(...args);
  },
  captureTmuxAttachReference,
  collectImagePayloads,
  killPane,
  panePidOf,
  resolveRequestedTmuxTarget,
  resolveTmuxAttach,
  tmuxEndpointDescriptor,
  recordDirectOperatorWakatimeActivity,
};

let testDependencies: Partial<ConversationHostDependencies> | null = null;

export function conversationHostDependencies(): ConversationHostDependencies {
  return testDependencies === null
    ? productionDependencies
    : { ...productionDependencies, ...testDependencies };
}

export function setConversationHostDependenciesForTests(
  dependencies: Partial<ConversationHostDependencies> | null,
): void {
  testDependencies = dependencies;
}
