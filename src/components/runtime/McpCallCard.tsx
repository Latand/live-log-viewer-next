"use client";

import {
  Bot,
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  Link2,
  ListTodo,
  LoaderCircle,
  MessageCircle,
  MessagesSquare,
  Rocket,
  Send,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  conversationAvailabilitySnapshot,
  subscribeConversationAvailability,
  type ConversationAvailabilitySnapshot,
} from "@/lib/mcp/availability";
import {
  describeMcpCall,
  type McpCallIcon,
  type McpCallLink,
} from "@/lib/mcp/presentation";

import type { ToolEvent } from "../feed/parse";
import { hhmm } from "../utils";

const ICONS: Record<McpCallIcon, LucideIcon> = {
  bot: Bot,
  message: Send,
  task: ListTodo,
  pipeline: Workflow,
  link: Link2,
  conversation: MessagesSquare,
  deploy: Rocket,
  tool: Wrench,
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function resultError(result: unknown, fallback: string): string {
  const value = record(result);
  const direct = typeof value.error === "string" ? value.error.trim() : "";
  const message = typeof record(value.error).message === "string"
    ? String(record(value.error).message).trim()
    : "";
  return direct || message || fallback.trim() || "MCP call failed";
}

function useConversationAvailability(provided?: ReadonlySet<string>): ConversationAvailabilitySnapshot {
  const [snapshot, setSnapshot] = useState(conversationAvailabilitySnapshot);
  useEffect(() => {
    if (provided) return;
    return subscribeConversationAvailability(setSnapshot);
  }, [provided]);
  return provided ? { loaded: true, ids: provided } : snapshot;
}

function prettyPayload(args: unknown, result: unknown): string {
  try {
    return JSON.stringify({ arguments: args, ...(result === undefined ? {} : { result }) }, null, 2);
  } catch {
    return "Payload could not be serialized.";
  }
}

function navigateToEntity(event: React.MouseEvent<HTMLAnchorElement>, link: McpCallLink): void {
  if (link.kind === "conversation") return;
  event.preventDefault();
  window.dispatchEvent(new CustomEvent("llv:mcp-navigate", {
    detail: { kind: link.kind, id: link.id },
  }));
}

function LinkChip({
  link,
  conversationAvailability,
}: {
  link: McpCallLink;
  conversationAvailability: ConversationAvailabilitySnapshot;
}) {
  const disabled = link.kind === "conversation"
    && (!conversationAvailability.loaded || !conversationAvailability.ids.has(link.id));
  const shared = "inline-flex min-h-6 shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold transition-colors [@media(pointer:coarse)]:min-h-8";
  if (disabled) {
    return (
      <span
        data-testid={`mcp-link-${link.kind}`}
        aria-disabled="true"
        title="This conversation will open after the scanner attributes it."
        className={`${shared} cursor-wait border-border bg-sunken text-muted opacity-60`}
      >
        <MessageCircle className="h-3 w-3" aria-hidden />
        {link.label}
      </span>
    );
  }
  return (
    <a
      data-testid={`mcp-link-${link.kind}`}
      href={link.href}
      onClick={(event) => navigateToEntity(event, link)}
      className={`${shared} border-accent/35 bg-accent-soft text-accent hover:border-accent hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45`}
    >
      {link.kind === "conversation" ? <MessageCircle className="h-3 w-3" aria-hidden /> : <ExternalLink className="h-3 w-3" aria-hidden />}
      {link.label}
    </a>
  );
}

export function McpCallCard({
  event,
  availableConversationIds,
}: {
  event: ToolEvent;
  availableConversationIds?: ReadonlySet<string>;
}) {
  const mcp = event.mcp;
  const result = mcp?.result;
  const description = useMemo(
    () => describeMcpCall(mcp?.toolName ?? event.tool, mcp?.args ?? {}, result),
    [event.tool, mcp?.args, mcp?.toolName, result],
  );
  const conversationAvailability = useConversationAvailability(availableConversationIds);
  const state = event.status === "run" ? "pending" : event.status === "err" ? "error" : "success";
  const Icon = ICONS[description.icon];
  const replayed = record(result).replayed === true || record(result).replay === true;
  const retryable = record(result).retryable === true;
  const error = state === "error" ? resultError(result, event.outputPreview) : "";
  const payload = useMemo(() => prettyPayload(mcp?.args ?? {}, result), [mcp?.args, result]);

  /* Compact contract: one dense row — action meaning first, chrome last.
     The title (which already carries the useful payload, e.g. the message text
     of a send_message call) truncates inline; state lives in the icon color and
     a small glyph instead of a separate "Completed" row; ids/paths/payload sit
     behind the quiet Details disclosure. An error is never quiet: its text gets
     its own visible line under the row. */
  return (
    <article data-testid="mcp-call-card" data-state={state} className="group/mcp relative my-1 ml-9">
      {state === "pending" ? (
        <div data-testid="mcp-call-progress" className="absolute inset-x-0 top-0 h-0.5 animate-pulse bg-gradient-to-r from-transparent via-accent to-transparent" />
      ) : null}
      <details className="min-w-0">
        <summary className="flex min-w-0 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-0.5 rounded-control py-0.5 text-ui hover:bg-sunken [@media(pointer:coarse)]:min-h-11 [&::-webkit-details-marker]:hidden">
          <Icon
            className={`h-3.5 w-3.5 shrink-0 ${
              state === "error" ? "text-danger" : state === "success" ? "text-success" : "text-accent"
            } ${state === "pending" ? "animate-pulse" : ""}`}
            aria-hidden
          />
          <span className="shrink-0 font-mono text-[9.5px] font-semibold uppercase tracking-[0.08em] text-muted">
            MCP · {mcp?.serverName ?? "viewer"}
          </span>
          <span className="min-w-0 flex-1 truncate font-semibold text-secondary" title={description.title}>
            {description.title}
          </span>
          {replayed ? <span data-testid="mcp-replay" className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-bold text-accent">Replay</span> : null}
          {retryable ? <span className="shrink-0 rounded-full bg-danger-soft px-1.5 py-0.5 text-[10px] font-bold text-danger">Retryable</span> : null}
          {description.links.map((link) => (
            <LinkChip key={`${link.kind}:${link.id}`} link={link} conversationAvailability={conversationAvailability} />
          ))}
          <span
            className={`inline-flex shrink-0 items-center ${
              state === "error" ? "text-danger" : state === "success" ? "text-success" : "text-accent"
            }`}
            role={state === "pending" ? "status" : undefined}
            aria-label={state === "pending" ? `${description.verb}…` : state}
          >
            {state === "pending" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden /> : state === "success" ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : <CircleAlert className="h-3.5 w-3.5" aria-hidden />}
          </span>
          {hhmm(event.ts) ? <span className="shrink-0 text-caption tabular-nums text-muted">{hhmm(event.ts)}</span> : null}
        </summary>
        <div className="ml-5 mt-1 text-[10.5px] text-muted">
          {description.subtitle ? (
            <div className="mb-1 truncate font-mono" title={description.subtitle}>{description.subtitle}</div>
          ) : null}
          <pre className="max-h-[320px] max-w-full overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] border-t border-border pt-1.5 font-mono text-[10.5px] text-secondary">{payload}</pre>
        </div>
      </details>
      {state === "error" ? (
        <div className="ml-5 border-l-2 border-danger pl-2 text-[11px] font-semibold text-danger">{error}</div>
      ) : null}
    </article>
  );
}
