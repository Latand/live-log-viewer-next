"use client";

import { CircleCheck, CircleX, Focus, Loader2, OctagonMinus, Repeat2, RotateCcw, Square, Trash2, X } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";

import { ComposerBar } from "@/components/ComposerBar";
import { cleanTitle } from "@/components/utils";
import { useComposer } from "@/hooks/useComposer";
import type { Flow, FlowsResponse, RoleConfig } from "@/lib/flows/types";
import { useLocale } from "@/lib/i18n";

import { canBulkFlow, canBulkInterrupt, canBulkKill, runBulk, withPresenceGuard, type BulkItemResult, type BulkRunner } from "./bulkActions";
import type { SchemeNode } from "./layout";

type ActionId = "message" | "interrupt" | "kill" | "remove" | "flow";

/* Mirrors FlowDialog's private fallback: used only when the presets fetch
   came back empty, so a bulk start never silently no-ops. */
const FALLBACK_ROLES: Record<"implementer" | "reviewer", RoleConfig> = {
  implementer: { engine: "claude", model: null, effort: null },
  reviewer: { engine: "codex", model: null, effort: "xhigh" },
};

async function postJson(url: string, body: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (res.ok) return { ok: true };
  const json = (await res.json().catch(() => null)) as { error?: string } | null;
  return { ok: false, error: json?.error ?? `HTTP ${res.status}` };
}

function ActionButton({
  icon,
  label,
  disabled,
  confirming,
  confirmLabel,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  disabled: boolean;
  confirming?: boolean;
  confirmLabel?: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 text-[11px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 ${
        confirming ? "border-err bg-err text-white" : "border-line bg-bg text-dim hover:border-accent/45 hover:text-accent"
      }`}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      {confirming ? confirmLabel : label}
    </button>
  );
}

/**
 * The selection session's control surface: a fixed screen-space bar under the
 * canvas (camera frames never touch it) with the broadcast composer, the bulk
 * actions with eligible counts, inline confirms for the two destructive ones,
 * and the per-node fan-out report with a failed-only retry. Deliveries run
 * strictly sequentially — a broadcast can boot tmux resume windows, and those
 * must never spawn in parallel. Memoized: camera frames re-render the board,
 * and the bar's props stay identity-stable through them.
 */
export const BulkActionBar = memo(function BulkActionBar({
  nodes,
  flowsByImpl,
  onRemove,
  onFit,
  onExit,
}: {
  nodes: SchemeNode[];
  flowsByImpl: Map<string, Flow>;
  onRemove: (path: string) => void;
  onFit: () => void;
  onExit: () => void;
}) {
  const { t } = useLocale();
  const [running, setRunning] = useState<ActionId | null>(null);
  /* Titles are captured into the report at launch: a killed node leaves the
     layout before its result row renders, and the report must still name it. */
  const [report, setReport] = useState<{
    action: ActionId;
    items: BulkItemResult[];
    current: string | null;
    titles: ReadonlyMap<string, string>;
  } | null>(null);
  const [confirm, setConfirm] = useState<"kill" | "remove" | null>(null);
  const [flowOpen, setFlowOpen] = useState(false);
  const retryRef = useRef<{ action: ActionId; runner: BulkRunner } | null>(null);
  /* Live view of the selection for the presence guard: a node that left the
     board mid-sweep must fail its slot, not receive a blind delivery. Layout
     effect, not passive: it lands in the same task as the commit, so an
     awaited delivery resuming between commit and effect cannot read a stale
     set. */
  const nodesRef = useRef(nodes);
  useLayoutEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    if (!confirm) return;
    const timer = window.setTimeout(() => setConfirm(null), 4000);
    return () => window.clearTimeout(timer);
  }, [confirm]);

  const execute = async (action: ActionId, paths: string[], rawRunner: BulkRunner) => {
    if (running || !paths.length) return [];
    setRunning(action);
    setConfirm(null);
    const titles = new Map((report?.titles ?? []) as Iterable<[string, string]>);
    for (const node of nodes) titles.set(node.file.path, cleanTitle(node.file.title, 60));
    const runner = withPresenceGuard(
      () => new Set(nodesRef.current.map((node) => node.file.path)),
      t("bulk.nodeGone"),
      rawRunner,
    );
    retryRef.current = { action, runner };
    setReport({ action, items: [], current: paths[0] ?? null, titles });
    try {
      return await runBulk(paths, runner, (items, current) => setReport({ action, items: [...items], current, titles }));
    } finally {
      setRunning(null);
    }
  };

  const retryFailed = () => {
    const failed = report?.items.filter((item) => !item.ok).map((item) => item.path) ?? [];
    const last = retryRef.current;
    if (!failed.length || !last) return;
    void execute(last.action, failed, last.runner);
  };

  const composer = useComposer({
    initialText: () => "",
    persistText: () => {},
    submit: async (overrideText?: string) => {
      const text = (overrideText ?? composer.textRef.current).trim();
      const images = composer.attachments.images.map((image) => ({ base64: image.base64, mime: image.mime }));
      if ((!text && !images.length) || running) return;
      composer.setBusy(true);
      try {
        const byPath = new Map(nodes.map((node) => [node.file.path, node]));
        const items = await execute("message", [...byPath.keys()], (path) => {
          const node = byPath.get(path);
          return postJson("/api/tmux", { pid: node?.file.pid ?? undefined, path, text, images });
        });
        if (items.length && items.every((item) => item.ok)) {
          composer.setText("");
          composer.attachments.clear();
        }
      } finally {
        composer.setBusy(false);
      }
    },
    disabled: running !== null,
  });

  const interruptible = nodes.filter(canBulkInterrupt);
  const killable = nodes.filter(canBulkKill);
  const flowable = nodes.filter((node) => canBulkFlow(node, flowsByImpl));

  const failedCount = report?.items.filter((item) => !item.ok).length ?? 0;

  return (
    <div
      data-scheme-ui
      className="absolute bottom-3 left-1/2 z-40 flex w-[640px] max-w-[94%] -translate-x-1/2 flex-col gap-1.5 rounded-[12px] border border-line bg-panel/95 p-2.5 shadow-[0_10px_36px_rgb(20_20_30/0.18)]"
    >
      {flowOpen ? (
        <BulkFlowPopover
          count={flowable.length}
          disabled={running !== null}
          onStart={(config) => {
            setFlowOpen(false);
            void execute("flow", flowable.map((node) => node.file.path), (path) =>
              postJson("/api/flows", { implementerPath: path, ...config }),
            );
          }}
          onClose={() => setFlowOpen(false)}
        />
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void composer.submit();
        }}
        className="flex flex-col gap-1.5"
      >
        <ComposerBar
          composer={composer}
          placeholder={t("bulk.placeholder")}
          textareaAriaLabel={t("bulk.textAria")}
          imageAriaLabel={t("composer.addImages")}
          sendLabelIdle={t("bulk.sendAll", { count: nodes.length })}
          sendLabelRecording={t("composer.stopAndSend")}
          sendTitleRecording={t("composer.stopAndSendTitle")}
          sendIdleClassName="border-accent bg-accent hover:opacity-90"
          leftSlot={
            <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-chip px-2 py-1 text-[10px] font-bold text-[#555]">
              {t("bulk.selectedCount", { count: nodes.length })}
            </span>
          }
        />
      </form>

      <div className="flex flex-wrap items-center gap-1.5">
        <ActionButton
          icon={<OctagonMinus className="h-3.5 w-3.5" aria-hidden />}
          label={`${t("bulk.interrupt")} ${interruptible.length}/${nodes.length}`}
          disabled={running !== null || !interruptible.length}
          onClick={() =>
            void execute("interrupt", interruptible.map((node) => node.file.path), (path) =>
              postJson("/api/tmux", { action: "interrupt", path }),
            )
          }
        />
        <ActionButton
          icon={<Square className="h-3.5 w-3.5" aria-hidden />}
          label={`${t("bulk.stop")} ${killable.length}/${nodes.length}`}
          confirming={confirm === "kill"}
          confirmLabel={t("bulk.stopConfirm", { count: killable.length })}
          disabled={running !== null || !killable.length}
          onClick={() => {
            if (confirm !== "kill") {
              setConfirm("kill");
              return;
            }
            void execute("kill", killable.map((node) => node.file.path), (path) =>
              postJson("/api/tmux", { action: "kill", path }),
            );
          }}
        />
        <ActionButton
          icon={<Trash2 className="h-3.5 w-3.5" aria-hidden />}
          label={`${t("bulk.remove")} ${nodes.length}`}
          confirming={confirm === "remove"}
          confirmLabel={t("bulk.removeConfirm", { count: nodes.length })}
          disabled={running !== null || !nodes.length}
          onClick={() => {
            if (confirm !== "remove") {
              setConfirm("remove");
              return;
            }
            /* Pure client removal (closeNode kills + hides); the emptied
               selection prunes itself and the session ends with the cards. */
            for (const node of nodes) onRemove(node.file.path);
            setConfirm(null);
          }}
        />
        <ActionButton
          icon={<Repeat2 className="h-3.5 w-3.5" aria-hidden />}
          label={`${t("bulk.flow")} ${flowable.length}/${nodes.length}`}
          disabled={running !== null || !flowable.length}
          onClick={() => setFlowOpen((value) => !value)}
        />
        <ActionButton
          icon={<Focus className="h-3.5 w-3.5" aria-hidden />}
          label={t("bulk.fit")}
          disabled={!nodes.length}
          onClick={onFit}
        />
        <button
          className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-full text-dim hover:bg-bg hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label={t("bulk.exit")}
          title={t("bulk.exit")}
          onClick={onExit}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {report ? (
        <div className="flex max-h-[140px] flex-col gap-0.5 overflow-y-auto rounded-[8px] border border-line bg-bg/60 p-1.5">
          {report.items.map((item) => (
            <div key={item.path} className="flex min-w-0 items-center gap-1.5 text-[11px]">
              {item.ok ? (
                <CircleCheck className="h-3.5 w-3.5 shrink-0 text-ok" aria-hidden />
              ) : (
                <CircleX className="h-3.5 w-3.5 shrink-0 text-err" aria-hidden />
              )}
              <span className="min-w-0 shrink-0 truncate font-semibold" style={{ maxWidth: "40%" }}>
                {report.titles.get(item.path) ?? item.path}
              </span>
              {item.error ? <span className="min-w-0 flex-1 truncate text-err">{item.error}</span> : null}
            </div>
          ))}
          {report.current ? (
            <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-dim">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
              <span className="min-w-0 truncate font-semibold">{report.titles.get(report.current) ?? report.current}</span>
            </div>
          ) : null}
          {!running && failedCount ? (
            <button
              className="mt-1 inline-flex h-6 items-center gap-1 self-start rounded-full border border-line bg-panel px-2 text-[10.5px] font-semibold text-dim hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              onClick={retryFailed}
            >
              <RotateCcw className="h-3 w-3" aria-hidden />
              {t("bulk.retryFailed", { count: failedCount })}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

/** Shared config for the per-node flow launch: one set of rules for all. */
function BulkFlowPopover({
  count,
  disabled,
  onStart,
  onClose,
}: {
  count: number;
  disabled: boolean;
  onStart: (config: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [presets, setPresets] = useState<FlowsResponse["presets"]>([]);
  const [presetName, setPresetName] = useState<string | null>(null);
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [roundLimit, setRoundLimit] = useState(5);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/flows")
      .then((res) => res.json() as Promise<FlowsResponse>)
      .then((json) => {
        if (cancelled || !Array.isArray(json.presets) || !json.presets.length) return;
        setPresets(json.presets);
        setPresetName((prev) => prev ?? json.presets[0]!.name);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      className="absolute bottom-[calc(100%+8px)] left-1/2 flex w-[420px] max-w-[94%] -translate-x-1/2 flex-col gap-2 rounded-[12px] border border-line bg-panel p-2.5 shadow-[0_10px_36px_rgb(20_20_30/0.18)]"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <span className="text-[12px] font-bold">{t("bulk.flowTitle", { count })}</span>
      <div className="grid grid-cols-3 gap-2">
        <label className="col-span-3 flex flex-col gap-1 text-[10.5px] font-semibold text-dim">
          {t("flowDialog.preset")}
          <select
            value={presetName ?? ""}
            className="h-8 rounded-[8px] border border-line bg-bg px-2 text-[12px] font-normal text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onChange={(event) => setPresetName(event.target.value || null)}
          >
            {presets.length ? (
              presets.map((preset) => (
                <option key={preset.name} value={preset.name}>
                  {preset.name}
                </option>
              ))
            ) : (
              <option value="">{t("flowDialog.effortDefault")}</option>
            )}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[10.5px] font-semibold text-dim">
          {t("flowDialog.transitions")}
          <select
            value={mode}
            className="h-8 rounded-[8px] border border-line bg-bg px-2 text-[11.5px] font-normal text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onChange={(event) => setMode(event.target.value as "auto" | "manual")}
          >
            <option value="auto">{t("flowDialog.auto")}</option>
            <option value="manual">{t("flowDialog.manual")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[10.5px] font-semibold text-dim">
          {t("flowDialog.roundLimit")}
          <input
            type="number"
            min={1}
            max={20}
            value={roundLimit}
            className="h-8 rounded-[8px] border border-line bg-bg px-2 text-[11.5px] font-normal text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onChange={(event) => setRoundLimit(Math.max(1, Math.min(20, Number(event.target.value) || 5)))}
          />
        </label>
        <div className="flex items-end justify-end gap-1.5">
          <button
            className="h-8 rounded-[8px] border border-line bg-bg px-2 text-[11px] font-semibold text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onClick={onClose}
          >
            {t("common.cancel")}
          </button>
          <button
            className="h-8 rounded-[8px] border border-accent bg-accent px-2.5 text-[11.5px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40"
            disabled={disabled || !count}
            onClick={() =>
              onStart({
                ...(presetName ? { preset: presetName } : { roles: FALLBACK_ROLES }),
                baseMode: "head",
                mode,
                reviewerMode: "headless",
                roundLimit,
              })
            }
          >
            {t("bulk.flowStart", { count })}
          </button>
        </div>
      </div>
    </div>
  );
}
