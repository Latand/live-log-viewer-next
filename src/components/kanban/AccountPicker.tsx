"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { accountIdFromPath } from "@/lib/accounts/badge";
import { conversationIdentity } from "@/lib/accounts/identity";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";
import { type AccountOption, useEngineAccounts } from "@/hooks/useEngineAccounts";
import { mobileRowState } from "@/components/mobile/mobileBoardModel";
import type { RuntimeSession } from "@/components/runtime/runtimeModel";
import { effectiveProfile } from "@/components/runtimeProfile";
import { useAgentCapabilities } from "@/components/useAgentCapabilities";

import { requestFilesRefresh } from "@/lib/filesEvents";

import {
  accountStanding,
  cancelSubject,
  ConversationCancels,
  ConversationSwitches,
  heldCancel,
  postSwitchCancel,
  switchCancelTarget,
  type CancelTarget,
  parseProjectPolicy,
  postConversationSwitch,
  StageAccounts,
  stageAccountKey,
  stagePin,
  switchView,
  type AccountEngine,
  type ProjectPolicy,
  type StageAccountOutcome,
  type SwitchSettlement,
  type SwitchView,
} from "./accountChoice";
import { ChevronDown } from "./kanbanGlyphs";
import { KanbanPopover } from "./kanbanMenus";
import type { ReceiptAction } from "./KanbanReceipts";
import type { PipelinePorts } from "./pipelinePorts";
import { stageDraftable } from "./stagesModel";

/*
 * The account chip and picker of the approved prototype (#1695 K6,
 * `accountChip` + `openAccountPicker`) on a waiting stage's header and on a
 * conversation's identity row. The board renders the picker itself, so it is
 * placed against the window and never clipped by a reader. What each choice
 * sends and what the board may claim about it is in `accountChoice.ts`.
 */

export type AccountTarget =
  | { kind: "stage"; pipelineId: string; stageId: string }
  | { kind: "conversation"; readerKey: string };

type Show = (text: string, action?: ReceiptAction, options?: { error?: boolean; ttl?: number }) => number;

export interface AccountChoice {
  stages: StageAccounts;
  switches: ConversationSwitches;
  open: (target: AccountTarget, anchor: HTMLElement) => void;
  policy: (project: string) => ProjectPolicy;
  loadPolicy: (project: string, fresh?: boolean) => void;
  chooseStage: (input: { pipelineId: string; stageId: string; stageName: string; account: string | null; labelOf: (id: string) => string }) => void;
  checkStage: (input: { pipelineId: string; stageId: string; stageName: string; labelOf: (id: string) => string }) => void;
  switchConversation: (input: { file: FileEntry; conversationId: string | null; target: string; targetLabel: string; name: string; working: boolean }) => void;
  settleSwitch: (key: string, settle: NonNullable<SwitchSettlement>, targetLabel: string, name: string) => void;
  cancels: ConversationCancels;
  /** Cancel a pending switch; with `then`, request that switch once the cancel is confirmed (Change). */
  cancelSwitch: (input: {
    file: FileEntry;
    conversationId: string;
    target: CancelTarget;
    /** The switch it cancels (`cancelSubject`). */
    subject: string;
    pendingLabel: string | null;
    name: string;
    then: { account: string; label: string; working: boolean } | null;
  }) => void;
}

export const AccountChoiceContext = createContext<AccountChoice | null>(null);

const noSubscribe = () => () => {};

/** The board's account choices: one instance, shared by every chip and picker. */
export function useAccountChoices(ports: PipelinePorts, show: Show, t: TFunction, open: (target: AccountTarget, anchor: HTMLElement) => void): AccountChoice {
  const stages = useMemo(() => new StageAccounts(), []);
  const switches = useMemo(() => new ConversationSwitches(), []);
  const cancels = useMemo(() => new ConversationCancels(), []);
  const [policies, setPolicies] = useState<ReadonlyMap<string, ProjectPolicy>>(() => new Map());
  const known = useRef(policies);
  known.current = policies;
  const loading = useRef(new Set<string>());
  const live = useRef({ ports, show, t, open });
  live.current = { ports, show, t, open };

  const loadPolicy = useCallback((project: string, fresh = false) => {
    if (!project || loading.current.has(project) || (!fresh && known.current.has(project))) return;
    loading.current.add(project);
    void fetch(`/api/account-project-bindings?project=${encodeURIComponent(project)}`, { cache: "no-store" })
      .then(async (response): Promise<ProjectPolicy> => (response.ok ? parseProjectPolicy(await response.json()) : { state: "unknown" }))
      .catch((): ProjectPolicy => ({ state: "unknown" }))
      .then((policy) => {
        loading.current.delete(project);
        setPolicies((current) => new Map(current).set(project, policy));
      });
  }, []);

  const policy = useCallback((project: string): ProjectPolicy => policies.get(project) ?? { state: "loading" }, [policies]);

  const reportStage = useCallback((outcome: StageAccountOutcome, input: { pipelineId: string; stageId: string; stageName: string; account: string | null; labelOf: (id: string) => string }, retry: () => void, check: () => void) => {
    const { show, t } = live.current;
    const stage = input.stageName;
    const accountName = (id: string | null) => (id ? input.labelOf(id) : t("kanban.account.projectChoice"));
    switch (outcome.kind) {
      case "saved":
        show(outcome.account ? t("kanban.account.receipt.stageSaved", { stage, account: accountName(outcome.account) }) : t("kanban.account.receipt.stageProject", { stage }));
        return;
      case "same":
        show(outcome.account ? t("kanban.account.receipt.stageSame", { stage, account: accountName(outcome.account) }) : t("kanban.account.receipt.stageProject", { stage }));
        return;
      case "unread":
        show(t("kanban.account.receipt.stageUnread", { stage }), { label: t("kanban.retry"), run: retry }, { error: true });
        return;
      case "missing":
        show(t("kanban.account.receipt.stageMissing", { stage }), undefined, { error: true });
        return;
      case "started":
        show(t("kanban.account.receipt.stageStarted", { stage }), undefined, { error: true });
        return;
      case "changed":
        show(t("kanban.account.receipt.stageChanged", { stage, account: accountName(outcome.account) }), undefined, { error: true });
        return;
      case "refused":
        show(t("kanban.account.receipt.stageRefused", { stage, error: outcome.error }), { label: t("kanban.retry"), run: retry }, { error: true });
        return;
      case "unknown":
        show(t("kanban.account.receipt.stageUnknown", { stage }), { label: t("kanban.pipelineAct.checkAgain"), run: check }, { error: true });
    }
  }, []);

  const checkStage = useCallback<AccountChoice["checkStage"]>((input) => {
    const key = stageAccountKey(input.pipelineId, input.stageId);
    const write = stages.get(key);
    if (!write) return;
    const again = () => checkStage(input);
    void stages.check(key, live.current.ports).then((outcome) => {
      if (!outcome) return;
      const { show, t } = live.current;
      if (outcome.kind === "unknown") {
        show(t("kanban.account.receipt.stageStillUnknown", { stage: input.stageName, account: write.account ? input.labelOf(write.account) : t("kanban.account.projectChoice") }), { label: t("kanban.pipelineAct.checkAgain"), run: again }, { error: true });
        return;
      }
      reportStage(outcome, { ...input, account: write.account }, () => {}, again);
    });
  }, [stages, reportStage]);

  const chooseStage = useCallback<AccountChoice["chooseStage"]>((input) => {
    const run = () => {
      void stages.choose(input.pipelineId, input.stageId, input.account, live.current.ports).then((outcome) => {
        if (outcome) reportStage(outcome, input, run, () => checkStage(input));
      });
    };
    run();
  }, [stages, reportStage, checkStage]);

  const switchConversation = useCallback<AccountChoice["switchConversation"]>((input) => {
    const { file, target, targetLabel, name } = input;
    const key = conversationIdentity(file);
    if (!switches.begin(key, target)) return;
    const profile = effectiveProfile(file);
    void postConversationSwitch({
      path: file.path,
      conversationId: input.conversationId,
      accountId: target,
      model: profile.model,
      effort: profile.effort,
      ...(file.engine === "codex" ? { fast: profile.fast } : {}),
    }).then((answer) => {
      const { show, t } = live.current;
      if (answer.kind === "accepted") {
        switches.accept(key, answer.operationId, answer.status);
        show(t(input.working ? "kanban.account.receipt.requestedWaits" : "kanban.account.receipt.requested", { account: targetLabel, name }));
        /* #1279: a choice outside the project's accounts is allowed and recorded, and the operator is told which. */
        if (answer.outsidePool) {
          show(t(answer.recorded === false ? "kanban.account.receipt.outsideUnrecorded" : "kanban.account.receipt.outsideRecorded", { account: targetLabel }), undefined, { error: answer.recorded === false });
        }
      } else if (answer.kind === "refused") {
        switches.drop(key);
        show(t("kanban.account.receipt.refused", { account: targetLabel, error: answer.error }), undefined, { error: true });
      } else {
        /* It may be queued: nothing sends it again. */
        switches.lost(key);
        show(t("kanban.account.receipt.unknown", { account: targetLabel, name }), undefined, { error: true });
      }
    });
  }, [switches]);

  const settleSwitch = useCallback<AccountChoice["settleSwitch"]>((key, settle, targetLabel, name) => {
    if (!switches.get(key)) return;
    switches.drop(key);
    const { show, t } = live.current;
    if (settle.kind === "switched") show(t("kanban.account.receipt.switched", { name, account: targetLabel }));
    else show(settle.reason ? t("kanban.account.receipt.failedReason", { name, account: targetLabel, reason: settle.reason }) : t("kanban.account.receipt.failed", { name, account: targetLabel }), undefined, { error: true });
  }, [switches]);

  const cancelSwitch = useCallback<AccountChoice["cancelSwitch"]>((input) => {
    const key = conversationIdentity(input.file);
    /* One cancel per conversation at a time; one that got no answer keeps the lock. */
    if (!cancels.begin(key, input.pendingLabel, input.subject)) return;
    const run = () => {
      void postSwitchCancel(input.conversationId, input.target).then((answer) => {
        const { show, t } = live.current;
        const account = input.pendingLabel ?? t("kanban.account.anotherAccount");
        if (answer.kind === "cancelled") {
          cancels.drop(key);
          /* This page's own request for the cancelled switch ends with the cancel, not as a failure. */
          switches.drop(key);
          show(t("kanban.account.receipt.cancelled", { account, name: input.name }));
          requestFilesRefresh();
          if (input.then) {
            switchConversation({ file: input.file, conversationId: input.conversationId, target: input.then.account, targetLabel: input.then.label, name: input.name, working: input.then.working });
          }
          return;
        }
        const notRequested = input.then ? ` ${t("kanban.account.receipt.changeNotRequested", { account: input.then.label })}` : "";
        if (answer.kind === "unknown") {
          cancels.lost(key);
          show(`${t("kanban.account.receipt.cancelUnknown", { account })}${notRequested}`, undefined, { error: true });
          return;
        }
        cancels.drop(key);
        requestFilesRefresh();
        const text = answer.code === "SWITCH_CLAIMED"
          ? t("kanban.account.receipt.cancelClaimed", { account })
          : answer.code === "SWITCH_STARTED"
            ? t("kanban.account.receipt.cancelStarted", { account })
            : answer.code === "SWITCH_NOT_PENDING"
              ? t("kanban.account.receipt.cancelNotPending", { account })
              : answer.code === "RUNTIME_UNREADABLE"
                ? t("kanban.account.receipt.cancelUnread", { account })
                : t("kanban.account.receipt.cancelRefused", { account, error: answer.error });
        show(`${text}${notRequested}`, answer.retryable ? { label: t("kanban.retry"), run: () => cancelSwitch(input) } : undefined, { error: true });
      });
    };
    run();
  }, [cancels, switches, switchConversation]);

  const openTarget = useCallback((target: AccountTarget, anchor: HTMLElement) => live.current.open(target, anchor), []);

  return useMemo(() => ({ stages, switches, cancels, open: openTarget, policy, loadPolicy, chooseStage, checkStage, switchConversation, settleSwitch, cancelSwitch }), [stages, switches, cancels, openTarget, policy, loadPolicy, chooseStage, checkStage, switchConversation, settleSwitch, cancelSwitch]);
}

/* ── Shared reads ───────────────────────────────────────────────────────── */

const clock = (unixSeconds: number) => new Date(unixSeconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const labelIn = (accounts: readonly AccountOption[]) => (id: string) => accounts.find((account) => account.id === id)?.label ?? id;

function sessionUse(t: TFunction, account: AccountOption | undefined): string | null {
  const session = account?.limits?.session;
  if (!session) return null;
  const percent = Math.round(session.usedPercent);
  return session.windowMinutes && session.windowMinutes % 60 === 0
    ? t("kanban.account.usedOfWindow", { percent, hours: session.windowMinutes / 60 })
    : t("kanban.account.used", { percent });
}

/** The summary line of an account: its label, plan and use of its session window. */
function accountLine(t: TFunction, accounts: readonly AccountOption[], id: string): string {
  const account = accounts.find((candidate) => candidate.id === id);
  return [account?.label ?? id, account?.plan ?? null, sessionUse(t, account)].filter(Boolean).join(" · ");
}

function useStageWrite(stages: StageAccounts | null, key: string) {
  return useSyncExternalStore(stages?.subscribe ?? noSubscribe, () => stages?.get(key) ?? null, () => null);
}

/** The account a conversation runs on, and what the board may say about switching it. */
export function useConversationSwitch(file: FileEntry, session: RuntimeSession | null) {
  const choice = useContext(AccountChoiceContext);
  const key = conversationIdentity(file);
  const request = useSyncExternalStore(choice?.switches.subscribe ?? noSubscribe, () => choice?.switches.get(key) ?? null, () => null);
  const current = session?.accountId ?? file.spawn?.accountId ?? accountIdFromPath(file.path);
  const receiptOf = (operationId: string | null | undefined) => (operationId
    ? session?.recentReceipts.find((candidate) => candidate.operationId === operationId && candidate.kind === "reconfigure") ?? null
    : null);
  const queued = session?.pendingReconfigure ?? null;
  const pending = queued
    ? { operationId: queued.operationId, accountId: queued.accountId ?? null, model: queued.model, effort: queued.effort, status: receiptOf(queued.operationId)?.status ?? null }
    : null;
  const stored = useSyncExternalStore(choice?.cancels.subscribe ?? noSubscribe, () => choice?.cancels.get(key) ?? null, () => null);
  const input = { current, migration: file.migration, request, receipt: receiptOf(request?.operationId), pending };
  const cancelTarget = switchCancelTarget(input);
  const subject = cancelSubject(cancelTarget, file.migration);
  return { key, current, request, cancel: heldCancel(stored, subject), cancelTarget, cancelSubject: subject, ...switchView(input) };
}

const pendingTarget = (view: SwitchView): string | null => (view.kind === "none" ? null : view.target);

/** Whether the conversation runs a turn now: the runtime session's word when there is one. */
export function conversationWorking(file: FileEntry, session: RuntimeSession | null): boolean {
  return session ? session.turn === "running" : mobileRowState(file).key === "working";
}

function whenWord(t: TFunction, view: SwitchView, working: boolean): string {
  switch (view.kind) {
    case "sending": return t("kanban.account.whenSending");
    /* Behind a running turn it waits for the turn; with none running it is only queued. */
    case "waiting": return t(working ? "kanban.account.whenTurn" : "kanban.account.whenQueued");
    case "settings": return t("kanban.account.whenSettings");
    case "switching": return t("kanban.account.whenSwitching");
    case "failed": return t("kanban.account.whenFailed");
    case "unknown": return t("kanban.account.whenUnknown");
    default: return "";
  }
}

/* ── Chips ─────────────────────────────────────────────────────────────── */

function Chip({ current, to, when, pending, trigger, aria, onOpen }: {
  current: string;
  to: string | null;
  when: string | null;
  pending: boolean;
  trigger: string;
  aria: string;
  onOpen: ((anchor: HTMLElement) => void) | null;
}) {
  if (!onOpen) return <span className="ch-account" data-account-static={trigger}>{current}</span>;
  return (
    <button
      type="button"
      className={`ch-account acct-trigger${pending ? " pending" : ""}`}
      aria-haspopup="dialog"
      aria-label={aria}
      data-account-trigger={trigger}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      <span className="cur">{current}</span>
      {pending ? (
        <>
          {to ? <><span className="arrow" aria-hidden="true">→</span><span className="to">{to}</span></> : null}
          {when ? <span className="when">{when}</span> : null}
        </>
      ) : null}
      <ChevronDown />
    </button>
  );
}

/** A stage that has not started: the account its first turn runs on. */
export function StageAccountChip({ pipeline, stage }: { pipeline: Pipeline; stage: PipelineStage }) {
  const { t } = useLocale();
  const choice = useContext(AccountChoiceContext);
  const accounts = useEngineAccounts(stage.effectiveRole.engine);
  const labelOf = labelIn(accounts.accounts);
  const key = stageAccountKey(pipeline.id, stage.id);
  const write = useStageWrite(choice?.stages ?? null, key);
  const pin = stagePin(stage);
  const current = pin ? labelOf(pin) : t("kanban.account.projectChoice");
  const to = write ? (write.account ? labelOf(write.account) : t("kanban.account.projectChoice")) : null;
  const when = write ? t(write.phase === "saving" ? "kanban.account.whenSaving" : "kanban.account.whenUnknown") : null;
  const open = choice && stageDraftable(pipeline, stage.id)
    ? (anchor: HTMLElement) => choice.open({ kind: "stage", pipelineId: pipeline.id, stageId: stage.id }, anchor)
    : null;
  return (
    <Chip
      current={current}
      to={to}
      when={when}
      pending={Boolean(write)}
      trigger={`stage:${key}`}
      aria={write ? t("kanban.account.chipPendingAria", { account: current, state: t("kanban.account.stateTo", { target: to ?? "", when: when ?? "" }) }) : t("kanban.account.chipAria", { account: current })}
      onOpen={open}
    />
  );
}

/** A conversation: the account its current turn runs on, and a switch this board can report. */
export function ConversationAccountChip({ file, session, readerKey, name }: { file: FileEntry; session: RuntimeSession | null; readerKey: string; name: string }) {
  const { t } = useLocale();
  const choice = useContext(AccountChoiceContext);
  const engine: AccountEngine = file.engine === "codex" ? "codex" : "claude";
  const accounts = useEngineAccounts(engine);
  const labelOf = labelIn(accounts.accounts);
  const { key, current, view, settle, cancel } = useConversationSwitch(file, session);
  const settled = settle ? `${settle.kind}:${settle.target}` : null;
  const settleSwitch = choice?.settleSwitch;
  useEffect(() => {
    if (settle && settleSwitch) settleSwitch(key, settle, labelOf(settle.target), name);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per settlement
  }, [settled, key, settleSwitch]);
  const target = pendingTarget(view);
  const to = view.kind === "none" || view.kind === "settings" ? null : target ? labelOf(target) : t("kanban.account.anotherAccount");
  const when = cancel && view.kind !== "none"
    ? t(cancel.phase === "sending" ? "kanban.account.whenCancelling" : "kanban.account.whenCancelUnknown")
    : whenWord(t, view, conversationWorking(file, session));
  const label = labelOf(current);
  return (
    <Chip
      current={label}
      to={to}
      when={when || null}
      pending={view.kind !== "none"}
      trigger={readerKey}
      aria={view.kind === "none" ? t("kanban.account.chipAria", { account: label }) : t("kanban.account.chipPendingAria", { account: label, state: to ? t("kanban.account.stateTo", { target: to, when }) : when })}
      onOpen={choice ? (anchor) => choice.open({ kind: "conversation", readerKey }, anchor) : null}
    />
  );
}

/* ── Pickers ───────────────────────────────────────────────────────────── */

interface RowView {
  id: string | null;
  name: string;
  tag: string;
  tone: "current" | "pending" | "";
  used: number | null;
  use: string;
  checked: boolean;
  disabled: boolean;
  title?: string;
  onPick: () => void;
}

function rowUse(t: TFunction, account: AccountOption): { used: number | null; use: string; limited: string | null } {
  const session = account.limits?.session;
  if (!session) return { used: null, use: "", limited: null };
  const percent = Math.round(session.usedPercent);
  const time = session.resetsAt ? clock(session.resetsAt) : null;
  return {
    used: Math.max(0, Math.min(100, percent)),
    /* At its limit the tag carries the reset. */
    use: time && percent < 100 ? t("kanban.account.use", { percent, time }) : t("kanban.account.useNoReset", { percent }),
    limited: percent >= 100 ? (time ? t("kanban.account.tagLimit", { time }) : t("kanban.account.tagLimitNoReset")) : null,
  };
}

function AccountList({ label, rows }: { label: string; rows: readonly RowView[] }) {
  const list = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={list}
      className="acct-list"
      role="radiogroup"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const items = [...(list.current?.querySelectorAll<HTMLElement>(".acct-row") ?? [])];
        const index = items.indexOf(document.activeElement as HTMLElement);
        event.preventDefault();
        items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }}
    >
      {rows.map((row) => (
        <button
          key={row.id ?? "project"}
          type="button"
          role="radio"
          className={`acct-row${row.tone ? ` ${row.tone}` : ""}`}
          aria-checked={row.checked}
          aria-disabled={row.disabled ? true : undefined}
          title={row.title}
          data-account={row.id ?? ""}
          onClick={() => {
            if (!row.disabled) row.onPick();
          }}
        >
          <span className="nm">{row.name}</span>
          <span className="tag">{row.tag}</span>
          {row.used === null ? null : <span className="meter" aria-hidden="true"><i style={{ width: `${row.used}%` }} /></span>}
          <span className="use num">{row.use}</span>
        </button>
      ))}
    </div>
  );
}

function PopoverHead({ text }: { text: string }) {
  return <div className="head"><span>{text}</span></div>;
}

const ENGINE_NAME: Record<AccountEngine, string> = { claude: "Claude", codex: "Codex" };

/** The first turn's account of a stage that has not started. */
export function StageAccountPopover({ anchor, onClose, pipeline, stage, name }: {
  anchor: HTMLElement;
  onClose: (refocus: boolean) => void;
  pipeline: Pipeline;
  stage: PipelineStage;
  name: string;
}) {
  const { t } = useLocale();
  const choice = useContext(AccountChoiceContext)!;
  const engine = stage.effectiveRole.engine;
  const accounts = useEngineAccounts(engine);
  const labelOf = labelIn(accounts.accounts);
  const { refresh } = accounts;
  const { loadPolicy } = choice;
  useEffect(() => {
    void refresh();
    loadPolicy(pipeline.project, true);
  }, [refresh, loadPolicy, pipeline.project]);
  const policy = choice.policy(pipeline.project);
  const key = stageAccountKey(pipeline.id, stage.id);
  const write = useStageWrite(choice.stages, key);
  const pin = stagePin(stage);
  const editable = stageDraftable(pipeline, stage.id);
  const saving = write?.phase === "saving";
  const pick = (account: string | null) => {
    onClose(true);
    if (account === pin && !write) return;
    choice.chooseStage({ pipelineId: pipeline.id, stageId: stage.id, stageName: name, account, labelOf });
  };
  const rows: RowView[] = [
    {
      id: null,
      name: t("kanban.account.projectChoice"),
      tag: pin === null ? t("kanban.account.tagChosen") : "",
      tone: pin === null ? "current" : "",
      used: null,
      use: t("kanban.account.projectChoiceUse"),
      checked: pin === null,
      disabled: !editable || saving,
      onPick: () => pick(null),
    },
    ...accounts.accounts.map((account): RowView => {
      const standing = accountStanding(policy, engine, account.id);
      const { used, use, limited } = rowUse(t, account);
      const chosen = pin === account.id;
      const notAllowed = standing === "outside";
      const signedOut = !account.authPresent;
      return {
        id: account.id,
        name: [account.label, account.plan].filter(Boolean).join(" · "),
        tag: chosen ? t("kanban.account.tagChosen") : notAllowed ? t("kanban.account.tagNotAllowed") : signedOut ? t("kanban.account.tagSignedOut") : limited ?? "",
        tone: chosen ? "current" : "",
        used,
        use: notAllowed ? "" : use,
        checked: chosen,
        disabled: !editable || saving || notAllowed,
        title: notAllowed ? t("kanban.account.notAllowedTitle") : signedOut ? t("kanban.account.signedOutTitle") : undefined,
        onPick: () => pick(account.id),
      };
    }),
  ];
  const writeTarget = write ? (write.account ? labelOf(write.account) : t("kanban.account.projectChoice")) : "";
  return (
    <KanbanPopover anchor={anchor} label={t("kanban.account.head", { name, engine: ENGINE_NAME[engine] })} onClose={onClose} initialFocus='.acct-row[aria-checked="true"]' className="acct-pop">
      <PopoverHead text={t("kanban.account.head", { name, engine: ENGINE_NAME[engine] })} />
      <div className="acct-now">
        <div className="kv">
          <span className="k">{t("kanban.account.firstTurnOn")}</span>
          <span className="v" data-account-now="">{pin ? accountLine(t, accounts.accounts, pin) : t("kanban.account.projectChoice")}</span>
        </div>
        {write ? (
          <div className="kv pending" data-account-pending={write.phase}>
            <span className="k">{t("kanban.account.pending")}</span>
            <span className="v">{t(saving ? "kanban.account.pendingSaving" : "kanban.account.pendingUnconfirmed", { target: writeTarget })}</span>
            {write.phase === "unconfirmed" ? (
              <button type="button" className="btn quiet" data-account-check="" onClick={() => choice.checkStage({ pipelineId: pipeline.id, stageId: stage.id, stageName: name, labelOf })}>
                {t("kanban.pipelineAct.checkAgain")}
              </button>
            ) : null}
          </div>
        ) : null}
        {write?.phase === "unconfirmed" ? <p className="acct-sub">{t("kanban.account.unconfirmedNote")}</p> : null}
      </div>
      <div className="acct-lbl">{t("kanban.account.runOn")}</div>
      <AccountList label={t("kanban.account.accounts")} rows={rows} />
      <p className="note">{t("kanban.account.noteStage")}</p>
      {policy.state === "unknown" ? <p className="note">{t("kanban.account.policyUnknown")}</p> : null}
    </KanbanPopover>
  );
}

/** A conversation's account: where its turn runs now, and a switch to another. */
export function ConversationAccountPopover({ anchor, onClose, file, name, stageContext }: {
  anchor: HTMLElement;
  onClose: (refocus: boolean) => void;
  file: FileEntry;
  name: string;
  stageContext: { pipeline: Pipeline; stage: PipelineStage } | null;
}) {
  const { t } = useLocale();
  const choice = useContext(AccountChoiceContext)!;
  const engine: AccountEngine = file.engine === "codex" ? "codex" : "claude";
  const accounts = useEngineAccounts(engine);
  const labelOf = labelIn(accounts.accounts);
  const { runtime } = useAgentCapabilities(file);
  const session = runtime?.session ?? null;
  const { current, view, cancel, cancelTarget, cancelSubject: subject } = useConversationSwitch(file, session);
  const project = stageContext?.pipeline.project ?? file.project;
  const { refresh } = accounts;
  const { loadPolicy } = choice;
  useEffect(() => {
    void refresh();
    loadPolicy(project, true);
  }, [refresh, loadPolicy, project]);
  const policy = choice.policy(project);
  const working = conversationWorking(file, session);
  const pending = view.kind !== "none";
  const target = pendingTarget(view);
  const targetName = target ? labelOf(target) : t("kanban.account.anotherAccount");
  const attempt = stageContext
    ? stageContext.pipeline.runs.find((run) => run.stageId === stageContext.stage.id)?.attempts.find((entry) => entry.conversationId === file.conversationId || entry.agentPath === file.path) ?? null
    : null;
  const pin = stageContext ? stagePin(stageContext.stage) : null;
  const outside = accounts.accounts.filter((account) => accountStanding(policy, engine, account.id) === "outside");
  const conversationId = session?.conversationId ?? file.conversationId ?? null;
  /* Cancel and Change exist while the switch can still be cancelled and no cancel of this page is in flight or unanswered. */
  const canCancel = Boolean(cancelTarget && conversationId && !cancel);
  const cancelPending = (then: { account: string; label: string } | null) => {
    if (!cancelTarget || !subject || !conversationId) return;
    onClose(true);
    choice.cancelSwitch({ file, conversationId, target: cancelTarget, subject, pendingLabel: target ? labelOf(target) : null, name, then: then ? { ...then, working } : null });
  };

  const rows = accounts.accounts.map((account): RowView => {
    const isCurrent = account.id === current;
    const isPending = pending && target === account.id;
    const standing = accountStanding(policy, engine, account.id);
    const { used, use, limited } = rowUse(t, account);
    const unavailable = !account.authPresent || account.loginPending;
    return {
      id: account.id,
      name: [account.label, account.plan].filter(Boolean).join(" · "),
      tag: isCurrent ? t("kanban.account.tagCurrent") : isPending ? t("kanban.account.tagPending") : unavailable ? t("kanban.account.tagSignedOut") : standing === "outside" ? t("kanban.account.tagOutside") : limited ?? "",
      tone: isCurrent ? "current" : isPending ? "pending" : "",
      used,
      use,
      checked: pending ? isPending : isCurrent,
      /* While a switch is pending an account is chosen only as a Change: the cancel first, then the new switch.
         Without a cancel the pending switch allows, nothing may replace it, nor a pending settings change. */
      disabled: (pending && !canCancel) || unavailable,
      title: pending && !canCancel ? t(view.kind === "settings" ? "kanban.account.pendingSettingsTitle" : "kanban.account.pendingTitle") : unavailable ? t("kanban.account.signedOutTitle") : standing === "outside" ? t("kanban.account.outsideTitle") : undefined,
      onPick: () => {
        if (pending) {
          if (isPending) return onClose(true);
          /* Back to the account it runs on is the cancel alone. */
          return cancelPending(isCurrent ? null : { account: account.id, label: account.label });
        }
        onClose(true);
        if (isCurrent) return;
        choice.switchConversation({ file, conversationId, target: account.id, targetLabel: account.label, name, working });
      },
    };
  });

  const pendingText = (() => {
    switch (view.kind) {
      case "sending": return t("kanban.account.pendingSending", { target: targetName });
      case "waiting": return t(working ? "kanban.account.pendingWaiting" : "kanban.account.pendingQueued", { target: targetName });
      case "settings": return t("kanban.account.pendingSettings", { model: view.model, effort: view.effort });
      case "switching": return t("kanban.account.pendingSwitching", { target: targetName });
      case "failed": return view.reason ? t("kanban.account.pendingFailedReason", { target: targetName, reason: view.reason }) : t("kanban.account.pendingFailed", { target: targetName });
      case "unknown": return t("kanban.account.pendingUnknown", { target: targetName });
      default: return "";
    }
  })();
  const cancelText = cancel ? t(cancel.phase === "sending" ? "kanban.account.pendingCancelling" : "kanban.account.pendingCancelUnknown", { target: targetName }) : null;
  const pendingNotes = [
    (view.kind === "waiting" || view.kind === "switching") && view.source === "page" ? t("kanban.account.pageOnly") : null,
    view.kind === "waiting" && view.source === "record" ? t("kanban.account.heldNote") : null,
    view.kind === "waiting" && view.source === "record" ? t("kanban.account.heldExceptionsNote") : null,
    view.kind === "failed" ? t("kanban.account.failedNote") : null,
    view.kind === "unknown" ? t("kanban.account.unknownNote") : null,
    view.kind === "settings" ? t("kanban.account.settingsNote") : null,
    cancel?.phase === "unknown" ? t("kanban.account.cancelUnknownNote") : null,
    /* A switch the queue is applying, or past waiting for its turn, can no longer be cancelled. */
    (view.kind === "waiting" || view.kind === "switching") && !cancelTarget && !cancel ? t("kanban.account.tooLateNote") : null,
  ].filter((note): note is string => Boolean(note));

  return (
    <KanbanPopover anchor={anchor} label={t("kanban.account.head", { name, engine: ENGINE_NAME[engine] })} onClose={onClose} initialFocus={rows.some((row) => row.checked) ? '.acct-row[aria-checked="true"]' : ".acct-row"} className="acct-pop">
      <PopoverHead text={t("kanban.account.head", { name, engine: ENGINE_NAME[engine] })} />
      <div className="acct-now">
        <div className="kv">
          <span className="k">{t("kanban.account.currentTurnOn")}</span>
          <span className="v" data-account-now="">{accountLine(t, accounts.accounts, current)}</span>
        </div>
        {stageContext ? (
          <div className="kv">
            <span className="k">{t("kanban.account.stageSetting")}</span>
            <span className="v" data-account-setting="">{pin ? labelOf(pin) : t("kanban.account.projectChoice")}</span>
          </div>
        ) : null}
        {attempt?.accountId && attempt.accountId !== current ? (
          <div className="kv">
            <span className="k">{t("kanban.account.launchedOn")}</span>
            <span className="v" data-account-launched="">{labelOf(attempt.accountId)}</span>
          </div>
        ) : null}
        {pending ? (
          <div className="kv pending" data-account-pending={view.kind} data-account-source={"source" in view ? view.source : undefined} data-account-cancel-state={cancel?.phase}>
            <span className="k">{t("kanban.account.pending")}</span>
            <span className="v">{cancelText ?? pendingText}</span>
            {canCancel ? (
              <button type="button" className="btn quiet" data-account-cancel={cancelTarget!.action} onClick={() => cancelPending(null)}>
                {t("kanban.account.cancelSwitch")}
              </button>
            ) : null}
          </div>
        ) : null}
        {pendingNotes.map((note) => <p key={note} className="acct-sub">{note}</p>)}
      </div>
      <div className="acct-lbl">{pending ? t(canCancel ? "kanban.account.changePending" : "kanban.account.accounts") : t("kanban.account.switchTo")}</div>
      <AccountList label={t("kanban.account.accounts")} rows={rows} />
      <p className="note">{t(working ? "kanban.account.noteWorking" : "kanban.account.noteIdle")}</p>
      {outside.length ? <p className="note">{t("kanban.account.noteOutside")}</p> : null}
      {policy.state === "unknown" ? <p className="note">{t("kanban.account.policyUnknown")}</p> : null}
    </KanbanPopover>
  );
}
