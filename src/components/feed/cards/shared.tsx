import { Check, Loader2, X } from "../../icons";
import type { ToolStatus } from "../parse";

/* Paths that live under a viewer transcript root can deep-link to that file;
   source-tree paths in a finding stay plain code chips. Mirrors ROOTS. */
const TRANSCRIPT_PATH_RE = /(?:\/\.codex\/sessions\/|\/\.claude\/projects\/|\/\.claude\/plugins\/data\/codex-openai-codex\/state\/|^\/tmp\/claude-\d+\/)/;

/** Run/ok/err status shown as an icon so the cmd rows read at a glance. */
export function StatusIcon({ status, className }: { status: ToolStatus; className?: string }) {
  const cls = className ?? "h-3.5 w-3.5";
  if (status === "ok") return <Check className={cls} aria-hidden />;
  if (status === "err") return <X className={cls} aria-hidden />;
  return <Loader2 className={`${cls} animate-spin`} aria-hidden />;
}

export function FileRef({ file, line }: { file: string; line?: number }) {
  const label = line ? `${file}:${line}` : file;
  const cls = "inline-block min-w-0 max-w-full truncate rounded-md bg-chip px-1.5 py-0.5 align-bottom font-mono text-[11.5px]";
  if (TRANSCRIPT_PATH_RE.test(file)) {
    return (
      <a href={`#f=${encodeURIComponent(file)}`} className={`${cls} text-accent underline decoration-dotted`} title={label}>
        {label}
      </a>
    );
  }
  return (
    <code className={cls} title={label}>
      {label}
    </code>
  );
}
