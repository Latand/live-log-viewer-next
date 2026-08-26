"use client";

import { useMemo } from "react";

import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { AgentControlStrip } from "../AgentControlStrip";
import { LogFeed } from "../LogFeed";
import { MandateSeatProvider } from "../feed/mandateSeat";
import { DeadHostBanner } from "../runtime/DeadHostBanner";
import { TmuxComposer } from "../TmuxComposer";
import { useAgentCapabilities } from "../useAgentCapabilities";

const noop = () => undefined;

/**
 * The orchestrator's REAL conversation, in the dock column (PRD #976 decision 2:
 * `LogFeed` + `TmuxComposer`, never a bespoke chat renderer). Composed exactly
 * as `BranchPane` composes them — the same feed, the same control strip, the
 * same dead-host recovery, the same composer — so a message typed here takes
 * the composer's ordinary delivery path and a dead conversation is RESUMED by
 * that machinery rather than replaced by a second spawn.
 *
 * `primaryPlace` is what makes the dock the composer's home: the same
 * conversation also has a card on the board behind the panel, and the one
 * hoisted composer must render HERE while both are on screen.
 *
 * `promptVersion` is the seat's own record of what its mandate was based on —
 * a number for an approved default, null for a bespoke one. It travels to the
 * mandate card (#1166) so the dock's first row can name WHICH mandate created
 * this seat; the board's pane renders the same card without it.
 */
export function OrchestratorConversation({
  file,
  projectName,
  promptVersion,
}: {
  file: FileEntry;
  projectName: string;
  promptVersion?: number | null;
}) {
  const { t } = useLocale();
  const { caps } = useAgentCapabilities(file);
  const deadHost = caps.surface === "dead";
  const sendCap = caps.controls.send;
  const sendBlockedReason = !deadHost && sendCap.state === "disabled" ? t(sendCap.reason) : null;
  const seat = useMemo(() => ({ promptVersion }), [promptVersion]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-orchestrator-conversation={file.conversationId ?? file.path}>
      {deadHost ? <DeadHostBanner file={file} /> : null}
      <MandateSeatProvider value={seat}>
        <LogFeed
          file={file}
          showSvc={false}
          lineFilter=""
          onStatus={noop}
          paused={false}
          follow
          setFollow={noop}
          compact
        />
      </MandateSeatProvider>
      <AgentControlStrip file={file} />
      <TmuxComposer
        file={file}
        deadHost={deadHost}
        sendBlockedReason={sendBlockedReason}
        placeholder={t("composer.placeholderOrchestrator", { project: projectName })}
        primaryPlace
      />
    </div>
  );
}
