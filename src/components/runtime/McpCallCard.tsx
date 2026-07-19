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
  const shared = "inline-flex min-h-7 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors";
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

  return (
    <article
      data-testid="mcp-call-card"
      data-state={state}
      className={`relative my-3 ml-9 overflow-hidden rounded-[14px] border bg-card shadow-1 ${
        state === "error" ? "border-danger/40" : state === "success" ? "border-success/25" : "border-accent/35"
      }`}
    >
      {state === "pending" ? (
        <div data-testid="mcp-call-progress" className="absolute inset-x-0 top-0 h-0.5 animate-pulse bg-gradient-to-r from-transparent via-accent to-transparent" />
      ) : null}
      <div className="flex items-start gap-3 px-3.5 py-3">
        <span
          className={`relative mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] ${
            state === "error" ? "bg-danger-soft text-danger" : state === "success" ? "bg-success-soft text-success" : "bg-accent-soft text-accent"
          }`}
        >
          <Icon className={`h-[18px] w-[18px] ${state === "pending" ? "animate-pulse" : ""}`} aria-hidden />
          {state === "pending" ? <span className="absolute -bottom-1 -right-1 h-2.5 w-2.5 animate-ping rounded-full bg-accent/70" aria-hidden /> : null}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-md border border-border bg-sunken px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.08em] text-muted">
              MCP · {mcp?.serverName ?? "viewer"}
            </span>
            {replayed ? <span data-testid="mcp-replay" className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent">Replay</span> : null}
            {retryable ? <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[10px] font-bold text-danger">Retryable</span> : null}
            {hhmm(event.ts) ? <span className="ml-auto text-[10px] tabular-nums text-muted">{hhmm(event.ts)}</span> : null}
          </div>
          <div className="mt-1.5 text-[13px] font-bold leading-snug text-primary">{description.title}</div>
          {description.subtitle ? <div className="mt-0.5 truncate font-mono text-[10.5px] text-muted" title={description.subtitle}>{description.subtitle}</div> : null}
          <div className={`mt-2 flex items-center gap-1.5 text-[11px] font-semibold ${
            state === "error" ? "text-danger" : state === "success" ? "text-success" : "text-accent"
          }`} role={state === "pending" ? "status" : undefined}>
            {state === "pending" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden /> : state === "success" ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : <CircleAlert className="h-3.5 w-3.5" aria-hidden />}
            {state === "pending" ? `${description.verb}…` : state === "success" ? "Completed" : error}
          </div>
          {description.links.length ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {description.links.map((link) => <LinkChip key={`${link.kind}:${link.id}`} link={link} conversationAvailability={conversationAvailability} />)}
            </div>
          ) : null}
          <details className="group/mcp mt-2 text-[10.5px] text-muted">
            <summary className="inline-flex min-h-6 cursor-pointer list-none items-center font-semibold hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [&::-webkit-details-marker]:hidden">
              Details
            </summary>
            <pre className="mt-1 max-h-[320px] max-w-full overflow-auto whitespace-pre rounded-[10px] border border-border bg-sunken px-3 py-2 font-mono text-[10.5px] text-secondary">{payload}</pre>
          </details>
        </div>
      </div>
    </article>
  );
}
