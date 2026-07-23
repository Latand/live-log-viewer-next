export type McpCallIcon =
  | "bot"
  | "message"
  | "task"
  | "pipeline"
  | "link"
  | "conversation"
  | "deploy"
  | "tool";

export type McpCallLink = {
  kind: "conversation" | "pipeline" | "task";
  id: string;
  label: string;
  href: string;
};

export type McpCallDescription = {
  icon: McpCallIcon;
  verb: string;
  title: string;
  subtitle: string;
  links: McpCallLink[];
};

export function isViewerMcpServer(serverName: string): boolean {
  return serverName === "viewer"
    || serverName.startsWith("viewer-")
    || serverName.startsWith("viewer_")
    || serverName === "agent-log-viewer"
    || serverName.startsWith("agent-log-viewer-");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function compact(value: string, limit = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? normalized.slice(0, limit - 1) + "…" : normalized;
}

function conversationLink(result: Record<string, unknown>): McpCallLink[] {
  const id = string(result.conversationId);
  return id ? [{ kind: "conversation", id, label: "Open agent", href: `#c=${encodeURIComponent(id)}` }] : [];
}

function entityId(result: Record<string, unknown>, key: "task" | "pipeline"): string {
  return string(result[`${key}Id`]) || string(record(result[key]).id);
}

function entityLink(kind: "task" | "pipeline", id: string): McpCallLink[] {
  if (!id) return [];
  const label = kind === "task" ? "Open task" : "Open pipeline";
  return [{ kind, id, label, href: `#${kind}=${encodeURIComponent(id)}` }];
}

function replaySubtitle(result: Record<string, unknown>, detail: string): string {
  const replay = result.replay === true || result.replayed === true;
  return [replay ? "Replay" : "", detail].filter(Boolean).join(" · ");
}

export function describeMcpCall(
  toolName: string,
  argsValue: unknown,
  resultValue?: unknown,
): McpCallDescription {
  const args = record(argsValue);
  const result = record(resultValue);

  if (toolName === "spawn_agent") {
    const profile = [string(args.model) || string(args.engine), string(args.effort), string(args.role)]
      .filter(Boolean)
      .join(" ");
    const prompt = compact(string(args.prompt));
    const subject = [profile, prompt].filter(Boolean).join(" · ") || "new worker";
    return {
      icon: "bot",
      verb: "Creating",
      title: `Creating agent: ${subject}`,
      subtitle: string(result.transcriptPath),
      links: conversationLink(result),
    };
  }

  if (toolName === "send_message") {
    const conversationId = string(result.conversationId) || string(args.conversationId);
    return {
      icon: "message",
      verb: "Sending",
      title: `Sending message${conversationId ? ` to ${conversationId}` : ""}: ${compact(string(args.text)) || "message"}`,
      subtitle: replaySubtitle(result, string(result.operationId)),
      links: conversationId
        ? [{ kind: "conversation", id: conversationId, label: "Open conversation", href: `#c=${encodeURIComponent(conversationId)}` }]
        : [],
    };
  }

  if (toolName === "create_task") {
    const id = entityId(result, "task");
    return {
      icon: "task",
      verb: "Creating",
      title: `Creating task: ${compact(string(args.text)) || "untitled task"}`,
      subtitle: replaySubtitle(result, string(args.project)),
      links: entityLink("task", id),
    };
  }

  if (toolName === "update_task") {
    const id = entityId(result, "task") || string(args.taskId);
    const change = string(args.status) || compact(string(args.text)) || "details";
    return {
      icon: "task",
      verb: "Updating",
      title: `Updating task${id ? ` ${id}` : ""}: ${change}`,
      subtitle: replaySubtitle(result, ""),
      links: entityLink("task", id),
    };
  }

  if (toolName === "create_pipeline") {
    const id = entityId(result, "pipeline");
    return {
      icon: "pipeline",
      verb: "Creating",
      title: `Creating pipeline: ${compact(string(args.task)) || "untitled pipeline"}`,
      subtitle: replaySubtitle(result, string(args.repoDir)),
      links: entityLink("pipeline", id),
    };
  }

  if (toolName === "pipeline_action") {
    const id = entityId(result, "pipeline") || string(args.pipelineId);
    const action = string(args.action) || "update";
    const actionVerb: Record<string, string> = {
      start: "Starting",
      pause: "Pausing",
      resume: "Resuming",
      "retry-stage": "Retrying",
      "skip-stage": "Skipping stage in",
      close: "Closing",
      delete: "Deleting",
    };
    return {
      icon: "pipeline",
      verb: actionVerb[action] ?? "Updating",
      title: `${actionVerb[action] ?? "Updating"} pipeline${id ? ` ${id}` : ""}`,
      subtitle: replaySubtitle(result, action),
      links: entityLink("pipeline", id),
    };
  }

  if (toolName === "link_task_to_pipeline") {
    const taskId = string(result.taskId) || string(args.taskId);
    const pipelineId = string(result.pipelineId) || string(args.pipelineId);
    return {
      icon: "link",
      verb: "Linking",
      title: `Linking task to pipeline: ${taskId || "task"} → ${pipelineId || "pipeline"}`,
      subtitle: replaySubtitle(result, ""),
      links: [...entityLink("task", taskId), ...entityLink("pipeline", pipelineId)],
    };
  }

  if (toolName === "list_conversations") {
    const scope = string(args.project) || string(args.query);
    return {
      icon: "conversation",
      verb: "Listing",
      title: `Listing conversations${scope ? `: ${compact(scope)}` : ""}`,
      subtitle: replaySubtitle(result, typeof result.count === "number" ? `${result.count} found` : ""),
      links: [],
    };
  }

  if (toolName === "get_conversation") {
    const conversationId = string(result.conversationId) || string(args.conversationId);
    const transcriptPath = string(result.transcriptPath) || string(args.transcriptPath);
    const links = conversationId
      ? [{ kind: "conversation" as const, id: conversationId, label: "Open conversation", href: `#c=${encodeURIComponent(conversationId)}` }]
      : [];
    return {
      icon: "conversation",
      verb: "Opening",
      title: `Opening conversation: ${conversationId || transcriptPath || "conversation"}`,
      subtitle: replaySubtitle(result, transcriptPath),
      links,
    };
  }

  if (toolName === "deploy_exact_sha") {
    const revision = string(result.revision) || string(args.revision);
    return {
      icon: "deploy",
      verb: "Deploying",
      title: `Deploying revision: ${revision || "current HEAD"}`,
      subtitle: replaySubtitle(result, string(result.deploymentId)),
      links: [],
    };
  }

  if (toolName === "get_pipeline") {
    const id = entityId(result, "pipeline") || string(args.pipelineId);
    return {
      icon: "pipeline",
      verb: "Opening",
      title: `Opening pipeline: ${id || "pipeline"}`,
      subtitle: replaySubtitle(result, string(record(result.pipeline).state)),
      links: entityLink("pipeline", id),
    };
  }

  if (toolName === "board_snapshot") {
    return {
      icon: "conversation",
      verb: "Reading",
      title: `Reading board snapshot${string(args.project) ? `: ${compact(string(args.project))}` : ""}`,
      subtitle: replaySubtitle(result, typeof result.count === "number" ? `${result.count} conversations` : ""),
      links: [],
    };
  }

  if (toolName === "list_flows") {
    return {
      icon: "pipeline",
      verb: "Listing",
      title: `Listing flows${string(args.project) ? `: ${compact(string(args.project))}` : ""}`,
      subtitle: replaySubtitle(result, typeof result.count === "number" ? `${result.count} found` : ""),
      links: [],
    };
  }

  if (toolName === "get_flow") {
    const id = string(args.flowId) || string(result.flowId);
    return {
      icon: "pipeline",
      verb: "Opening",
      title: `Opening flow: ${id || "flow"}`,
      subtitle: replaySubtitle(result, string(record(result.flow).state)),
      links: [],
    };
  }

  if (toolName === "flow_action") {
    const id = string(args.flowId) || string(result.flowId);
    const action = string(args.action);
    const verbs: Record<string, string> = {
      pause: "Pausing",
      resume: "Resuming",
      advance: "Advancing",
      "retry-round": "Retrying",
      "cancel-round": "Cancelling round in",
      extend: "Extending",
      "another-round": "Starting another round in",
      close: "Closing",
    };
    const verb = verbs[action] ?? "Updating";
    return {
      icon: "pipeline",
      verb,
      title: `${verb} flow${id ? ` ${id}` : ""}`,
      subtitle: replaySubtitle(result, action),
      links: [],
    };
  }

  if (toolName === "list_pipelines") {
    return {
      icon: "pipeline",
      verb: "Listing",
      title: `Listing pipelines${string(args.project) ? `: ${compact(string(args.project))}` : ""}`,
      subtitle: replaySubtitle(result, typeof result.count === "number" ? `${result.count} found` : ""),
      links: [],
    };
  }

  if (toolName === "conversation_action") {
    const conversationId = string(result.conversationId) || string(args.conversationId);
    const action = string(args.action);
    const verbs: Record<string, string> = {
      interrupt: "Interrupting",
      kill: "Killing",
      resume: "Resuming",
      compact: "Compacting",
      "dialog-key": "Answering dialog in",
    };
    const verb = verbs[action] ?? "Controlling";
    return {
      icon: "message",
      verb,
      title: `${verb} conversation${conversationId ? ` ${conversationId}` : ""}`,
      subtitle: replaySubtitle(result, string(result.operationId)),
      links: conversationId
        ? [{ kind: "conversation", id: conversationId, label: "Open conversation", href: `#c=${encodeURIComponent(conversationId)}` }]
        : [],
    };
  }

  if (toolName === "operator_snapshot") {
    return {
      icon: "conversation",
      verb: "Reading",
      title: "Reading operator snapshot",
      subtitle: replaySubtitle(result, string(record(result.view).mode)),
      links: [],
    };
  }

  if (toolName === "list_tasks") {
    return {
      icon: "task",
      verb: "Listing",
      title: `Listing tasks${string(args.project) ? `: ${compact(string(args.project))}` : ""}`,
      subtitle: replaySubtitle(result, typeof result.count === "number" ? `${result.count} found` : ""),
      links: [],
    };
  }

  if (toolName === "get_task") {
    const id = entityId(result, "task") || string(args.taskId);
    return {
      icon: "task",
      verb: "Opening",
      title: `Opening task: ${id || "task"}`,
      subtitle: replaySubtitle(result, string(record(result.task).status)),
      links: entityLink("task", id),
    };
  }

  if (toolName === "deployment_status") {
    const id = string(args.deploymentId) || string(result.deploymentId) || string(args.operationId) || string(result.operationId);
    return {
      icon: "deploy",
      verb: "Reading",
      title: `Reading deployment status${id ? `: ${id}` : ""}`,
      subtitle: replaySubtitle(result, string(record(result.deployment).state) || string(record(record(result.operation).receipt).status)),
      links: [],
    };
  }

  if (toolName === "resources") {
    return {
      icon: "tool",
      verb: "Reading",
      title: "Reading resources",
      subtitle: replaySubtitle(result, Array.isArray(result.sessions) ? `${result.sessions.length} sessions` : ""),
      links: [],
    };
  }

  if (toolName === "conversation_migration") {
    const conversationId = string(result.conversationId) || string(args.conversationId);
    const action = string(args.action);
    const verbs: Record<string, string> = { reseat: "Reseating", retry: "Retrying", rollback: "Rolling back" };
    const verb = verbs[action] ?? "Migrating";
    return {
      icon: "conversation",
      verb,
      title: `${verb} conversation migration${conversationId ? ` for ${conversationId}` : ""}`,
      subtitle: replaySubtitle(result, string(result.operationId)),
      links: conversationId
        ? [{ kind: "conversation", id: conversationId, label: "Open conversation", href: `#c=${encodeURIComponent(conversationId)}` }]
        : [],
    };
  }

  return {
    icon: "tool",
    verb: "Running",
    title: `Running MCP tool: ${toolName || "unknown"}`,
    subtitle: "",
    links: [],
  };
}
