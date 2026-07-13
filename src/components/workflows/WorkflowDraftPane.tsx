"use client";

import { useEffect, useState } from "react";

import { Loader2, X } from "@/components/icons";
import { useLocale } from "@/lib/i18n";
import type { WorkflowTemplate } from "@/lib/workflows/types";

import { WORKFLOWS_CHANGED_EVENT } from "./workflowModel";

const field = (id: string, name: string) => `llvWfDraft:${id}:${name}`;

function readField(id: string, name: string): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem(field(id, name)) ?? "";
}

function writeField(id: string, name: string, value: string) {
  if (value) sessionStorage.setItem(field(id, name), value);
  else sessionStorage.removeItem(field(id, name));
}

/** Everything a workflow draft keeps in sessionStorage. */
export function clearWorkflowDraftStorage(id: string) {
  for (const name of ["template", "dir", "task", "mode"]) sessionStorage.removeItem(field(id, name));
}

/**
 * A workflow that does not exist yet, drawn as a full pane on the scheme —
 * the sibling of the agent draft (W6): template picker, repo directory with
 * the spawn-suggest list, mode toggle and the task brief. Launch POSTs
 * /api/workflows; the strip and the worktree agents take over from there.
 */
export function WorkflowDraftPane({
  draftId,
  project,
  onClose,
  onLaunched,
}: {
  draftId: string;
  project: string;
  onClose: () => void;
  onLaunched: () => void;
}) {
  const { t } = useLocale();
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [template, setTemplateState] = useState(() => readField(draftId, "template"));
  const [dir, setDirState] = useState(() => readField(draftId, "dir"));
  const [task, setTaskState] = useState(() => readField(draftId, "task"));
  const [manual, setManualState] = useState(() => readField(draftId, "mode") === "manual");
  const [dirs, setDirs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setTemplate = (value: string) => {
    setTemplateState(value);
    writeField(draftId, "template", value);
  };
  const setDir = (value: string) => {
    setDirState(value);
    writeField(draftId, "dir", value);
  };
  const setTask = (value: string) => {
    setTaskState(value);
    writeField(draftId, "task", value);
  };
  const setManual = (value: boolean) => {
    setManualState(value);
    writeField(draftId, "mode", value ? "manual" : "");
  };

  useEffect(() => {
    let cancelled = false;
    fetch("/api/workflows")
      .then((res) => res.json() as Promise<{ templates?: WorkflowTemplate[] }>)
      .then((json) => {
        if (cancelled || !Array.isArray(json.templates)) return;
        setTemplates(json.templates);
        setTemplateState((prev) => {
          const next = prev && json.templates!.some((item) => item.name === prev) ? prev : (json.templates![0]?.name ?? "");
          if (next !== prev) writeField(draftId, "template", next);
          return next;
        });
      })
      .catch(() => {});
    fetch("/api/spawn?project=" + encodeURIComponent(project))
      .then((res) => res.json() as Promise<{ dirs?: string[] }>)
      .then((json) => {
        if (cancelled || !Array.isArray(json.dirs)) return;
        setDirs(json.dirs);
        setDirState((prev) => {
          const next = prev || json.dirs?.[0] || "";
          if (next !== prev) writeField(draftId, "dir", next);
          return next;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project, draftId]);

  const picked = templates.find((item) => item.name === template) ?? null;

  const launch = async () => {
    if (busy) return;
    if (!dir.trim()) {
      setError(t("wfDraft.needDir"));
      return;
    }
    if (!task.trim()) {
      setError(t("wfDraft.needTask"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          template,
          task: task.trim(),
          repoDir: dir.trim(),
          mode: manual ? "manual" : "auto",
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? t("wfDraft.launchFailed"));
        return;
      }
      window.dispatchEvent(new Event(WORKFLOWS_CHANGED_EVENT));
      onLaunched();
    } catch {
      setError(t("common.serverUnavailable"));
    } finally {
      setBusy(false);
    }
  };

  const dirListId = "wf-draft-dirs-" + draftId;

  return (
    <section
      data-pan-ignore
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-1"
      aria-label={t("wfDraft.paneAria")}
    >
      <span aria-hidden className="h-1 w-full shrink-0 bg-accent" />
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-accent-soft px-2.5">
        <span className="h-2 w-2 shrink-0 rounded-full bg-strong" title={t("wfDraft.notStarted")} />
        <span className="shrink-0 text-[10.5px] font-bold tracking-[0.08em] text-accent">{t("wfStrip.workflow")}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-muted">{t("wfDraft.newWorkflow")}</span>
        <button
          className="inline-flex shrink-0 items-center rounded-[8px] border border-border bg-canvas px-1.5 py-0.5 text-muted hover:border-danger/40 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label={t("wfDraft.dismiss")}
          onClick={onClose}
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      </header>

      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-sunken px-2.5 py-2">
        <label className="flex items-center gap-1.5">
          <span className="w-[72px] shrink-0 text-[10px] font-semibold text-muted">{t("wfDraft.template")}</span>
          <select
            value={template}
            disabled={busy}
            onChange={(event) => setTemplate(event.target.value)}
            aria-label={t("wfDraft.templateAria")}
            className="min-w-0 flex-1 rounded-[6px] border border-border bg-card px-2 py-1 text-[11.5px] text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
          >
            {templates.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="w-[72px] shrink-0 text-[10px] font-semibold text-muted">{t("wfDraft.repo")}</span>
          <input
            value={dir}
            disabled={busy}
            onChange={(event) => setDir(event.target.value)}
            list={dirListId}
            placeholder="/home/…/Projects/…"
            aria-label={t("wfDraft.repoAria")}
            className="min-w-0 flex-1 rounded-[6px] border border-border bg-card px-2 py-1 font-mono text-[11px] text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
          />
          <datalist id={dirListId}>
            {dirs.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
        </label>
        <label className="flex items-center gap-1.5 text-[10.5px] font-semibold text-muted">
          <input type="checkbox" checked={manual} disabled={busy} onChange={(event) => setManual(event.target.checked)} className="accent-accent" />
          {t("wfDraft.manualMode")}
        </label>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
        {picked ? (
          <div className="flex flex-wrap items-center gap-1.5" aria-label={t("wfStrip.stagesAria")}>
            {picked.stages.map((stage, index) => (
              <span key={index} className="flex items-center gap-1.5">
                {index > 0 ? (
                  <span className="text-[10px] font-bold text-strong" aria-hidden>
                    →
                  </span>
                ) : null}
                <span className="inline-flex h-6 max-w-[200px] items-center truncate rounded-full bg-sunken px-2 text-[10.5px] font-bold text-secondary">
                  {stage.kind === "review-loop"
                    ? `${t("wfStrip.reviewStage")} · ${stage.reviewer.engine}${stage.reviewer.model ? " " + stage.reviewer.model : ""}${stage.reviewer.effort ? " " + stage.reviewer.effort : ""}`
                    : `${stage.scope.split(/[.:\n]/)[0]} · ${stage.agent.engine}${stage.agent.model ? " " + stage.agent.model : ""}${stage.agent.effort ? " " + stage.agent.effort : ""}`}
                </span>
              </span>
            ))}
            <span className="inline-flex h-6 items-center rounded-full bg-sunken px-2 text-[10.5px] font-bold text-secondary">
              → {picked.finish === "merge" ? t("wfDraft.finishMerge") : "PR"}
            </span>
          </div>
        ) : (
          <div className="text-[12px] text-muted">{t("wfDraft.hint")}</div>
        )}
        <textarea
          value={task}
          disabled={busy}
          onChange={(event) => setTask(event.target.value)}
          placeholder={t("wfDraft.taskPlaceholder")}
          aria-label={t("wfDraft.taskAria")}
          className="min-h-[160px] flex-1 resize-none rounded-[8px] border border-border bg-card px-2.5 py-2 text-[12.5px] leading-snug text-primary placeholder:text-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
        />
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-border bg-sunken px-2.5 py-2">
        {error ? (
          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-danger" title={error}>
            {error}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted">{t("wfDraft.footerHint")}</span>
        )}
        <button
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-accent bg-accent px-3.5 py-1.5 text-[11.5px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40"
          disabled={busy}
          onClick={() => void launch()}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
          {busy ? t("wfDraft.launching") : t("wfDraft.launch")}
        </button>
      </div>
    </section>
  );
}
