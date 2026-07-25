# Computer Use for operator root Codex sessions (issue #687)

Codex plugins are installed and enabled globally in the operator's
`config.toml`. Hosted Viewer sessions have always suppressed the whole plugin
subsystem (`features.plugins: false` in the per-thread configuration), so no
hosted session ever saw a plugin tool. This design grants exactly one plugin —
`computer-use` — to the sessions the operator launches for themselves, and to
nothing else. The Viewer never edits the operator's Codex configuration and
never enables plugins for the app-server as a whole.

## Who gets it

| session | grant |
| --- | --- |
| operator-launched root Codex session | `["computer-use"]` by default |
| same session, launched with `plugins: []` | none (explicit opt-out) |
| delegated: agent-initiated spawn, lineage parent, or any role preset (builder, reviewer, verifier, pipeline helper) | none |
| any Claude session | none — plugins are a Codex thread capability |

`sessionOriginFor` in `src/lib/agent/pluginAllowlist.ts` classifies the launch.
It is fail-closed: a non-operator origin, a lineage parent, a role preset, a
non-zero delegation depth, or an unrecognized origin kind all mean *delegated*.

The grant for a delegated session is the constant `DELEGATED_PLUGINS`, empty in
this slice. Delegated grants are a separate decision; expressing a different
answer later is a change to that list, not to the surrounding structure.

## Why it cannot widen

Three independent bounds, all on the same allowlist:

1. `normalizeSpawnPlugins` rejects any requested name outside
   `GRANTABLE_PLUGINS` — `*`, `all`, and any other plugin are 400s, never
   trimmed silently.
2. `pluginAllowlistForSession` returns the policy default for the origin
   *narrowed* by the request. A request can deny a grant; it can never create
   one, so nothing is inheritable down a spawn chain.
3. `emptyLaunchProfile`, `headlessCodexThreadConfig` and the structured host all
   re-validate against `GRANTABLE_PLUGINS`, so a hand-edited durable profile
   cannot smuggle a plugin into a thread.

## What Codex actually honours

Probed against Codex CLI 0.145.0 with two threads inside a single app-server
process, comparing `mcpServerStatus/list` per thread:

- `config.features.plugins` on `thread/start` **is** per-thread. The thread that
  passed `false` gained no plugin server; the thread that passed `true` gained
  the `computer-use` MCP server, in the same process, at the same time.
- the per-thread `config.plugins` table is accepted without error but **is not
  applied**: enabling or disabling entries there does not change the plugin
  surface, and even `plugins.<id>.enabled=false` in the effective configuration
  does not stop a bundled plugin server once the feature flag is on.

So the Viewer sends the `plugins` table as the declarative record of the grant —
correct the day Codex applies it — and does not rely on it. Enforcement is a
verification step: after a granted thread starts, `CodexAppServerHost` lists the
thread's MCP servers and refuses to open if any server outside the thread's own
configured table and the granted plugins' server names appeared. A grant that
cannot be verified is not granted, so a widened surface fails the launch instead
of reaching the model.

## Desktop environment

A granted host also receives an enumerated set of desktop-session variables that
the bundled Computer Use backend reads: `DISPLAY`, `XAUTHORITY`,
`WAYLAND_DISPLAY`, `XDG_SESSION_TYPE`, `XDG_CURRENT_DESKTOP`, `DESKTOP_SESSION`.
`XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` are equally required and were
already forwarded to every host. Nothing else is added — in particular no
input-backend variable such as `YDOTOOL_SOCKET`. A session without a grant gets
no desktop variables at all.

## Resume and handoff

The grant is decided once, at spawn, and stored on the durable launch profile.

- **Resume / restart adoption**: the stored value is replayed
  (`mergeResumeLaunchProfile` keeps the current profile's `plugins`, startup
  adoption passes `launchProfile.plugins`). A resume can therefore never widen
  the grant, and a running session is never restarted to change it.
- **Handoff / successor**: a successor is admitted through the same path, and a
  delegated conversation — one carrying a role preset or a lineage parent — has
  its grant cleared at admission regardless of what its profile claims.
- **Sessions that pre-date this change** carry no `plugins` value, which
  normalizes to none. They acquire the tool only by an explicit controlled
  resume with a profile that carries the grant.

## Tests

- `src/lib/agent/pluginAllowlist.test.ts` — origin policy, default-on for root,
  opt-out, delegated denial, and the widening rejections.
- `src/lib/codexHeadlessConfig.test.ts` — the thread configuration a grant
  produces, and the absence of a plugin table without one.
- `src/lib/runtime/codexAppServerHost.pluginGrant.test.ts` — thread
  configuration, desktop environment scoping, and the two fail-closed
  verification paths.
- `src/app/api/spawn/route.test.ts` — the durable profile a spawn request
  produces for each session class.
- `src/lib/agent/registry.admission.test.ts` — a delegated conversation cannot
  acquire the grant at admission.

No automated test performs a desktop input action; validation is limited to the
read-only surface (tool inventory, window list, screenshot).
