import type { ReviewCardItem, ReviewSeverity } from "@/lib/review";

import { Ban, CircleCheck, Command, MessageCircle } from "../../icons";
import { hhmm } from "../../utils";
import { md, mdBlocks } from "../markdown";
import { tr } from "../parse";
import { FileRef } from "./shared";

function severityClass(severity: ReviewSeverity): string {
  if (severity === "Critical" || severity === "High" || severity === "P0" || severity === "P1") return "border-danger/30 bg-danger-soft text-danger";
  if (severity === "Medium" || severity === "P2") return "border-warning/35 bg-warning-soft text-warning";
  if (severity === "Low" || severity === "P3") return "border-border bg-sunken text-secondary";
  return "border-border bg-card text-muted";
}

function verdictClass(verdict: ReviewCardItem["verdict"]): string {
  if (verdict === "REQUEST_CHANGES") return "bg-danger-soft text-danger border-danger/25";
  if (verdict === "APPROVE") return "bg-success-soft text-success border-success/25";
  return "bg-sunken text-secondary border-border";
}

function VerdictLabel({ verdict }: { verdict: ReviewCardItem["verdict"] }) {
  const Icon = verdict === "REQUEST_CHANGES" ? Ban : verdict === "APPROVE" ? CircleCheck : MessageCircle;
  const text = verdict === "REQUEST_CHANGES" ? "REQUEST_CHANGES" : verdict === "APPROVE" ? "APPROVE" : "COMMENT";
  return (
    <span className="inline-flex items-center gap-1">
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {text}
    </span>
  );
}

export function ReviewCard({ item }: { item: ReviewCardItem }) {
  const findingCount = item.findings.length;
  const visibleFindings = item.findings.slice(0, 12);
  return (
    <div className="my-3.5 ml-9 overflow-hidden rounded-[14px] border border-codex/20 bg-card shadow-1">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-2.5">
        <span className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg bg-codex-soft text-codex">
          <Command className="h-4 w-4" aria-hidden />
        </span>
        <span className="text-[13.5px] font-bold">Codex review</span>
        {item.verdict ? (
          <span className={`rounded-full border px-2.5 py-0.5 text-[11.5px] font-extrabold ${verdictClass(item.verdict)}`}>
            <VerdictLabel verdict={item.verdict} />
          </span>
        ) : null}
        <span className="text-[11px] text-muted">
          {findingCount ? `${findingCount} finding${findingCount === 1 ? "" : "s"}` : tr("render.noFindings")}
        </span>
        {hhmm(item.ts) ? <span className="ml-auto text-label tabular-nums text-muted">{hhmm(item.ts)}</span> : null}
      </div>
      <div className="px-3.5 py-2.5">
        {item.summary.length ? (
          <div className="mb-2 whitespace-pre-wrap break-words text-[13px] text-secondary">{mdBlocks(item.summary.join("\n"))}</div>
        ) : null}
        {visibleFindings.length ? (
          <div className="space-y-2">
            {visibleFindings.map((finding, idx) => (
              <div key={idx} className="rounded-[10px] border border-border bg-sunken px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-2 py-0.5 text-[10.5px] font-extrabold ${severityClass(finding.severity)}`}>
                    {finding.severity}
                  </span>
                  {finding.file ? <FileRef file={finding.file} line={finding.line} /> : null}
                </div>
                <div className="mt-1.5 whitespace-pre-wrap break-words text-[13px]">{md(finding.title)}</div>
                {finding.body && finding.body !== finding.title ? (
                  <details className="mt-1 text-[12px] text-muted">
                    <summary className="cursor-pointer list-none font-semibold text-accent">details</summary>
                    <div className="mt-1 whitespace-pre-wrap break-words">{mdBlocks(finding.body)}</div>
                  </details>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {item.findings.length > visibleFindings.length ? (
          <div className="mt-2 text-[12px] text-muted">{tr("render.moreFindings", { count: item.findings.length - visibleFindings.length })}</div>
        ) : null}
        <details className="mt-2 rounded-[10px] border border-border bg-sunken text-[12px]">
          <summary className="cursor-pointer list-none px-3 py-1.5 font-semibold text-muted">raw review text</summary>
          <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap border-t border-border px-3 py-2 font-mono text-[11.5px] text-secondary">
            {item.raw}
          </pre>
        </details>
      </div>
    </div>
  );
}
