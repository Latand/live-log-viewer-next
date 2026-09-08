"use client";

import { ArrowUpRight, ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import { cleanTitle } from "@/components/utils";
import { taskTitle } from "./taskModel";
import type { TaskWorkflowProjection } from "./taskWorkflowModel";

const PAGE = 30;

/** Task history is a bounded navigation surface over recorded relationships.
 * It never starts, retries, edits, or settles an execution. */
export const TaskWorkflowPanel = memo(function TaskWorkflowPanel({ model, onOpen, onClose }: {
  model: TaskWorkflowProjection;
  onOpen: (file: FileEntry) => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const task = model.tasks.find(item => item.task.id === selected);
  const rows = useMemo(() => task
    ? task.references
    : model.unlinkedReferences, [task, model.unlinkedReferences]);
  const matching = useMemo(() => rows.filter(row =>
    `${row.file?.title ?? ""} ${row.stageId ?? ""} ${row.role} ${row.state}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [rows, query]);
  const lastPage = Math.max(0, Math.ceil(matching.length / PAGE) - 1), currentPage = Math.min(page, lastPage);
  const choose = (id: string | null) => { setSelected(id); setQuery(""); setPage(0); };
  return <aside data-task-workflow-panel className="absolute bottom-3 right-3 top-14 z-50 flex w-[420px] max-w-[calc(100%-24px)] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2"
    aria-label={t("taskHistory.title")} onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <header className="flex items-center justify-between border-b border-border px-4 py-3">
      <strong>{t("taskHistory.title")}</strong>
      <button className="flex h-9 w-9 items-center justify-center" onClick={onClose} aria-label={t("taskHistory.close")}><X size={18} /></button>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <label className="mb-4 block text-xs text-muted">{t("taskHistory.task")}
        <select className="mt-2 block w-full rounded border border-border bg-canvas p-2 text-sm text-primary" value={selected ?? ""} onChange={event => choose(event.target.value || null)}>
          <option value="">{t("taskHistory.unlinked")} · {model.unlinkedWorkers.length}</option>
          {model.tasks.map(item => <option key={item.task.id} value={item.task.id}>{taskTitle(item.task.text)} · {item.workers.length}</option>)}
        </select>
      </label>
      {task ? <>
        <h2 className="text-lg font-semibold">{taskTitle(task.task.text)}</h2>
        <p className="mt-2 text-xs text-muted">{task.task.status} · {t("taskHistory.counts", { workers: task.workers.length, reviews: task.reviews, executions: task.executions.length })}</p>
        <details className="my-4 text-sm"><summary className="cursor-pointer">{t("taskHistory.requirement")}</summary><p className="mt-2 whitespace-pre-wrap">{task.task.text}</p></details>
        {task.executions.map(execution => <section key={execution.pipeline.id} className="mb-3 border-l-2 border-border pl-3 text-xs">
          <strong className="block text-sm">{execution.pipeline.task}</strong>
          <p className="mt-1 text-muted">{execution.pipeline.state} · {t(`taskHistory.${execution.basis}`)}</p>
          {execution.pipeline.stateDetail && <p className="mt-1 text-danger">{execution.pipeline.stateDetail}</p>}
          <p className="mt-1">{execution.pipeline.publishedCommit ? t("taskHistory.published", { sha: execution.pipeline.publishedCommit.slice(0, 12) }) : t("taskHistory.unpublished")}</p>
        </section>)}
        {task.flows.filter(flow => flow.mergeEvidence).map(flow => <p key={flow.id} className="my-2 text-xs">
          {flow.mergeEvidence?.mergedAt ? t("taskHistory.merged") : t("taskHistory.mergeUnrecorded")}
          {flow.mergeEvidence?.headSha ? ` · ${flow.mergeEvidence.headSha.slice(0, 12)}` : ""}
        </p>)}
        <p className="mb-4 text-xs text-muted">{t("taskHistory.releaseUnrecorded")}</p>
      </> : <>
        <p className="mb-3 text-sm text-muted">{t("taskHistory.unlinkedExplanation")}</p>
        {model.unlinkedPipelines.map(pipeline => <details key={pipeline.id} className="mb-2 text-xs"><summary>{pipeline.task} · {pipeline.state}</summary><p className="mt-2">{pipeline.stateDetail ?? t("taskHistory.associationUnrecorded")}</p></details>)}
        {model.unlinkedFlows.map(flow => <p key={flow.id} className="mb-2 text-xs">{t("taskHistory.reviewFlow")} · {flow.state} · {flow.rounds.length}</p>)}
      </>}
      <label className="mb-3 flex items-center gap-2 rounded border border-border bg-canvas px-2"><Search size={15} /><input className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none" aria-label={t("taskHistory.search")} placeholder={t("taskHistory.search")} value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
      <p className="mb-2 text-xs text-muted">{t("taskHistory.records", { count: matching.length })}</p>
      <div data-task-history-rows>
        {matching.length === 0 && <p className="py-4 text-sm text-muted">{t("taskHistory.empty")}</p>}
        {matching.slice(currentPage * PAGE, (currentPage + 1) * PAGE).map(row => <section key={row.key} className="border-t border-border py-3 text-xs" data-work-reference={row.key}>
          {row.file ? <button className="flex min-h-9 w-full items-center justify-between gap-2 text-left text-sm font-semibold hover:text-accent" onClick={() => { onClose(); onOpen(row.file!); }}>
            {cleanTitle(row.file.title)}<ArrowUpRight size={15} className="shrink-0" />
          </button> : <strong className="block text-sm">{row.kind === "planned" ? t("taskHistory.planned") : row.path ? t("taskHistory.unavailable") : t("taskHistory.unresolved")}</strong>}
          <p className="mt-1 text-muted">{row.role} · {row.kind === "assignment" ? t("taskHistory.assignmentState", { state: row.state }) : row.state}{row.stageId ? ` · ${row.stageId}` : ""}{row.attempt ? ` · ${t("taskHistory.attempt", { count: row.attempt })}` : ""}</p>
          {(row.kind === "review" || row.role === "reviewer" || row.role === "verifier") && <p className="mt-1">{row.reviewedSha ? row.reviewedSha.slice(0, 12) : t("taskHistory.revisionUnrecorded")}{row.verdict ? ` · ${row.verdict}` : ""}</p>}
          {row.error && <p className="mt-1 whitespace-pre-wrap text-danger">{row.error}</p>}
          {row.findings.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-4">{row.findings.map((finding, index) => <li key={index}>{finding}</li>)}</ul>}
          {row.findingsCount !== null && row.findings.length === 0 && <p className="mt-1">{t("taskHistory.findings", { count: row.findingsCount })}</p>}
        </section>)}
      </div>
    </div>
    <footer className="flex items-center justify-between border-t border-border px-4 py-2 text-xs">
      <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className="flex h-9 items-center gap-1 disabled:opacity-30"><ChevronLeft size={16} />{t("taskHistory.previous")}</button>
      <span>{currentPage + 1} / {lastPage + 1}</span>
      <button disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)} className="flex h-9 items-center gap-1 disabled:opacity-30">{t("taskHistory.next")}<ChevronRight size={16} /></button>
    </footer>
  </aside>;
});
