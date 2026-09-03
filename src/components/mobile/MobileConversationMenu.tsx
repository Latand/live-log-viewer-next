"use client";

import { ArrowRightLeft, Bot, Boxes, ChevronRight, CornerDownRight, Crown, FoldVertical, Info, ListTree, PencilLine, RotateCw, Search, Square, SquareTerminal, X } from "lucide-react";

import { useLocale } from "@/lib/i18n";
import { cleanTitle } from "@/lib/title";
import type { FileEntry } from "@/lib/types";

import { AttachTerminalDialog } from "../AttachTerminalDialog";
import { canHandoff } from "../HandoffHandle";
import { useAgentControlActions } from "../AgentControlStrip";
import { useProcessKill } from "../TaskHeader";
import { effortTitle, engineBadge } from "../utils";
import { MobileMeter } from "./MobileMeter";
import { MobileSheet, MobileSheetDivider, MobileSheetRow } from "./MobileSheet";
import { showReceipt } from "./MobileReceipt";
import { chatStateBits, type StagePosition } from "./mobileChatState";

/*
 * The conversation's `⋯` (docs/design/mobile-v2/README.md §4.2, §8 row 3).
 *
 * It holds every former pane-header control as a LABELLED row — the 2026-08
 * audit's finding 18 is that an icon-only control has no touch route to its
 * meaning, and the phone's answer is that every control is a row in a sheet or
 * one of the bar's four icons. The first group holds the two rows that name
 * something OTHER than this conversation, when they apply (§4.2): «Orchestrator
 * seat» on the seat's own conversation, and the pipeline row on a stage (P2-9:
 * a stage conversation could not reach its own pipeline at all). Then the
 * identity actions, then a separator, then the two destructive rows: Close
 * card, and Kill agent in danger colour with a hint saying what it will stop.
 *
 * No row asks for confirmation (§2 rule 9, Q4). Close answers with a receipt
 * carrying Reopen; Kill answers with a receipt naming what it stopped once the
 * host has ACCEPTED it — a refusal answers on the sheet, which stays open so
 * the escalation it unlocked is one tap away. Respawn is the composer's send
 * slot, which lane 5 owns.
 *
 * The actions themselves are not reimplemented here: Stop, Compact, Re-check
 * and Open in terminal come from `useAgentControlActions`, and Kill from
 * `useProcessKill`, the same hooks the desktop strip and the pane header read.
 */
export function MobileConversationMenu({
  file,
  stage,
  pipelineCount = 0,
  crowned,
  hostTaskCount,
  onOpenSeat,
  onOpenPipeline,
  onRename,
  onToggleCrown,
  onHandoff,
  onOpenHost,
  onOpenSearch,
  onOpenProjectMenu,
  projectName,
  onCloseCard,
  onReopen,
  onClose,
}: {
  file: FileEntry;
  /** Where this conversation sits in its pipeline, when it is a stage. */
  stage: StagePosition | null;
  /** Active pipelines on the board, for the generic first row when this
      conversation is not a stage of any of them. */
  pipelineCount?: number;
  crowned: boolean;
  /** Background tasks behind «Details & host», as the row's trailing count. */
  hostTaskCount: number;
  /** Opens the seat sheet over this screen (§4.5). Present only on the
      conversation that HOLDS the project's orchestrator seat, which is the
      only place §4.2 puts this row — and, with the pinned row gone from the
      conversation screen, the only route the seat has left here. */
  onOpenSeat?: () => void;
  onOpenPipeline?: () => void;
  onRename: () => void;
  onToggleCrown?: () => void;
  /** Drops a draft that continues this conversation (§4.2 «Hand off»). The
      board owns the draft, so the row only asks for it. */
  onHandoff?: () => void;
  onOpenHost: () => void;
  /** The search palette (#1054): a bar target on the board, a row here (§3.1). */
  onOpenSearch?: () => void;
  /** Swaps this sheet for the project's own menu. Every screen's `⋯` opens the
      board menu over it (§3.3), and on this screen the `⋯` is the
      conversation's — so the project's rows are one row down rather than a
      screen back. */
  onOpenProjectMenu?: () => void;
  projectName: string;
  onCloseCard?: () => void;
  /** The inverse of Close card: the receipt's «Reopen». */
  onReopen?: () => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const actions = useAgentControlActions(file);
  const kill = useProcessKill(file);
  const bits = chatStateBits(t, file);
  const badge = engineBadge(file);
  const controls = actions.caps.controls;
  const title = cleanTitle(file.title, 90);
  /* The meter fills with what REMAINS (§5); an unmeasurable window shows none. */
  const ctxLeft = file.ctx && file.ctx.pct !== null ? Math.max(0, 100 - file.ctx.pct) : null;
  const killHint = bits.key === "stalled"
    ? t("mobile2.chat.killStalled")
    : bits.key === "working"
      ? t("mobile2.chat.killRunning")
      : t("mobile2.chat.killIdle");
  const act = (run: () => void) => () => {
    onClose();
    run();
  };
  /* A row that TALKS TO A HOST answers with what actually came back. Closing
     the sheet first threw the answer away: the status line below is inside
     this sheet, and `useProcessKill`'s state unmounts with it — so a refused
     SIGTERM still rendered «Killed …» and dropped the SIGKILL that same
     refusal had just unlocked. Now the request is awaited with the sheet
     open, and only a request the host ACCEPTED closes it and shows the
     receipt; a refusal or a dead transport leaves the sheet standing with the
     failure on it. The tap is still the whole gesture — nothing here asks for
     confirmation (§2 rule 9, Q4), and nothing here is asked twice: every one
     of these rows is disabled while its request is in flight. */
  const answered = (run: () => Promise<boolean>, accepted: () => void) => () => {
    void run().then((ok) => {
      if (!ok) return;
      onClose();
      accepted();
    });
  };
  const showPipelineRow = Boolean(onOpenPipeline) && (stage !== null || pipelineCount > 0);
  return (
    <>
      <MobileSheet name="menu" title={title} onClose={onClose}>
        {/* What the folded pane-header chips used to say, in one quiet block:
            the model and its reasoning tier, and the context that remains. The
            worktree, the account and the pipeline live one row down, in
            «Details & host». */}
        <div className="flex min-h-9 items-center gap-2 px-4 pb-1 text-label font-medium text-secondary" data-mobile2-chat-identity>
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${bits.tone === "success" ? "bg-success" : bits.tone === "warning" ? "bg-warning" : bits.tone === "danger" ? "bg-danger" : bits.tone === "accent" ? "bg-accent" : "bg-strong"}`} aria-hidden />
          <span className="shrink-0">{bits.phrase}</span>
          <span aria-hidden className="text-muted">·</span>
          <span className="min-w-0 truncate" title={effortTitle(file)}>
            {file.model ? (file.effort ? t("mobile2.chat.identity", { model: file.model, effort: file.effort }) : file.model) : badge.label}
          </span>
          {ctxLeft === null ? null : <MobileMeter left={ctxLeft} label={t("mobile2.meter.left", { left: ctxLeft })} className="ml-auto w-16 shrink-0" />}
        </div>
        <div role="menu" aria-label={title} className="flex flex-col">
          {/* The seat row (§4.2, §4.5): the seat's own conversation is where an
              operator asks what the orchestrator is holding, and the phone's
              pinned row — which used to carry the ⚙ — is gone with the strip,
              so this row is the whole route to the seat's status, mandate and
              rotation from here. */}
          {onOpenSeat ? (
            <MobileSheetRow
              icon={<Bot className="h-[18px] w-[18px]" aria-hidden />}
              label={t("mobile2.chat.menuSeat")}
              trailing={<ChevronRight className="h-4 w-4" aria-hidden />}
              onSelect={act(onOpenSeat)}
              testId="mobile-menu-seat"
              attrs={{ "data-mobile2-menu-row": "seat" }}
            />
          ) : null}
          {/* The pipeline row is the first group's other member (P2-9): a stage
              conversation could not reach its own pipeline at all before. When
              the conversation is not a stage, the same slot carries the board's
              active pipelines, so the plan a phone operator came for never
              becomes unreachable while the pipelines screen (lane 7) is still
              to come. */}
          {showPipelineRow && onOpenPipeline ? (
            <MobileSheetRow
              icon={<ListTree className="h-[18px] w-[18px]" aria-hidden />}
              label={stage ? (
                <span className="flex min-w-0 flex-col">
                  <span className="min-w-0 truncate">{t("mobile2.chat.menuPipeline", { task: cleanTitle(stage.pipeline.task, 60) })}</span>
                  <span className="min-w-0 truncate text-label font-medium text-secondary">
                    {t("mobile2.chat.menuPipelineMeta", { k: stage.k, n: stage.n, stage: stage.stage.id, state: t(`pipelineChipState.${stage.state}`) })}
                  </span>
                </span>
              ) : t("mobile2.chat.menuPipelines", { count: pipelineCount })}
              onSelect={act(onOpenPipeline)}
              testId="mobile-menu-pipeline"
              attrs={{ "data-mobile2-menu-row": "pipeline" }}
            />
          ) : null}
          {onOpenSeat || showPipelineRow ? <MobileSheetDivider /> : null}
          <MobileSheetRow
            icon={<PencilLine className="h-[18px] w-[18px]" aria-hidden />}
            label={t("mobile2.chat.menuRename")}
            disabled={!file.renamable}
            onSelect={act(onRename)}
            testId="mobile-menu-rename"
            attrs={{ "data-mobile2-menu-row": "rename" }}
          />
          {onToggleCrown ? (
            <MobileSheetRow
              icon={<Crown className={`h-[18px] w-[18px] ${crowned ? "fill-crown text-crown" : ""}`} aria-hidden />}
              label={crowned ? t("mobile2.chat.menuUncrown") : t("mobile2.chat.menuCrown")}
              onSelect={act(onToggleCrown)}
              attrs={{ "data-mobile2-menu-row": "crown" }}
            />
          ) : null}
          {onHandoff && canHandoff(file) ? (
            <MobileSheetRow
              icon={<ArrowRightLeft className="h-[18px] w-[18px]" aria-hidden />}
              label={t("mobile2.chat.menuHandoff")}
              onSelect={act(onHandoff)}
              attrs={{ "data-mobile2-menu-row": "handoff" }}
            />
          ) : null}
          {/* The supersedence chain (#383). On the desktop it is a chip in the
              pane header; the phone has no pane header, so the chain tail names
              its round here and opens the retired predecessor through the same
              durable `#c=` form the chip uses. */}
          {file.continues ? (
            <MobileSheetRow
              icon={<CornerDownRight className="h-[18px] w-[18px]" aria-hidden />}
              label={t("mobile2.chat.menuPredecessor", { round: file.continues.round })}
              trailing={<ChevronRight className="h-4 w-4" aria-hidden />}
              onSelect={act(() => {
                window.location.hash = "#c=" + encodeURIComponent(file.continues!.conversationId);
              })}
              testId="mobile-menu-predecessor"
              attrs={{ "data-mobile2-menu-row": "predecessor", "data-continues-conversation": file.continues.conversationId }}
            />
          ) : null}
          {/* Stop lives here until lane 5 makes it the composer's send slot
              (§2 rule 8); dropping it in between would leave a working agent
              unstoppable on the phone. */}
          {controls.stop.state === "hidden" ? null : (
            <MobileSheetRow
              icon={<Square className="h-[18px] w-[18px]" fill="currentColor" aria-hidden />}
              label={t("mobile2.chat.menuStop")}
              disabled={controls.stop.state === "disabled" || actions.stopBusy}
              trailing={controls.stop.state === "disabled" ? t(controls.stop.reason) : undefined}
              /* Stop and Compact answer on the status line below, which is
                 why it lives in this sheet: the sheet stays open until the
                 interrupt — or the refusal — is back from the host. */
              onSelect={actions.stop}
              attrs={{ "data-mobile2-menu-row": "stop" }}
            />
          )}
          {controls.compact.state === "hidden" ? null : (
            <MobileSheetRow
              icon={<FoldVertical className="h-[18px] w-[18px]" aria-hidden />}
              label={t("mobile2.chat.menuCompact")}
              disabled={controls.compact.state === "disabled" || actions.compactBusy}
              trailing={ctxLeft !== null ? t("mobile2.meter.left", { left: ctxLeft }) : controls.compact.state === "disabled" ? t(controls.compact.reason) : undefined}
              onSelect={() => actions.compact({ immediate: true })}
              attrs={{ "data-mobile2-menu-row": "compact" }}
            />
          )}
          <MobileSheetRow
            icon={<Info className="h-[18px] w-[18px]" aria-hidden />}
            label={t("mobile2.chat.menuDetails")}
            /* Only when this screen was told the count. The conversation screen
               is mounted inside the board's shell, which owns the background
               processes; a screen that has not been handed the number says
               nothing rather than claiming zero, and the board's own host row —
               one row down, behind «Project · …» — still carries it. */
            trailing={hostTaskCount ? t("mobile2.menu.hostTasks", { count: hostTaskCount }) : undefined}
            onSelect={act(onOpenHost)}
            attrs={{ "data-mobile2-open": "host", "data-mobile2-menu-row": "host" }}
          />
          {controls.terminal.state === "hidden" ? null : (
            <MobileSheetRow
              icon={<SquareTerminal className="h-[18px] w-[18px]" aria-hidden />}
              label={t("mobile2.chat.menuTerminal")}
              disabled={controls.terminal.state === "disabled"}
              onSelect={actions.terminal}
              attrs={{ "data-mobile2-menu-row": "terminal" }}
            />
          )}
          <MobileSheetRow
            icon={<RotateCw className="h-[18px] w-[18px]" aria-hidden />}
            label={t("mobile2.chat.menuRecheck")}
            disabled={actions.recheckBusy}
            onSelect={actions.recheck}
            attrs={{ "data-mobile2-menu-row": "recheck" }}
          />
          {onOpenSearch ? (
            <MobileSheetRow
              icon={<Search className="h-[18px] w-[18px]" aria-hidden />}
              label={t("mobile2.bar.search")}
              onSelect={act(onOpenSearch)}
              attrs={{ "data-mobile2-open": "search", "data-mobile2-menu-row": "search" }}
            />
          ) : null}
          {onOpenProjectMenu ? (
            <MobileSheetRow
              icon={<Boxes className="h-[18px] w-[18px]" aria-hidden />}
              label={t("mobile2.chat.menuProject", { name: projectName })}
              trailing={<ChevronRight className="h-4 w-4" aria-hidden />}
              onSelect={onOpenProjectMenu}
              attrs={{ "data-mobile2-menu-row": "project" }}
            />
          ) : null}
          {actions.status ? (
            <span
              role="status"
              data-mobile2-menu-status={actions.status.kind}
              className={`px-4 pb-1 text-label font-semibold ${actions.status.kind === "err" ? "text-danger" : "text-secondary"}`}
            >
              {actions.status.text}
            </span>
          ) : null}
          <MobileSheetDivider />
          {onCloseCard ? (
            <MobileSheetRow
              icon={<X className="h-[18px] w-[18px]" aria-hidden />}
              label={t("mobile2.chat.menuClose")}
              trailing={t("mobile2.chat.menuCloseHint")}
              onSelect={act(() => {
                onCloseCard();
                showReceipt(t("mobile2.chat.closed", { title }), onReopen ? { kind: "reopen", run: onReopen } : null);
              })}
              testId="mobile-menu-close"
              attrs={{ "data-mobile2-menu-row": "close" }}
            />
          ) : null}
          {kill.state === "hidden" ? null : (
            <MobileSheetRow
              icon={<Square className="h-[18px] w-[18px]" aria-hidden />}
              label={t("mobile2.chat.menuKill")}
              danger
              disabled={kill.state === "disabled" || kill.busy}
              /* A SIGTERM the host refused unlocks the escalation, and the row
                 names it — the same word the desktop's armed button flips to —
                 instead of repeating the hint of an attempt that has already
                 failed. */
              trailing={kill.state === "disabled" ? kill.reason : kill.force ? "SIGKILL" : killHint}
              onSelect={answered(kill.kill, () => showReceipt(t("mobile2.chat.killed", { title })))}
              testId="mobile-menu-kill"
              attrs={{ "data-mobile2-menu-row": "kill" }}
            />
          )}
          {/* Only a kill that was NOT accepted is still on screen to say so:
              an accepted one has closed this sheet for its receipt. */}
          {kill.message ? (
            <span role="status" data-mobile2-kill-status className="px-4 pb-1 text-label font-semibold text-danger">{kill.message}</span>
          ) : null}
        </div>
      </MobileSheet>
      {actions.attachOpen ? <AttachTerminalDialog file={file} mode={actions.attachMode} onClose={actions.closeAttach} /> : null}
    </>
  );
}
