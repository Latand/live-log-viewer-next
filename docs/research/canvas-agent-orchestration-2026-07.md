# Canvas Agent Orchestration Research, July 2026

## TL;DR

- The closest spatial analogue is VibeCraft: local coding agents, folders, terminals, and browsers on one shared canvas. Source: https://github.com/rayzhudev/vibecraft
- The closest agent-control analogue is OpenHands Agent Canvas: one browser UI for agent conversations, file changes, tool calls, backends, and automations. Source: https://docs.openhands.dev/openhands/usage/agent-canvas/overview
- Conductor, Vibe Kanban, Claude Squad, Nimbalyst, and dux converge on isolated workspaces, branches/worktrees, live terminals, diff review, and PR handoff. Sources: https://www.conductor.build/docs, https://github.com/BloopAI/vibe-kanban, https://github.com/smtg-ai/claude-squad, https://nimbalyst.com/, https://github.com/patrickdappollonio/dux
- Board-native AI tools point to a useful pattern: select visible objects, run an action, write results back onto the board. Sources: https://makereal.tldraw.com/, https://computer.tldraw.com/, https://github.com/whq25/agent-canvas
- Sticky notes should behave like operational objects: anchored to sessions, color-coded by meaning, and convertible into prompts or review tasks. Sources: https://tldraw.dev/sdk-features/default-shapes, https://help.miro.com/hc/en-us/articles/360017572054-Sticky-notes
- Lasso selection and bulk operations are established board patterns in Miro/FigJam and map cleanly to agent fleets. Sources: https://help.miro.com/hc/en-us/articles/360017730953-Working-with-objects, https://help.figma.com/hc/en-us/articles/1500004292221-Select-move-and-order-objects-in-FigJam
- People running fleets ask for attention routing, ownership boundaries, state recovery, cost tracking, and review queues. Sources: https://www.augmentcode.com/guides/agent-observability-for-ai-coding, https://www.reddit.com/r/ClaudeCode/comments/1st213z/how_are_you_managing_multiple_coding_agents_in/
- "PyDotDev" is most plausibly Pi Coding Agent at pi.dev in this context, because pi.dev has voice/transcription packages for a coding agent; Pydantic AI is also relevant as a typed agent framework. Sources: https://pi.dev/packages/%40p8n.ai/pi-listens, https://pydantic.dev/docs/ai/overview/

## Prior-Art Table

| Tool | Link | What it is | Board/canvas? | Ideas worth stealing |
|---|---|---|---|---|
| Conductor | https://www.conductor.build/docs | Mac app for running Claude Code, Codex, and Cursor in parallel; each task gets a workspace, branch, files, terminal, diff, and review path. | Fleet dashboard/workspaces; no spatial board shown in docs. | Treat each agent as a full work package: workspace, branch, terminal, diff, review path. Add "archive workspace" lifecycle. |
| Vibe Kanban | https://github.com/BloopAI/vibe-kanban | Open-source kanban for planning agent work, creating agent workspaces, reviewing diffs, previewing apps, and opening PRs. | Kanban board; no infinite canvas. | Keep planning and review on the same surface; send inline diff comments back to the agent. |
| Crystal / Nimbalyst | https://github.com/stravu/crystal, https://nimbalyst.com/ | Crystal was a multi-session AI code assistant manager; Nimbalyst adds visual editors, session kanban, inline diffs, task tracking, and mobile session management. | Kanban plus visual workspace; Nimbalyst claims infinite-canvas idea maps. | Show active/waiting/completed sessions, file changes, and visual artifacts together; mobile resume with typed or voice notes. |
| Claude Squad | https://github.com/smtg-ai/claude-squad | Terminal app managing multiple Claude Code, Codex, Gemini, Aider, and other agents in separate tmux/worktree sessions. | Terminal list/diff UI. | Keyboard-first session commands: create, kill, attach, checkout, resume, commit/push; simple status list. |
| Cursor Cloud Agents | https://cursor.com/docs/cloud-agent, https://linear.app/changelog/2025-08-21-cursor-agent | Cloud/background agents that work from repo context, including Linear issue delegation. | Task/session UI; no spatial board in public docs. | Delegation from an issue/task card with full context; cloud task progress as first-class session state. |
| Devin | https://docs.devin.ai/work-with-devin/devin-review | Autonomous coding agent with sessions and PR-review modes; docs describe auto, PR-creation, and manual review triggers. | Session/review dashboard; no board found in docs. | Review triggers and PR feedback loops should be configurable per workflow. |
| OpenHands Agent Canvas | https://docs.openhands.dev/openhands/usage/agent-canvas/overview | Browser UI and backend server for running agents and automations; conversations include message history, tool calls, and file changes. | Product name says Canvas; public docs emphasize browser control surface, backends, and automations. | Treat backend connections, conversations, and automations as visible primitives; support local, remote, and cloud backends. |
| Langflow | https://docs.langflow.org/concepts-overview | Visual editor for creating, testing, and sharing flows made from connected components. | Node canvas for functional workflows. | Use an in-canvas assistant that understands graph structure and can build or edit flows from natural language. Source: https://docs.langflow.org/langflow-assistant |
| Flowise Agentflow V2 | https://docs.flowiseai.com/using-flowise/agentflowv2 | Visual builder for agentic systems; supports supervisor/worker agent communication. | Node canvas/workflow editor. | Make supervisor/worker relationships explicit; render agent-to-agent handoffs and returned outputs. |
| Rivet | https://rivet.ironcladapp.com/docs/getting-started/first-ai-agent | Visual AI programming environment for LLM prompt graphs. | Blank infinite-style node canvas for prompt graphs. | Right-click/space add menu on the canvas; every executable thing is a node with inspectable inputs/outputs. |
| n8n | https://docs.n8n.io/, https://n8n.io/ai-agents/ | Workflow automation tool with AI agents, memory, goals, and many integrations. | Workflow canvas. | Use templates for recurring automations and make triggers visible as entry nodes. |
| LangSmith / LangGraph Studio | https://docs.langchain.com/langsmith/studio | Specialized agent IDE for visualizing, interacting with, and debugging agentic systems implementing the Agent Server API. | Graph mode plus chat mode. | Add execution replay and trace-linked graph view; support breakpoints/interrupts for agent flows. |
| AutoGen Studio | https://microsoft.github.io/autogen/dev/user-guide/autogenstudio-user-guide/index.html | Low-code interface for prototyping multi-agent workflows and demonstrating AutoGen UIs. | Workflow builder; production caveats in docs. | Good for editable team topologies and agent skill composition; keep security/auth boundaries explicit for any exposed orchestrator. |
| CrewAI / Crew Studio | https://docs.crewai.com/, https://docs.crewai.com/v1.15.1/en/enterprise/features/crew-studio | Framework and enterprise visual workspace for multi-agent automations, roles, tasks, tools, guardrails, memory, and observability. | Visual workflow editor in Crew Studio. | Model role, task, tool, and guardrail assignments as first-class board objects. |
| tldraw Make Real | https://makereal.tldraw.com/, https://github.com/tldraw/make-real-starter | Select a drawn UI mockup and generate a working HTML file through an AI model. | Infinite canvas. | "Select shapes -> run AI action -> create artifact" is directly transferable to "select agents/notes -> send instruction -> create follow-up nodes." |
| tldraw computer | https://computer.tldraw.com/ | Visual programs on an infinite canvas using connected interactive components and AI. | Infinite canvas. | Treat components as live values; show execution/state inside the node, with sidebars reserved for drill-down. |
| tldraw SDK | https://tldraw.dev/sdk-features/default-shapes | Infinite canvas SDK with default note, arrow, binding, shape, and navigation primitives. | Infinite canvas SDK. | Use bindings so notes/arrows stay attached as agent nodes move; use clone handles for rapid adjacent notes. |
| Excalidraw | https://github.com/excalidraw/excalidraw, https://libraries.excalidraw.com/ | Open-source hand-drawn whiteboard; sticky-note libraries and text-to-diagram use cases exist. | Infinite whiteboard. | Keep annotations lightweight, low-friction, and exportable as portable JSON/Markdown artifacts. |
| Excalidraw MCP / agent-canvas | https://github.com/yctimlin/mcp_excalidraw, https://github.com/whq25/agent-canvas | Programmatic Excalidraw canvas control for AI agents; WHQ25 agent-canvas is "Excalidraw for AI agents" with bidirectional manual and agent edits. | Excalidraw canvas. | Let humans and agents edit the same board; agents should read current board structure without screenshot-only guessing. |
| Miro | https://help.miro.com/hc/en-us/articles/360017572054-Sticky-notes, https://help.miro.com/hc/en-us/articles/360017730953-Working-with-objects | Collaborative whiteboard with sticky notes, frames, lasso/precise selection, grouping, locking, and object menus. | Infinite board. | 90% lasso inclusion rule, object action menu, limited accessible sticky-note color palette. |
| FigJam | https://help.figma.com/hc/en-us/articles/1500004414322-Sticky-notes-in-FigJam, https://help.figma.com/hc/en-us/articles/1500004292221-Select-move-and-order-objects-in-FigJam | Collaborative board with sticky notes, drag selection, color palettes, and bulk editing. | Infinite board. | Sticky-note stacks, drag selection, bulk edits, and colors as lightweight team semantics. |
| Websim | https://websim.com/, https://websim.com/blog | AI app/game/page creation and sharing platform. | Creation surface, community/remix model; no agent fleet board found. | Remix/fork history and public artifact previews are useful for agent output comparison. |
| VibeCraft | https://github.com/rayzhudev/vibecraft, https://vibecraft.build/ | RTS-style workspace for managing local Claude Code and Codex agents; agents, folders, terminals, and browsers live on one shared canvas. | Yes, shared canvas. | Spatially arrange agents by project/mission, co-locate terminals/browsers, add OS notifications when agents finish. |
| dux | https://github.com/patrickdappollonio/dux, https://www.patrickdap.com/post/how-to-run-multiple-agents/ | Terminal UI for multiple AI coding agents in git worktrees with companion terminals, macros, commit generation, and command palette. | Terminal dashboard. | Macros and command palette for repeated multi-agent operations; worktree-first mental model. |
| Agent Deck | https://github.com/asheshgoplani/agent-deck | Terminal mission-control UI for many AI coding sessions, with groups, search, forking, worktrees, phone control, and cost tracking. | Terminal dashboard. | Global cost dashboard, groups, search, session forking, and phone-controlled conductor mode. |
| Agent Teams | https://code.claude.com/docs/en/agent-teams | Claude Code team orchestration with shared tasks, inter-agent messaging, and centralized management. | Agent team control surface; no spatial board shown. | Broadcast/direct messages, shared task list, clean shutdown protocol, and team-lead/worker roles. |

## Deep Dive: Three Closest Analogues

### 1. VibeCraft

VibeCraft is the closest public analogue for Live Log Viewer's "scheme board" idea because its README describes an RTS-style workspace where agents, folders, terminals, and browsers live on one shared canvas. Source: https://github.com/rayzhudev/vibecraft

The UX direction is spatial command: a user can arrange coding-agent sessions beside the folders, browsers, and terminals that matter for a mission. Source: https://vibecraft.build/

Transferable decisions:

- Keep operational context near the agent node: terminal, browser, folder, status, and notifications should sit in the same visual cluster. Source: https://github.com/rayzhudev/vibecraft
- Use the game/RTS metaphor only for control density: selectable units, visible status, and group commands. Source: https://www.reddit.com/r/ClaudeCode/comments/1rjds4r/my_rts_style_vibecoding_interface_is_now/
- Add explicit grouping regions for "missions" or "fronts" so users can drag several agents into a working area and scan their current state together. Source: https://github.com/rayzhudev/vibecraft

Gap for Live Log Viewer: public VibeCraft material is thin on review queues, transcript parsing, parent-child agent lineage, and local transcript fidelity. Live Log Viewer already has those raw materials in its scanner and scheme layout.

### 2. OpenHands Agent Canvas

OpenHands Agent Canvas is the closest public analogue for a browser-based agent control plane. It defines Agent Canvas as a UI plus backend server; a conversation has message history, tool calls, and file changes; automations can run from cron, GitHub, Linear, Slack, or webhooks. Source: https://docs.openhands.dev/openhands/usage/agent-canvas/overview

The key UX lesson is that agent work needs three visible object types: backend, conversation, and automation. Source: https://docs.openhands.dev/openhands/usage/agent-canvas/overview

Transferable decisions:

- Let the board show where each agent is running: local tmux, resumed local session, or remote backend if Live Log Viewer ever grows beyond local roots. Source: https://docs.openhands.dev/openhands/usage/agent-canvas/overview
- Make automations visible as board objects that can start sessions: cron review, GitHub issue triage, Linear ticket import, or "nightly reviewer". Source: https://docs.openhands.dev/openhands/usage/agent-canvas/overview
- Link every conversation card to message history, tool calls, and file changes; this maps well to Live Log Viewer's transcript and scanner contracts. Source: https://docs.openhands.dev/openhands/usage/agent-canvas/overview

Gap for Live Log Viewer: OpenHands public docs describe Canvas primarily as a browser UI/control surface. Live Log Viewer has a richer spatial board requirement: parent-child edges, minimap, camera state, and direct tmux operations.

### 3. Conductor / Vibe Kanban / Nimbalyst Cluster

Conductor, Vibe Kanban, and Nimbalyst describe the mainstream 2026 shape of coding-agent orchestration: isolated workspaces or worktrees, branches, terminals, diffs, review, PRs, task tracking, and session status. Sources: https://www.conductor.build/docs, https://github.com/BloopAI/vibe-kanban, https://nimbalyst.com/

Conductor's docs compress the pattern well: each task has its own workspace, branch, files, terminal, diff, and review path. Source: https://www.conductor.build/docs

Vibe Kanban adds planning and review on a kanban surface, including inline diff comments sent directly back to the agent. Source: https://github.com/BloopAI/vibe-kanban

Nimbalyst adds visual editors and explicit session state: active, waiting, completed, modified files, kanban board, optional worktree isolation, and mobile session management. Source: https://nimbalyst.com/

Transferable decisions:

- Add a "review lane" overlay on the spatial board: agents with changed files get a visible review badge and can be filtered into a review queue. Sources: https://www.conductor.build/docs, https://github.com/BloopAI/vibe-kanban
- Attach changed-file summaries to agent nodes; Nimbalyst emphasizes showing exactly what each session changed. Source: https://nimbalyst.com/
- Add "send feedback to selected agent(s)" from a diff or note, following Vibe Kanban's inline comment feedback loop. Source: https://github.com/BloopAI/vibe-kanban
- Expose lifecycle actions as simple verbs: create, pause, resume, kill, review, PR, archive. Sources: https://github.com/smtg-ai/claude-squad, https://www.conductor.build/docs

Gap for Live Log Viewer: these tools mostly use list/kanban/terminal mental models. Live Log Viewer can make lineage, attention, group selection, and parallel loops easier to see through spatial layout.

## What Is "PyDotDev"?

The most plausible match is Pi Coding Agent at `pi.dev`, because the user mentioned voice transcription and pi.dev currently has coding-agent packages such as `@p8n.ai/pi-listens`, `pi-voice-loop`, and `pi-xai-voice` that expose voice input, transcription, TTS, live transcript preview, and UI fallback behavior. Sources: https://pi.dev/packages/%40p8n.ai/pi-listens, https://pi.dev/packages/pi-voice-loop, https://pi.dev/packages/pi-xai-voice

Pi Coding Agent appears to be an extensible coding-agent harness with packages/extensions; the package catalog lists Pi-specific extensions for memory, observability, web search, voice, permissions, and other agent behaviors. Source: https://pi.dev/packages

Transferable ideas from Pi:

- Voice notes as first-class control input for agents: record, transcribe, preview, then send into the selected session. Source: https://pi.dev/packages/%40p8n.ai/pi-listens
- Fallback input events when speech recognition fails; this maps to Live Log Viewer's composer and board notes. Source: https://pi.dev/packages/%40p8n.ai/pi-listens
- Extension-package model for capabilities such as memory, observability, and voice. Source: https://pi.dev/packages

The second plausible match is Pydantic AI at `ai.pydantic.dev` / Pydantic docs. Pydantic AI is a Python agent framework for production-grade GenAI apps and workflows, with typed agents, tools, structured output, and Logfire observability. Sources: https://pydantic.dev/docs/ai/overview/, https://pydantic.dev/pydantic-ai

Pydantic AI has no public board/orchestration UI in the docs found during this pass. It is still useful for typed outputs, trace metadata, and agent run observability concepts. Sources: https://pydantic.dev/docs/ai/core-concepts/agent/, https://pydantic.dev/pydantic-ai

## Sticky Notes and Annotations on Ops Boards

tldraw's note shape is a useful base pattern: colored background, rich text, clone handles for adjacent notes, keyboard navigation between notes, fixed base size, and vertical growth with content. Source: https://tldraw.dev/sdk-features/default-shapes

tldraw arrows can bind to shapes and automatically update as connected shapes move; this gives Live Log Viewer a ready pattern for notes that follow agent nodes or edges. Source: https://tldraw.dev/sdk-features/default-shapes

Miro gives sticky notes a constrained accessible palette and approximately 3,000 characters per sticky note, which suggests bounded note bodies with predictable readability. Source: https://help.miro.com/hc/en-us/articles/360017572054-Sticky-notes

Miro's developer API treats sticky notes as board items for quick notes, brainstorming, and visual information structure; Live Log Viewer can treat notes as persisted board items with metadata such as target session path, color, author, and action state. Source: https://developers.miro.com/docs/websdk-reference-sticky-note

FigJam sticky notes use a set palette, random initial user color, and toolbar stack behavior; this supports color-as-author or color-as-status patterns. Source: https://help.figma.com/hc/en-us/articles/1500004414322-Sticky-notes-in-FigJam

Excalidraw history shows sticky notes came from binding text to containers and low-friction typing on colored notes; the same model is enough for a first Live Log Viewer annotation layer. Sources: https://plus.excalidraw.com/blog/year-two, https://github.com/excalidraw/excalidraw/issues/1428

Agent-tool examples show notes can become prompts. Make Real captures selected shapes and sends them to a model to create HTML; Excalidraw agent-canvas lets manual edits and agent edits happen bidirectionally. Sources: https://github.com/tldraw/make-real-starter, https://github.com/whq25/agent-canvas

Recommended sticky-note semantics for Live Log Viewer:

- Yellow: human reminder or TODO attached to a session. Source inspiration: https://help.miro.com/hc/en-us/articles/360017572054-Sticky-notes
- Red/coral: blocker or human input needed, especially when scanner detects pending questions. Source inspiration: https://help.figma.com/hc/en-us/articles/1500004291341-Apply-colors-in-FigJam
- Teal/green: accepted outcome or verified finding. Source inspiration: https://help.figma.com/hc/en-us/articles/1500004291341-Apply-colors-in-FigJam
- Violet/blue: prompt note that can be sent to one or several agents. Source inspiration: https://makereal.tldraw.com/
- Gray: archived context note with no active operation. Source inspiration: https://help.miro.com/hc/en-us/articles/360017572054-Sticky-notes

## Group Operations on Agent Fleets

Miro's lasso tool selects multiple objects when at least 90% of each object is inside the lasso area, then the selection can be moved, resized, aligned, grouped, locked, or filtered. Source: https://help.miro.com/hc/en-us/articles/360017730953-Working-with-objects

FigJam supports drag selection and bulk editing once multiple objects are selected. Sources: https://help.figma.com/hc/en-us/articles/1500004292221-Select-move-and-order-objects-in-FigJam, https://help.figma.com/hc/en-us/articles/21635177948567-Edit-objects-on-the-canvas-in-bulk

Claude Agent Teams explicitly supports shared tasks, inter-agent messaging, centralized management, direct messages, broadcasts, and team-level coordination. Source: https://code.claude.com/docs/en/agent-teams

A community walkthrough of Claude Agent Teams describes broadcast messages to all teammates and a shutdown-request/response protocol. Source: https://www.reddit.com/r/ClaudeCode/comments/1qz8tyy/how_to_set_up_claude_code_agent_teams_full/

OpenHands SDK documentation includes an orchestrator delegating parallel tool execution to multiple sub-agents, which supports a board action like "run this instruction against selected agents." Source: https://docs.openhands.dev/sdk/guides/parallel-tool-execution

Evidence of demand for group operations appears in user discussions: users running three to five agents report duplicated work, contradictions, lost state after restart/compaction, ownership confusion, handoff friction, and difficulty knowing when to intervene. Sources: https://www.reddit.com/r/AI_Agents/comments/1ry7qmc/when_running_multiple_agents_in_parallel_how_do/, https://www.reddit.com/r/ClaudeCode/comments/1st213z/how_are_you_managing_multiple_coding_agents_in/

Transferable group actions for Live Log Viewer:

- Lasso selected agents -> send broadcast message. Sources: https://help.miro.com/hc/en-us/articles/360017730953-Working-with-objects, https://code.claude.com/docs/en/agent-teams
- Lasso selected agents -> pause/interrupt/kill with confirmation. Sources: https://github.com/smtg-ai/claude-squad, https://code.claude.com/docs/en/agent-teams
- Lasso selected agents -> assign color/status/mission label. Sources: https://help.figma.com/hc/en-us/articles/21635177948567-Edit-objects-on-the-canvas-in-bulk, https://help.miro.com/hc/en-us/articles/360017730973-Structuring-board-content
- Lasso selected agents -> create review queue from all changed files. Sources: https://github.com/BloopAI/vibe-kanban, https://nimbalyst.com/
- Lasso selected agents -> fork comparison: same prompt to Codex/Claude/OpenCode, then compare diffs. Sources: https://www.conductor.build/docs, https://github.com/patrickdappollonio/dux

## Orchestrator's Cockpit Needs

Attention routing is the highest-value cockpit feature. Nimbalyst mobile docs mention push notifications when sessions complete, hit errors, or need approval; AgentShell markets notifications for CLI agents waiting on input; Cursor users ask for notifications when a CLI agent waits for input. Sources: https://docs.nimbalyst.com/getting-started/quickstart, https://apps.apple.com/us/app/agentshell/id6758352690, https://forum.cursor.com/t/notification-when-a-cli-agent-needs-input/152166

Cost and token burn need a persistent board-level readout. Agent Deck advertises real-time token/cost tracking across sessions; Augment says a four-hour multi-agent coding session can produce 180+ tool calls and tens of dollars in token spend; Oodle AI and LangChain market cross-agent cost/session/tool tracking. Sources: https://github.com/asheshgoplani/agent-deck, https://www.augmentcode.com/guides/agent-observability-for-ai-coding, https://oodle.ai/product/ai-cost-management, https://www.langchain.com/blog/fix-your-coding-agent-bill

Ownership boundaries matter because worktree-based parallel agents exist to avoid file conflicts; Claude Squad, Conductor, Vibe Kanban, and dux all center isolated workspaces/worktrees. Sources: https://github.com/smtg-ai/claude-squad, https://www.conductor.build/docs, https://github.com/BloopAI/vibe-kanban, https://github.com/patrickdappollonio/dux

Review queues are part of the control surface. Conductor, Vibe Kanban, and Nimbalyst all connect agent sessions to diffs and review paths. Sources: https://www.conductor.build/docs, https://github.com/BloopAI/vibe-kanban, https://nimbalyst.com/

Replay and timeline are needed for accountability. LangSmith Studio integrates visualization, interaction, debugging, tracing, evaluation, and prompt engineering; Augment frames the core observability questions as who wrote the broken code, what context they had, and cost. Sources: https://docs.langchain.com/langsmith/studio, https://www.augmentcode.com/guides/agent-observability-for-ai-coding

Templates and recurring pipelines are common in workflow tools. n8n positions agents inside automation workflows; OpenHands Agent Canvas supports cron/event automations; CrewAI documents roles, tasks, tools, guardrails, memory, and observability. Sources: https://n8n.io/ai-agents/, https://docs.openhands.dev/openhands/usage/agent-canvas/overview, https://docs.crewai.com/

State recovery and resumability are active pain points. Reddit users discuss state evaporating after restart/compaction and agents duplicating work; Durable workflow engines emphasize checkpointed loops and resumed execution after crashes. Sources: https://www.reddit.com/r/AI_Agents/comments/1ry7qmc/when_running_multiple_agents_in_parallel_how_do/, https://conductor-oss.github.io/conductor/devguide/ai/why-conductor.html

## Ranked Feature Ideas for Live Log Viewer

| Rank | Feature | Impact | Effort | Source inspiration |
|---:|---|---|---|---|
| 1 | Attention overlay: badge every node as working, waiting for input, blocked, errored, done, review-ready; add "show only needs me." | Very high | Medium | Nimbalyst notifications, AgentShell, Cursor CLI notification request: https://docs.nimbalyst.com/getting-started/quickstart, https://apps.apple.com/us/app/agentshell/id6758352690, https://forum.cursor.com/t/notification-when-a-cli-agent-needs-input/152166 |
| 2 | Sticky notes anchored to agent nodes or edges; notes move with target and can detach. | High | Medium | tldraw notes/arrows/bindings, Miro sticky notes: https://tldraw.dev/sdk-features/default-shapes, https://help.miro.com/hc/en-us/articles/360017572054-Sticky-notes |
| 3 | Note -> prompt action: send note text to one selected agent, all children, or lasso selection. | High | Medium | Make Real select-and-run pattern; Claude Agent Teams broadcast: https://makereal.tldraw.com/, https://code.claude.com/docs/en/agent-teams |
| 4 | Lasso select agent nodes with contextual bulk menu: message, interrupt, kill, label, create review queue. | High | Medium | Miro lasso and FigJam bulk edit: https://help.miro.com/hc/en-us/articles/360017730953-Working-with-objects, https://help.figma.com/hc/en-us/articles/21635177948567-Edit-objects-on-the-canvas-in-bulk |
| 5 | Mission zones: drawn frames/regions that group agents, notes, terminals, and review artifacts. | High | Medium | VibeCraft shared canvas; Miro grouping/frames: https://github.com/rayzhudev/vibecraft, https://help.miro.com/hc/en-us/articles/360017730973-Structuring-board-content |
| 6 | Review queue lane on the board: cards for changed files, diff status, reviewer verdict, PR link. | High | High | Conductor, Vibe Kanban, Nimbalyst: https://www.conductor.build/docs, https://github.com/BloopAI/vibe-kanban, https://nimbalyst.com/ |
| 7 | Cost/token strip per node and aggregate per selected group/project. | High | Medium/High | Agent Deck and Augment observability: https://github.com/asheshgoplani/agent-deck, https://www.augmentcode.com/guides/agent-observability-for-ai-coding |
| 8 | Replay timeline: scrub a session or whole branch group over time, showing messages, tool calls, file changes, and status transitions. | High | High | LangSmith Studio and Augment: https://docs.langchain.com/langsmith/studio, https://www.augmentcode.com/guides/agent-observability-for-ai-coding |
| 9 | Templates for recurring pipelines: implement -> review, issue triage -> fix, research -> plan -> implement, refactor fan-out. | Medium/High | Medium | OpenHands automations, n8n workflows, CrewAI roles/tasks: https://docs.openhands.dev/openhands/usage/agent-canvas/overview, https://n8n.io/ai-agents/, https://docs.crewai.com/ |
| 10 | Compare/fan-out mode: spawn the same task to several engines or prompts, then cluster outputs and diffs. | Medium/High | High | Conductor, Claude Squad, dux: https://www.conductor.build/docs, https://github.com/smtg-ai/claude-squad, https://github.com/patrickdappollonio/dux |
| 11 | Board assistant command palette: "select stuck agents", "summarize this cluster", "create note from latest blocker", "send review prompt to children." | Medium | Medium | Langflow Assistant and tldraw computer: https://docs.langflow.org/langflow-assistant, https://computer.tldraw.com/ |
| 12 | Mobile/remote compact control: active/waiting/done list plus send voice/text note to selected agent. | Medium | High | Nimbalyst mobile and Pi voice extensions: https://docs.nimbalyst.com/getting-started/quickstart, https://pi.dev/packages/%40p8n.ai/pi-listens |
| 13 | Shutdown protocol for selected group: request shutdown, wait for confirmation, then kill leftovers after timeout. | Medium | Medium | Claude Agent Teams shutdown flow described by community and central management docs: https://www.reddit.com/r/ClaudeCode/comments/1qz8tyy/how_to_set_up_claude_code_agent_teams_full/, https://code.claude.com/docs/en/agent-teams |
| 14 | Board-level search and filters: engine, project, branch, model, changed files, blocker text, pending question. | Medium | Low/Medium | Agent Deck groups/search and Nimbalyst session dashboard: https://github.com/asheshgoplani/agent-deck, https://nimbalyst.com/ |
| 15 | Canvas-readable annotations for agents: export selected board cluster as structured context JSON and paste it into an agent. | Medium | High | Excalidraw agent-canvas bidirectional structure and tldraw SDK runtime API: https://github.com/whq25/agent-canvas, https://tldraw.dev/ |

## If We Copy Many Decisions From One Tool

The closest single product reference is OpenHands Agent Canvas for the orchestrator model: one browser UI connected to backends; conversations as objects with message history, tool calls, and file changes; automations as first-class triggers; local/self-hosted/cloud deployment options. Source: https://docs.openhands.dev/openhands/usage/agent-canvas/overview

For spatial mechanics, pair that with VibeCraft's shared-canvas premise and tldraw/Miro interaction patterns: agents and operational objects on one board, sticky notes with bindings, lasso selection, object menus, and grouped regions. Sources: https://github.com/rayzhudev/vibecraft, https://tldraw.dev/sdk-features/default-shapes, https://help.miro.com/hc/en-us/articles/360017730953-Working-with-objects

The resulting model for Live Log Viewer:

- Conversation node: transcript, pane, status, model, path, changed files. Source inspiration: https://docs.openhands.dev/openhands/usage/agent-canvas/overview
- Workspace/branch node: ownership and conflict boundary. Source inspiration: https://www.conductor.build/docs
- Note node: human intent, blocker, prompt, or review instruction. Source inspiration: https://tldraw.dev/sdk-features/default-shapes
- Automation node: scheduled or event-driven starter for repeatable loops. Source inspiration: https://docs.openhands.dev/openhands/usage/agent-canvas/overview
- Selection group: temporary action scope for broadcast, stop, review, label, or summarize. Source inspiration: https://help.miro.com/hc/en-us/articles/360017730953-Working-with-objects
- Review lane: spatially attached queue for diffs and verdicts. Source inspiration: https://github.com/BloopAI/vibe-kanban

## Source Index

- Conductor docs: https://www.conductor.build/docs
- Vibe Kanban: https://github.com/BloopAI/vibe-kanban
- Vibe Kanban HN launch: https://news.ycombinator.com/item?id=44533004
- Crystal / Nimbalyst: https://github.com/stravu/crystal, https://nimbalyst.com/
- Nimbalyst mobile quickstart: https://docs.nimbalyst.com/getting-started/quickstart
- Claude Squad: https://github.com/smtg-ai/claude-squad
- Cursor Cloud Agents: https://cursor.com/docs/cloud-agent
- Linear Cursor agent changelog: https://linear.app/changelog/2025-08-21-cursor-agent
- Devin Review: https://docs.devin.ai/work-with-devin/devin-review
- OpenHands Agent Canvas: https://docs.openhands.dev/openhands/usage/agent-canvas/overview
- OpenHands parallel tool execution: https://docs.openhands.dev/sdk/guides/parallel-tool-execution
- Langflow visual editor: https://docs.langflow.org/concepts-overview
- Langflow Assistant: https://docs.langflow.org/langflow-assistant
- Flowise Agentflow V2: https://docs.flowiseai.com/using-flowise/agentflowv2
- Rivet first agent: https://rivet.ironcladapp.com/docs/getting-started/first-ai-agent
- n8n docs and AI agents: https://docs.n8n.io/, https://n8n.io/ai-agents/
- LangSmith Studio: https://docs.langchain.com/langsmith/studio
- AutoGen Studio: https://microsoft.github.io/autogen/dev/user-guide/autogenstudio-user-guide/index.html
- CrewAI docs and Crew Studio: https://docs.crewai.com/, https://docs.crewai.com/v1.15.1/en/enterprise/features/crew-studio
- tldraw Make Real: https://makereal.tldraw.com/, https://github.com/tldraw/make-real-starter
- tldraw computer: https://computer.tldraw.com/
- tldraw SDK shapes: https://tldraw.dev/sdk-features/default-shapes
- Excalidraw: https://github.com/excalidraw/excalidraw, https://libraries.excalidraw.com/, https://plus.excalidraw.com/blog/year-two
- Excalidraw MCP and agent-canvas: https://github.com/yctimlin/mcp_excalidraw, https://github.com/whq25/agent-canvas
- Miro sticky notes and lasso: https://help.miro.com/hc/en-us/articles/360017572054-Sticky-notes, https://help.miro.com/hc/en-us/articles/360017730953-Working-with-objects
- FigJam sticky notes and bulk selection: https://help.figma.com/hc/en-us/articles/1500004414322-Sticky-notes-in-FigJam, https://help.figma.com/hc/en-us/articles/1500004292221-Select-move-and-order-objects-in-FigJam, https://help.figma.com/hc/en-us/articles/21635177948567-Edit-objects-on-the-canvas-in-bulk
- Websim: https://websim.com/, https://websim.com/blog
- VibeCraft: https://github.com/rayzhudev/vibecraft, https://vibecraft.build/
- dux: https://github.com/patrickdappollonio/dux, https://www.patrickdap.com/post/how-to-run-multiple-agents/
- Agent Deck: https://github.com/asheshgoplani/agent-deck
- Claude Agent Teams: https://code.claude.com/docs/en/agent-teams
- Pi Coding Agent voice packages: https://pi.dev/packages/%40p8n.ai/pi-listens, https://pi.dev/packages/pi-voice-loop, https://pi.dev/packages/pi-xai-voice
- Pi package catalog: https://pi.dev/packages
- Pydantic AI: https://pydantic.dev/docs/ai/overview/, https://pydantic.dev/docs/ai/core-concepts/agent/, https://pydantic.dev/pydantic-ai
- Augment agent observability: https://www.augmentcode.com/guides/agent-observability-for-ai-coding
- Oodle AI cost tracking: https://oodle.ai/product/ai-cost-management
- LangChain coding-agent bill tracing: https://www.langchain.com/blog/fix-your-coding-agent-bill
- Cursor CLI notification request: https://forum.cursor.com/t/notification-when-a-cli-agent-needs-input/152166
- AgentShell App Store: https://apps.apple.com/us/app/agentshell/id6758352690
- Multi-agent pain discussions: https://www.reddit.com/r/AI_Agents/comments/1ry7qmc/when_running_multiple_agents_in_parallel_how_do/, https://www.reddit.com/r/ClaudeCode/comments/1st213z/how_are_you_managing_multiple_coding_agents_in/
- Durable agent loops: https://conductor-oss.github.io/conductor/devguide/ai/why-conductor.html
