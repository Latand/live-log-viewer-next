"use client";

import { useState } from "react";

import { debugRaw } from "@/lib/review";

import { AlarmClock, GlyphIcon } from "../../icons";
import { hhmm } from "../../utils";
import { CopyButton } from "../CopyButton";
import { tr, type ToolEvent } from "../parse";
import type { ArgChip } from "../tools";
import { formatDuration } from "../toolBlocks";
import { useRawLine } from "../rawLine";
import { DiffCard } from "./DiffCard";
import { OrchestrationCard } from "./OrchestrationCard";
import { OutputPreview } from "./OutputPreview";
import { StatusIcon } from "./shared";

function statusClass(status: ToolEvent["status"]): string {
  return status === "ok" ? "text-success" : status === "err" ? "text-danger" : "text-muted";
}

export function ToolChips({ chips }: { chips: ArgChip[] }) {
  if (!chips.length) return null;
  return (
    <div className="mb-1 flex flex-wrap gap-1">
      {chips.map((chip, i) => (
        <span key={i} className="inline-flex max-w-full items-center gap-1 truncate rounded-md bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-primary">
          {chip.label ? <span className="text-muted">{chip.label}</span> : null}
          {chip.value}
        </span>
      ))}
    </div>
  );
}

/* The exit status shown in the readable block (issue #475): a real numeric code
   when the result reported one, else a plain ok/error verdict. Meaningless for a
   non-shell tool that carries no code, so those render no exit chip. */
function exitLabel(event: ToolEvent): string | null {
  if (event.exitCode !== undefined) return tr("tools.exitCode", { code: event.exitCode });
  if (event.status === "err") return event.statusLabel || tr("render.error");
  if (event.status === "ok" && event.family === "shell") return tr("tools.exitOk");
  return null;
}

/* One quiet metadata row over the command: cwd, wall-clock span, duration, and
   exit status — the auditable header a terminal client shows. Renders nothing
   when a call carries none of them (a plain non-shell tool). */
function ToolMeta({ event }: { event: ToolEvent }) {
  const start = hhmm(event.ts);
  const end = event.endTs !== undefined ? hhmm(event.endTs) : "";
  const span = end && start ? tr("tools.ranAt", { start, end }) : "";
  const duration = event.durationMs !== undefined ? formatDuration(event.durationMs) : "";
  const exit = exitLabel(event);
  if (!event.cwd && !span && !duration && !exit) return null;
  return (
    <div className="mb-1.5 flex flex-col gap-1 text-[11px] text-muted">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {exit ? (
          <span className={`inline-flex items-center gap-1 font-semibold ${statusClass(event.status)}`}>
            <StatusIcon status={event.status} className="h-3 w-3" />
            {exit}
          </span>
        ) : null}
        {duration ? (
          <span className="inline-flex items-center gap-1 tabular-nums">
            <AlarmClock className="h-3 w-3" aria-hidden />
            {duration}
          </span>
        ) : null}
        {span ? <span className="tabular-nums">{span}</span> : null}
      </div>
      {event.cwd ? (
        <div className="flex min-w-0 items-center gap-1">
          <span className="shrink-0 uppercase tracking-wide text-[10px]">{tr("tools.cwd")}</span>
          <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-secondary" title={event.cwd}>
            {event.cwd}
          </code>
          <CopyButton text={event.cwd} label={tr("tools.copyCwd")} className="shrink-0 p-0.5" />
        </div>
      ) : null}
    </div>
  );
}

/* The full redacted command with a copy control, wrapped instead of scrolled so
   a long line never forces document-level horizontal overflow on 390px. */
function CommandBlock({ command }: { command: string }) {
  return (
    <div className="group/cmd relative">
      <pre className="max-w-full whitespace-pre-wrap [overflow-wrap:anywhere] rounded-control border border-border bg-card py-1.5 pl-3 pr-10 font-mono text-ui">
        {"$ " + command}
      </pre>
      <CopyButton
        text={command}
        label={tr("tools.copyCommand")}
        className="absolute right-1.5 top-1.5 opacity-0 transition-opacity motion-reduce:transition-none focus-visible:opacity-100 group-hover/cmd:opacity-100 [@media(hover:none)]:opacity-60"
      />
    </div>
  );
}

/* Level-2 provenance: the redacted raw source line(s) resolved lazily and
   client-side from the retained window. Slid out of the window → a quiet chip.
   The call id is exposed for diagnosis and copy. */
function RawRecord({ event }: { event: ToolEvent }) {
  const getRaw = useRawLine();
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1.5 text-[11px] font-semibold text-muted hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        {tr("tools.rawRecord")}
      </button>
    );
  }
  const indices = [event.srcCall, event.srcResult].filter((n): n is number => typeof n === "number");
  const raw = indices.map((n) => getRaw(n)).filter((line): line is string => line !== null);
  const record = raw.length ? debugRaw(raw.join("\n")).raw : "";
  return (
    <div className="mt-1.5">
      <div className="mb-1 flex items-center gap-2 text-[10.5px] text-muted">
        <span className="font-mono">{tr("tools.callId", { id: event.id })}</span>
        <CopyButton text={event.id} label={tr("tools.copyId")} className="p-0.5" />
      </div>
      {record ? (
        <pre className="max-h-[300px] max-w-full overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-[10px] border border-border bg-sunken px-3 py-2 font-mono text-[11px]">{record}</pre>
      ) : (
        <span className="inline-flex items-center rounded-md bg-sunken px-2 py-0.5 text-[11px] text-muted">{tr("tools.noRawRecord")}</span>
      )}
    </div>
  );
}

/* The expanded readable body of a tool call (issue #475): chips, the auditable
   command header, structured diff/orchestration, and separate stdout/stderr
   disclosures. Mounted lazily by {@link ToolLine} on first expand, so a long
   collapsed transcript keeps its DOM small (issue #9 §7/§8). */
export function ToolBody({ event }: { event: ToolEvent }) {
  const hasDiff = event.body?.type === "diff";
  const showOutput = !hasDiff || Boolean(event.outputPreview.trim());
  return (
    <div className="mb-1 mt-1 rounded-surface bg-sunken px-3 py-2.5">
      <ToolChips chips={event.chips} />
      <ToolMeta event={event} />
      {event.command ? <CommandBlock command={event.command} /> : null}
      {event.orchestration ? <OrchestrationCard orchestration={event.orchestration} source={event.command} /> : null}
      {hasDiff && event.body?.type === "diff" ? <DiffCard body={event.body} /> : null}
      {showOutput ? (
        <OutputPreview
          output={event.outputPreview}
          truncated={event.outputTruncated}
          lang={event.lang}
          heading={event.stderr !== undefined ? tr("tools.stdout") : undefined}
        />
      ) : null}
      {event.stderr !== undefined ? (
        <OutputPreview
          output={event.stderr}
          truncated={Boolean(event.stderrTruncated)}
          heading={tr("tools.stderr")}
          tone="err"
          copyLabel={tr("tools.copyStderr")}
          showAllLabel={tr("tools.showStderr")}
          emptyLabel={tr("tools.noStderr")}
        />
      ) : null}
      <RawRecord event={event} />
    </div>
  );
}

/** One normalized tool event rendered as a quiet ToolLine (design doc §3.4):
    a borderless, tile-less single row — glyph + summary + (non-ok status) +
    time — that reads as chrome between messages. The body mounts only after the
    first expand into a sunken readable block (issue #475), keeping a long
    transcript's collapsed DOM small (issue #9 §7/§8) — the same lazy contract
    holds when the line renders inside a cmd-group. An error is never quiet: it
    carries a danger left edge and danger text, always visible.

    On a coarse pointer the summary inflates to a 44px tap target (rule 8 /
    #145–#146) while the visual line stays dense on desktop; `showTime` is off
    for a grouped child, whose time range already lives in the group header.
    `index` prefixes an ordinal in a numbered group block; `nested` marks a
    wait/stdin follow-up rendered under its parent exec. */
export function ToolLine({
  event,
  showTime = true,
  className = "",
  index,
  nested = false,
}: {
  event: ToolEvent;
  showTime?: boolean;
  className?: string;
  index?: number;
  nested?: boolean;
}) {
  const [mounted, setMounted] = useState(event.open);
  const time = hhmm(event.ts);
  const isErr = event.status === "err";
  return (
    <details
      className={`group/tool ${className}`}
      open={event.open}
      onToggle={(e) => {
        if (e.currentTarget.open) setMounted(true);
      }}
    >
      <summary
        className={`flex cursor-pointer list-none items-center gap-2 rounded-control py-0.5 text-ui hover:bg-sunken [@media(pointer:coarse)]:min-h-11 [&::-webkit-details-marker]:hidden ${
          isErr ? "border-l-2 border-danger bg-danger-soft pl-2 pr-1 text-danger" : nested ? "text-muted/90" : "text-muted"
        }`}
      >
        {index !== undefined ? (
          <span className="shrink-0 tabular-nums text-caption font-semibold text-muted">{index}.</span>
        ) : null}
        {nested ? <span className="shrink-0 select-none text-muted" aria-hidden>↳</span> : null}
        <GlyphIcon name={event.icon} className="h-3.5 w-3.5 shrink-0" />
        <span className={`min-w-0 flex-1 truncate ${isErr ? "font-semibold" : "text-secondary"}`} title={event.summary}>
          {event.summary}
        </span>
        {event.status !== "ok" ? (
          <span className={`inline-flex shrink-0 items-center gap-1 text-caption font-semibold ${statusClass(event.status)}`}>
            <StatusIcon status={event.status} className="h-3 w-3" />
            {event.statusLabel}
          </span>
        ) : null}
        {showTime && time ? <span className="shrink-0 text-caption tabular-nums text-muted">{time}</span> : null}
      </summary>
      {mounted ? <ToolBody event={event} /> : null}
    </details>
  );
}

/** A standalone tool event in the feed: a {@link ToolLine} at the feed's shared
    chrome indent (`ml-9`). */
export function ToolCard({ event }: { event: ToolEvent }) {
  return <ToolLine event={event} className="ml-9" />;
}
