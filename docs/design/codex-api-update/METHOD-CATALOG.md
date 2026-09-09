# Installed method catalog

Generated from Codex 0.153.4. Default-schema membership is not a guarantee that every field, backend, or account supports a method. Experimental methods require `initialize.capabilities.experimentalApi: true`.

Source references are literal matches in product source at the pinned Viewer HEAD. They locate candidates for inspection; they do not prove the method executes or is fully supported. The design report gives the behavior and adoption decision.

| Method | Schema | Viewer reference | Disposition |
|---|---|---|---|
| `initialize` | default | `src/lib/accounts/codexAppServer.ts:278`, `src/lib/runtime/codexAppServerHost.ts:1276` | Connection identity and capability admission |
| `server/diagnostics` | experimental | No literal match | Optional content-free diagnostics; no replacement lifecycle authority |
| `thread/start` | default | `src/lib/runtime/codexAppServerHost.ts:355` | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/resume` | default | `src/lib/accounts/codexAppServer.ts:409`, `src/lib/runtime/codexAppServerHost.ts:329` | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/fork` | default | `src/lib/accounts/codexAppServer.ts:371` | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/archive` | default | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/delete` | default | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/unsubscribe` | default | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/increment_elicitation` | experimental | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/decrement_elicitation` | experimental | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/name/set` | default | `src/lib/accounts/codexAppServer.ts:431` | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/goal/set` | default | `src/lib/accounts/codexAppServer.ts:435` | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/goal/get` | default | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/goal/clear` | default | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/queue/add` | experimental | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/queue/list` | experimental | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/queue/update` | experimental | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/queue/delete` | experimental | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/queue/reorder` | experimental | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/queue/start` | experimental | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/metadata/update` | default | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/section/move` | default | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/settings/update` | experimental | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/memoryMode/set` | experimental | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `memory/reset` | experimental | No literal match | Deferred: global reset is destructive and unrelated to message delivery |
| `thread/unarchive` | default | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/compact/start` | default | `src/lib/runtime/codexAppServerHost.ts:363` | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/shellCommand` | default | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/approveGuardianDeniedAction` | default | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/backgroundTerminals/clean` | experimental | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/backgroundTerminals/list` | experimental | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/backgroundTerminals/terminate` | experimental | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/rollback` | default | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/revert` | default | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/list` | default | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `project/list` | experimental | No literal match | Deferred: preserve Viewer project/worktree grouping |
| `project/read` | experimental | No literal match | Deferred: preserve Viewer project/worktree grouping |
| `project/create` | experimental | No literal match | Deferred: preserve Viewer project/worktree grouping |
| `project/import` | experimental | No literal match | Deferred: preserve Viewer project/worktree grouping |
| `project/update` | experimental | No literal match | Deferred: preserve Viewer project/worktree grouping |
| `project/move` | experimental | No literal match | Deferred: preserve Viewer project/worktree grouping |
| `project/delete` | experimental | No literal match | Deferred: preserve Viewer project/worktree grouping |
| `threadSection/list` | default | No literal match | Deferred: Viewer already owns board organization |
| `threadSection/create` | default | No literal match | Deferred: Viewer already owns board organization |
| `threadSection/update` | default | No literal match | Deferred: Viewer already owns board organization |
| `threadSection/delete` | default | No literal match | Deferred: Viewer already owns board organization |
| `thread/search` | experimental | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/searchOccurrences` | experimental | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/loaded/list` | default | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/read` | default | `src/lib/accounts/codexAppServer.ts:424`, `src/lib/runtime/codexAppServerHost.ts:329` | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/turns/list` | default | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/items/list` | default | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/inject_items` | default | `src/lib/runtime/codexAppServerHost.ts:362` | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `skills/list` | default | No literal match | Use existing skill discovery; refresh configuration through controlled account scope |
| `skills/extraRoots/set` | default | No literal match | Use existing skill discovery; refresh configuration through controlled account scope |
| `hooks/list` | default | No literal match | Discovery useful for explaining tool actions; do not change policy implicitly |
| `marketplace/add` | default | No literal match | Deferred: installation has separate user intent and source policy |
| `marketplace/remove` | default | No literal match | Deferred: installation has separate user intent and source policy |
| `marketplace/upgrade` | default | No literal match | Deferred: installation has separate user intent and source policy |
| `plugin/list` | default | No literal match | Read/reconcile can explain stale tools; installations remain explicit |
| `plugin/search` | experimental | No literal match | Read/reconcile can explain stale tools; installations remain explicit |
| `plugin/installed` | default | No literal match | Read/reconcile can explain stale tools; installations remain explicit |
| `plugin/reconcile` | default | No literal match | Read/reconcile can explain stale tools; installations remain explicit |
| `plugin/read` | default | No literal match | Read/reconcile can explain stale tools; installations remain explicit |
| `plugin/skill/read` | default | No literal match | Read/reconcile can explain stale tools; installations remain explicit |
| `plugin/share/save` | default | No literal match | Read/reconcile can explain stale tools; installations remain explicit |
| `plugin/share/updateTargets` | default | No literal match | Read/reconcile can explain stale tools; installations remain explicit |
| `plugin/share/list` | default | No literal match | Read/reconcile can explain stale tools; installations remain explicit |
| `plugin/share/checkout` | default | No literal match | Read/reconcile can explain stale tools; installations remain explicit |
| `plugin/share/delete` | default | No literal match | Read/reconcile can explain stale tools; installations remain explicit |
| `app/read` | default | No literal match | Expose account-scoped tool availability through existing capabilities |
| `app/list` | default | No literal match | Expose account-scoped tool availability through existing capabilities |
| `app/installed` | default | No literal match | Expose account-scoped tool availability through existing capabilities |
| `fs/readFile` | default | No literal match | Deferred: existing Viewer file access; avoid a second mutation surface |
| `fs/writeFile` | default | No literal match | Deferred: existing Viewer file access; avoid a second mutation surface |
| `fs/createDirectory` | default | No literal match | Deferred: existing Viewer file access; avoid a second mutation surface |
| `fs/getMetadata` | default | No literal match | Deferred: existing Viewer file access; avoid a second mutation surface |
| `fs/readDirectory` | default | No literal match | Deferred: existing Viewer file access; avoid a second mutation surface |
| `fs/remove` | default | No literal match | Deferred: existing Viewer file access; avoid a second mutation surface |
| `fs/copy` | default | No literal match | Deferred: existing Viewer file access; avoid a second mutation surface |
| `fs/watch` | default | No literal match | Deferred: existing Viewer file access; avoid a second mutation surface |
| `fs/unwatch` | default | No literal match | Deferred: existing Viewer file access; avoid a second mutation surface |
| `skills/config/write` | default | No literal match | Use existing skill discovery; refresh configuration through controlled account scope |
| `plugin/install` | default | No literal match | Read/reconcile can explain stale tools; installations remain explicit |
| `plugin/uninstall` | default | No literal match | Read/reconcile can explain stale tools; installations remain explicit |
| `turn/start` | default | `src/lib/runtime/codexAppServerHost.ts:357` | Generation, steering, interruption, and settings; see compatibility matrix |
| `turn/settings/update` | experimental | No literal match | Generation, steering, interruption, and settings; see compatibility matrix |
| `turn/steer` | default | `src/lib/runtime/codexAppServerHost.ts:358` | Generation, steering, interruption, and settings; see compatibility matrix |
| `turn/interrupt` | default | `src/lib/runtime/codexAppServerHost.ts:359` | Generation, steering, interruption, and settings; see compatibility matrix |
| `thread/realtime/start` | experimental | `src/lib/runtime/codexAppServerHost.ts:360` | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/realtime/appendAudio` | experimental | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/realtime/appendText` | experimental | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/realtime/appendSpeech` | experimental | `src/lib/runtime/codexAppServerHost.ts:2003` | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/realtime/stop` | experimental | `src/lib/runtime/codexAppServerHost.ts:361` | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/timeline/list` | experimental | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `thread/realtime/listVoices` | experimental | No literal match | History, input, lifecycle, goals, and metadata; see compatibility matrix |
| `review/start` | default | No literal match | Deferred: preserve visible Viewer review stages and independent reviewer contract |
| `model/list` | default | `src/lib/runtime/codexAppServerHost.ts:1290` | Read model capabilities; preserve explicitly selected model |
| `modelProvider/capabilities/read` | default | No literal match | Read capability/auth status; never infer subscription eligibility |
| `experimentalFeature/list` | default | No literal match | Read supported feature state; avoid blanket enablement |
| `permissionProfile/list` | default | No literal match | Read named permission profiles; retain access/sandbox distinction |
| `experimentalFeature/enablement/set` | default | No literal match | Read supported feature state; avoid blanket enablement |
| `remoteControl/enable` | experimental | No literal match | Deferred: keep Viewer the single operator management surface |
| `remoteControl/disable` | experimental | No literal match | Deferred: keep Viewer the single operator management surface |
| `remoteControl/status/read` | experimental | No literal match | Deferred: keep Viewer the single operator management surface |
| `remoteControl/pairing/start` | experimental | No literal match | Deferred: keep Viewer the single operator management surface |
| `remoteControl/pairing/status` | experimental | No literal match | Deferred: keep Viewer the single operator management surface |
| `remoteControl/client/list` | experimental | No literal match | Deferred: keep Viewer the single operator management surface |
| `remoteControl/client/revoke` | experimental | No literal match | Deferred: keep Viewer the single operator management surface |
| `collaborationMode/list` | experimental | No literal match | Read-only discovery for supported mode controls |
| `mock/experimentalMethod` | experimental | No literal match | Test-only; never expose |
| `environment/add` | experimental | No literal match | Deferred: remote executor environments need a separate product requirement |
| `environment/info` | experimental | No literal match | Deferred: remote executor environments need a separate product requirement |
| `environment/status` | experimental | No literal match | Deferred: remote executor environments need a separate product requirement |
| `mcpServer/oauth/login` | default | No literal match | Account-scoped tool/auth health; event streams remain experimental |
| `config/mcpServer/reload` | default | No literal match | Retain managed account configuration ownership |
| `mcpServerStatus/list` | default | `src/lib/runtime/codexAppServerHost.ts:1358` | Deferred: no current requirement |
| `mcpServer/resource/read` | default | No literal match | Account-scoped tool/auth health; event streams remain experimental |
| `mcpServer/event/stream/start` | experimental | No literal match | Account-scoped tool/auth health; event streams remain experimental |
| `mcpServer/event/stream/stop` | experimental | No literal match | Account-scoped tool/auth health; event streams remain experimental |
| `mcpServer/tool/call` | default | No literal match | Account-scoped tool/auth health; event streams remain experimental |
| `windowsSandbox/setupStart` | default | No literal match | Platform-specific readiness; no Linux implementation work |
| `windowsSandbox/readiness` | default | No literal match | Platform-specific readiness; no Linux implementation work |
| `account/login/start` | default | `src/lib/accounts/codexAppServer.ts:324` | Existing subscription account flow; spending and outbound messages require explicit intent |
| `account/bedrock/discover` | experimental | No literal match | Existing subscription account flow; spending and outbound messages require explicit intent |
| `account/bedrock/setup` | experimental | No literal match | Existing subscription account flow; spending and outbound messages require explicit intent |
| `account/login/cancel` | default | `src/lib/accounts/codexAppServer.ts:334` | Existing subscription account flow; spending and outbound messages require explicit intent |
| `account/logout` | default | No literal match | Existing subscription account flow; spending and outbound messages require explicit intent |
| `account/rateLimits/read` | default | `src/lib/accounts/codexAppServer.ts:342` | Existing subscription account flow; spending and outbound messages require explicit intent |
| `account/rateLimitResetCredit/consume` | default | `src/lib/accounts/codexAppServer.ts:360` | Existing subscription account flow; spending and outbound messages require explicit intent |
| `account/usage/read` | default | No literal match | Existing subscription account flow; spending and outbound messages require explicit intent |
| `account/workspaceMessages/read` | default | No literal match | Existing subscription account flow; spending and outbound messages require explicit intent |
| `account/sendAddCreditsNudgeEmail` | default | No literal match | Existing subscription account flow; spending and outbound messages require explicit intent |
| `feedback/upload` | default | No literal match | Deferred: diagnostic upload is an external publication action |
| `command/exec` | default | No literal match | Deferred: existing tool and runtime ownership controls |
| `command/exec/write` | default | No literal match | Deferred: existing tool and runtime ownership controls |
| `command/exec/terminate` | default | No literal match | Deferred: existing tool and runtime ownership controls |
| `command/exec/resize` | default | No literal match | Deferred: existing tool and runtime ownership controls |
| `process/spawn` | experimental | No literal match | Deferred: experimental process control would expand lifecycle authority |
| `process/writeStdin` | experimental | No literal match | Deferred: experimental process control would expand lifecycle authority |
| `process/kill` | experimental | No literal match | Deferred: experimental process control would expand lifecycle authority |
| `process/resizePty` | experimental | No literal match | Deferred: experimental process control would expand lifecycle authority |
| `config/read` | default | `src/lib/accounts/codexAppServer.ts:389`, `src/lib/runtime/codexAppServerHost.ts:1299` | Retain managed account configuration ownership |
| `externalAgentConfig/detect` | default | No literal match | Deferred: importing history/configuration is a separate user action |
| `externalAgentConfig/import` | default | No literal match | Deferred: importing history/configuration is a separate user action |
| `externalAgentConfig/import/recordHistory` | default | No literal match | Deferred: importing history/configuration is a separate user action |
| `externalAgentConfig/import/readHistories` | default | No literal match | Deferred: importing history/configuration is a separate user action |
| `config/value/write` | default | No literal match | Retain managed account configuration ownership |
| `config/batchWrite` | default | No literal match | Retain managed account configuration ownership |
| `configRequirements/read` | default | No literal match | Read effective requirements before offering restricted settings |
| `account/read` | default | `src/lib/accounts/codexAppServer.ts:312`, `src/lib/runtime/codexAppServerHost.ts:1282` | Existing subscription account flow; spending and outbound messages require explicit intent |
| `fuzzyFileSearch` | default | No literal match | Optional mention picker; existing UI remains owner |
| `fuzzyFileSearch/sessionStart` | experimental | No literal match | Optional mention picker; existing UI remains owner |
| `fuzzyFileSearch/sessionUpdate` | experimental | No literal match | Optional mention picker; existing UI remains owner |
| `fuzzyFileSearch/sessionStop` | experimental | No literal match | Optional mention picker; existing UI remains owner |
