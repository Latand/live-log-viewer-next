"use client";

import type { ReactNode } from "react";

import type { FileEntry } from "@/lib/types";

import { hhmm } from "../utils";

type Call = { cmd: string; output: string; status: "run" | "ok" | "err"; label: string; icon: string; open: boolean };
type Item =
  | { kind: "prose"; ts: unknown; text: string; engine: "codex" | "claude" }
  | { kind: "user"; ts: unknown; text: string }
  | { kind: "svc"; text: string }
  | { kind: "note"; text: string }
  | { kind: "cmd"; id: string; call: Call }
  | { kind: "edit"; files: string }
  | { kind: "raw"; text: string; err: boolean };

function textPart(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arr(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((x): x is Record<string, unknown> => x && typeof x === "object" && !Array.isArray(x)) : [];
}

function md(text: string): ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <span key={i} className="rounded-md bg-chip px-1.5 py-0.5 font-mono">{part.slice(1, -1)}</span>;
    }
    if (part.startsWith("**") && part.endsWith("**")) return <b key={i}>{part.slice(2, -2)}</b>;
    return part;
  });
}

function newCmd(cmd: string, icon = "❯"): Call {
  return { cmd, icon, output: "", status: "run", label: "виконується…", open: false };
}

function attach(call: Call | undefined, output: string, errFlag?: boolean) {
  if (!call) return null;
  const code = output.match(/exited with code (\d+)/)?.[1];
  const body = output
    .replace(/^Chunk ID:[^\n]*\n/, "")
    .replace(/Wall time:[^\n]*\n/, "")
    .replace(/Original token count:[^\n]*\n?/, "")
    .trim();
  const isErr = errFlag === true || (code !== undefined && code !== "0");
  call.status = isErr ? "err" : "ok";
  call.label = isErr ? "✗ " + (code && code !== "0" ? "exit " + code : "помилка") : "✓ ok";
  call.open ||= isErr;
  if (body) {
    const limit = isErr ? 60_000 : 12_000;
    call.output = (call.output + "\n" + body).trim().slice(-limit);
  }
  return call;
}

export function buildFeed(file: FileEntry, lines: string[], showSvc: boolean, lineFilter: string) {
  const calls = new Map<string, Call>();
  const items: Item[] = [];
  let hiddenServiceCount = 0;
  let lastProse = "";
  const addProse = (ts: unknown, text: string) => {
    if (!text.trim() || text === lastProse) return;
    lastProse = text;
    items.push({ kind: "prose", ts, text, engine: file.engine === "codex" ? "codex" : "claude" });
  };
  const addCmd = (ts: unknown, cmd: string, callId?: string, icon?: string) => {
    const id = callId || "plain-" + items.length + "-" + String(ts ?? "");
    const call = newCmd(cmd, icon);
    calls.set(id, call);
    items.push({ kind: "cmd", id, call });
    return call;
  };
  const addOutput = (callId: string | undefined, output: string, err?: boolean) => {
    if (!callId) return;
    const call = attach(calls.get(callId), output, err);
    if (!call && output && showSvc) items.push({ kind: "svc", text: "output: " + output.slice(0, 200) });
  };
  const addSvc = (text: string) => {
    if (showSvc) items.push({ kind: "svc", text: text.slice(0, 300) });
    else hiddenServiceCount += 1;
  };
  const addNote = (text: string) => {
    items.push({ kind: "note", text });
  };
  const renderCodex = (obj: Record<string, unknown>) => {
    const p = rec(obj.payload);
    const ts = obj.timestamp;
    if (obj.type === "session_meta") {
      return addNote(`Сесія Codex створена · ${textPart(p.model)} · ${textPart(p.cwd)}`);
    }
    if (obj.type === "event_msg") {
      if (p.type === "agent_message" && p.message) return addProse(ts, textPart(p.message));
      if (p.type === "user_message" && p.message) return items.push({ kind: "user", ts, text: textPart(p.message) });
      if (p.type === "task_started") return addNote("Задача стартувала" + (ts ? " · " + hhmm(ts) : ""));
      if (p.type === "task_complete") return addNote("Задачу завершено" + (ts ? " · " + hhmm(ts) : ""));
      return addSvc(textPart(p.type) || "event");
    }
    if (obj.type === "response_item") {
      if (p.type === "message") {
        const text = arr(p.content).map((c) => textPart(c.text) || textPart(c.input_text)).join(" ").trim();
        if (!text) return addSvc("message " + textPart(p.role));
        return p.role === "user" ? items.push({ kind: "user", ts, text }) : addProse(ts, text);
      }
      if (p.type === "function_call") {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(textPart(p.arguments) || "{}");
        } catch {
          args = {};
        }
        const name = textPart(p.name);
        if (name === "exec_command" || name === "shell") {
          const cmd = String(args.cmd ?? args.command ?? "").replace(/^\/usr\/bin\/zsh -lc /, "");
          return addCmd(ts, cmd, textPart(p.call_id));
        }
        if (name === "apply_patch") {
          const files = String(args.input ?? "").match(/(Add|Update|Delete) File: [^\n]+/g);
          items.push({ kind: "edit", files: files ? files.join(", ").replace(/(Add|Update|Delete) File: /g, "") : "патч" });
          return;
        }
        if (name === "write_stdin") return addSvc("stdin → сесія " + String(args.session_id ?? ""));
        return addCmd(ts, name + " " + JSON.stringify(args).slice(0, 120), textPart(p.call_id), "🔧");
      }
      if (p.type === "function_call_output") return addOutput(textPart(p.call_id), typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? ""));
      if (p.type === "reasoning") return addSvc("reasoning");
      return addSvc(textPart(p.type) || "item");
    }
    addSvc(textPart(obj.type) || "запис");
  };
  const renderClaude = (obj: Record<string, unknown>) => {
    const ts = obj.timestamp;
    if (obj.type === "user" && obj.message) {
      const content = rec(obj.message).content;
      if (typeof content === "string") items.push({ kind: "user", ts, text: content });
      else {
        for (const part of arr(content)) {
          if (part.type === "text") items.push({ kind: "user", ts, text: textPart(part.text) });
          else if (part.type === "tool_result") {
            const contentText = typeof part.content === "string" ? part.content : arr(part.content).map((x) => textPart(x.text)).join(" ");
            addOutput(textPart(part.tool_use_id), contentText, part.is_error === true);
          }
        }
      }
      return;
    }
    if (obj.type === "assistant" && obj.message) {
      for (const part of arr(rec(obj.message).content)) {
        if (part.type === "text" && textPart(part.text).trim()) addProse(ts, textPart(part.text));
        else if (part.type === "tool_use") {
          const input = rec(part.input);
          const cmd = String(input.command ?? input.file_path ?? input.prompt ?? JSON.stringify(input));
          addCmd(ts, textPart(part.name) + ": " + cmd.slice(0, 160), textPart(part.id), "🔧");
        }
      }
      return;
    }
    addSvc(textPart(obj.type) || "запис");
  };
  const renderPlain = (line: string) => {
    if (/Assistant message$/.test(line)) return;
    const m = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    const ts = m?.[1] ?? null;
    const rest = m?.[2] ?? line;
    if (!rest || /^Assistant message captured/.test(rest)) return;
    if (/^Running command: /.test(rest)) return addCmd(ts, rest.replace(/^Running command: /, "").replace(/^\/usr\/bin\/zsh -lc /, ""));
    if (/^Command (completed|failed)/.test(rest)) {
      const last = [...calls.values()].at(-1);
      if (last) {
        attach(last, /^Command failed/.test(rest) ? rest + "\n(це джоб-лог: він не містить stdout команд; повний вивід — у rollout-сесії Codex у списку зліва)" : rest, /^Command failed/.test(rest));
      }
      return;
    }
    if (/^Applying \d+ file/.test(rest)) return items.push({ kind: "edit", files: rest });
    if (m && !/^(Running|Command|Applying)/.test(rest)) return addProse(ts, rest);
    items.push({ kind: "raw", text: line, err: /error|failed|traceback|exception/i.test(line) });
  };
  for (const line of lines) {
    if (lineFilter && !line.toLowerCase().includes(lineFilter)) continue;
    if (file.fmt === "claude" || file.fmt === "codex") {
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          if (file.fmt === "claude") renderClaude(obj);
          else renderCodex(obj);
        }
      } catch {
        renderPlain(line);
      }
    } else renderPlain(line);
  }
  return { items, hiddenServiceCount };
}

export function FeedItem({ item }: { item: Item }) {
  if (item.kind === "prose") {
    const cls = item.engine === "codex" ? "bg-codex" : "bg-claude";
    const icon = item.engine === "codex" ? "⌘" : "✳";
    return (
      <div className="my-3.5 flex gap-2.5">
        <div className={`mt-1 flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-full text-xs font-extrabold text-white ${cls}`}>{icon}</div>
        <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">
          {hhmm(item.ts) ? <div className="mb-0.5 text-[11px] text-dim">{hhmm(item.ts)}</div> : null}
          {md(item.text)}
        </div>
      </div>
    );
  }
  if (item.kind === "user") {
    const long = item.text.length > 500;
    return (
      <div className="my-3.5 flex justify-end">
        <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-2xl bg-user px-4 py-2.5">
          {long ? <details><summary>{item.text.slice(0, 180)}… ({item.text.length} симв.)</summary>{item.text}</details> : item.text}
        </div>
      </div>
    );
  }
  if (item.kind === "cmd") {
    const statusCls = item.call.status === "ok" ? "text-ok" : item.call.status === "err" ? "text-err" : "text-dim";
    return (
      <details className="my-2.5 ml-9 overflow-hidden rounded-[14px] border border-line bg-panel shadow-card" open={item.call.open}>
        <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3.5 py-2">
          <span className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg bg-chip text-[13px]">{item.call.icon}</span>
          <code className="max-w-[70%] overflow-hidden text-ellipsis whitespace-nowrap rounded-md bg-chip px-2 py-0.5 font-mono text-[12.5px]">{item.call.cmd}</code>
          <span className={`ml-auto shrink-0 text-xs font-semibold ${statusCls}`}>{item.call.label}</span>
        </summary>
        <pre className="max-h-[340px] overflow-auto whitespace-pre-wrap border-t border-line bg-[#fafafc] px-3.5 py-2.5 font-mono text-[12.5px]">
          {"$ " + item.call.cmd + (item.call.output ? "\n" + item.call.output : "\n(вивід у цьому лог-файлі відсутній — повний є в rollout-сесії Codex)")}
        </pre>
      </details>
    );
  }
  if (item.kind === "edit") {
    return (
      <div className="my-2.5 ml-9 flex items-center gap-3 rounded-[14px] border border-line bg-panel px-3.5 py-2.5 shadow-card">
        <span className="flex h-7.5 w-7.5 items-center justify-center rounded-lg bg-chip">📝</span>
        <div>
          <div className="text-[13.5px] font-semibold">{item.files}</div>
          <div className="text-xs text-dim">файли змінені</div>
        </div>
      </div>
    );
  }
  if (item.kind === "svc") return <div className="my-1 text-[11.5px] text-dim">{item.text}</div>;
  if (item.kind === "note") return <div className="my-2 text-[12.5px] text-dim">{item.text}</div>;
  return <div className={`my-0.5 text-[12.5px] ${item.err ? "text-err" : "text-[#555]"}`}>{item.text}</div>;
}
