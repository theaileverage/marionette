# Coordinator roles and user authority

New setups default to a coordinator-only lead, launched through Codex CLI, Claude Code, or oh-my-pi. The lead discusses the objective, dispatches Marionette workers, reads their evidence, resolves decisions, and waits for results. Repository inspection, external research, document writing, implementation, and verification belong to workers, including small tasks.

The dashboard is unchanged. Configure this feature through the CLI or an administrative MCP client.

## Terminal startup

Codex hook and scoped MCP commands are stored as private executable files under the session's guard directory. Stable, owner-only `/tmp/mnett-*/g` aliases keep their terminal references short even when the state directory is deeply nested. These aliases contain no credentials and are recreated if temporary files disappear. The guard policy and runtime stay in the configured Marionette home; user and project Codex settings are not edited.

Lead and worker launch arguments are checked after shell quoting, before Herdr receives input. Oversized custom arguments produce an actionable error instead of a truncated command. Codex's own trust prompt may still appear for a new project.

## User authority

A guarded project initially permits read-only assignments. An outcome's objective, intent amendments, skills, model profile, and role selection cannot grant writes. Before dispatching work that produces files, create the outcome and record the user's permitted activity and paths through the owner CLI:

```sh
marionette authorize --outcome OUTCOME_ID \
  --allow documentation --scope docs \
  --source 'User requested an architecture document in docs'
```

After the user authorizes implementation, replace the grant with the complete authorized scope:

```sh
marionette authorize --outcome OUTCOME_ID \
  --allow implementation,execute --scope src --scope tests \
  --source 'User approved implementing the design and running its checks'
```

`documentation` permits document workers to write `.md`, `.mdx`, `.txt`, and `.rst` files in assigned paths. `implementation` permits implementation workers and their execution tools; `execute` additionally permits supervisor command checks. Use file, diff, or other non-command checks for inspection without supervisor execution authority. Command-based watches are unavailable on guarded projects: commission a verifier assignment instead.

Grants persist for the outcome, so repeated dispatch within that scope requires no new approval. Revise a grant only when the user's scope changes. `--allow none` revokes writes and supervisor execution after active workers have settled. Replacement is refused while affected workers are preparing, running, or verifying; queued work is checked again at launch. Existing running processes cannot be retroactively stripped of OS access.

The grant endpoint requires the instance-owner credential and is absent from both lead and worker MCP. Natural-language approval in a harness conversation is **not automatically imported as a trusted grant**. This CLI step is the trusted input channel; allowing the lead to label its own text as “user approval” would reproduce the original escalation. An embedding application can use the owner endpoint after authenticating an actual user action.

`authority_get` exposes the current grant to the lead. A denied dispatch makes no task or authority changes. Ownership must fit the grant, including when the assignment runs in a Marionette worktree. Granting a role never expands its tool capabilities.

## Model profiles by role

Use `profile.discover`, `profile.configure`, and `profile.validate` through the administrative CLI/MCP to prepare exact harness/model/effort profiles. Discovery reads metadata; validation sends a small model request and can incur usage. Nothing automatically validates every model in a catalog.

Configure roles with profile IDs from that project, for example:

```json
[
  { "id": "lead", "profileId": "YOUR_LEAD_PROFILE", "activity": "coordinate", "canDelegate": true },
  {
    "id": "researcher",
    "profileId": "YOUR_RESEARCH_PROFILE",
    "activity": "inspect",
    "canDelegate": false
  },
  {
    "id": "architect",
    "profileId": "YOUR_ARCHITECT_PROFILE",
    "activity": "documentation",
    "canDelegate": false
  },
  {
    "id": "implementer",
    "profileId": "YOUR_IMPLEMENTER_PROFILE",
    "activity": "implementation",
    "canDelegate": true
  },
  {
    "id": "reviewer",
    "profileId": "YOUR_REVIEW_PROFILE",
    "activity": "inspect",
    "canDelegate": false
  }
]
```

```sh
marionette roles --file roles.json
marionette roles
marionette roles --global --file default-roles.json
```

`--global` stores defaults for this Marionette instance. Project entries override defaults by role ID. Replacing project entries with `[]` restores inheritance. Profile IDs still resolve and validate in the target project; an unavailable or missing profile fails explicitly. Suggested names also include `scout`, `verifier`, and `documentation`; custom role IDs are supported. For architecture discussion without a document, use an inspection role.

A task selects a role with `assignment.role`. Its `kind` must match the selected profile; inspection assignments require `readOnly: true`, `ownership: []`, and `canDelegate: false`. Marionette snapshots the resolved role, profile, model, and effort for the task. Later role changes do not rewrite existing assignments. An explicit task profile takes precedence over the role default, while the role's activity and delegation limits still apply. The lead profile precedence is explicit launch profile, saved lead profile, configured `lead` role, then the orchestration category default. There is no automatic fallback for an unavailable selection.

## Harness behavior

The short visible launch message is a bootstrap. The session guard supplies the
full lead contract from `src/templates/lead.mustache`; the MCP server also supplies
the shared contract. `project_briefing` supplies current state rather than the
instructions themselves. Codex's session hook has an explicit context budget so
the contract remains inline on startup, resume, and compaction.

The contract points to `project_briefing.profiles`, `roles`, and `profileDefaults`
for exact model and role selection. Only validated, available profiles qualify;
unverified catalog entries are not an implicit fallback. Detailed optional
workflows remain in recipes, including `multiple-intents`.

Independent requests are additive by default. The lead records an interrupted
next action in a checkpoint, keeps earlier workers running, and revisits every
ready outcome. Explicit replacement or cancellation applies only to the named
work. Both `project_briefing.swarm.activeIntents` and `swarm_observe.activeIntents`
list all unfinished outcomes with task states, waiting reasons, decisions, and
the latest checkpoint pointer. These are derived from persisted records, so a
new message or process restart does not replace the earlier intent.

Each unfinished outcome may have its own active lead wait. A second wait for the
same outcome requires acknowledging or reconciling the first. When independent
outcomes become ready together, an atomic capacity reservation admits one lead
delivery at a time; the other remains queued. The guard's restored instructions
identify the exact `marionette_lead` server so other installed Marionette
connections are not mistaken for the current project.

| Harness             | Lead and worker guard                                                                                                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI           | SessionStart restores the contract on startup, resume, clear, and compaction. PreToolUse checks local tool calls. Coordinator launches disable shell, native multi-agent, and web search, and use a read-only sandbox.      |
| Claude Code         | SessionStart and PreToolUse hooks, an explicit built-in tool list, and strict scoped MCP configuration.                                                                                                                     |
| oh-my-pi (`omp`)    | Session extension filters tool calls and active tools; startup/resume/branch/compaction refresh the role, and every agent turn restores its instructions. Coordinator launches use `--no-tools` plus the scoped MCP plugin. |
| Codex desktop / AGY | Guarded launch is unsupported. `lead --print` prints instructions for an explicitly prompt-only integration; it does not enforce coordinator behavior.                                                                      |

Harness preflight checks required CLI controls before launching. Generated hooks, policies, and OMP plugins live under the instance's `guards/<project>/` directory. No global hook configuration is changed. Codex's `--dangerously-bypass-hook-trust` approves this generated hook invocation; it does not bypass the sandbox or command approval policy.

The generated Codex configuration approves calls to the session's scoped
Marionette MCP server. Marionette still checks its capability, role, outcome
authority, revision, and ownership. This avoids a native MCP approval rejection
under the read-only session's `never` approval policy; it does not grant outcome
execution authority or approve unrelated MCP servers.

A guarded lead's sidecar reads its saved lease internally. The model sees coordination tools, without administrative tools or a lease-token parameter. The server verifies lease ownership and project scope. Workers use their own token-scoped MCP, including `worker_files` for bounded file inspection without a shell. Before a native tool runs, guarded workers refresh their current activity, retained ownership, and authority from the supervisor; paused and revoked work is rejected. Reporting and inspection through MCP remain available. The compacted worker prompt restores the role contract and directs the worker to current assignment state, rather than reinstating an obsolete task prompt.

These are harness guardrails, not OS isolation from an adversarial process running as the same user. Codex's documented exceptions include hosted tools, specialized tool paths, and input into an already-running shell. This is why root launches disable shell and web search, and why an existing session is reused only when its terminal identity and saved launch configuration match. Worker implementation shells retain their authorized capabilities. Do not treat a prompt-only or manually launched process as guarded.

After upgrading, exit any old lead and launch it again with the configured runtime. Guarded launch refuses to reuse an old process without a matching receipt. Existing projects explicitly configured with `coordinatorOnly: false` retain their legacy runtime policy; new setup defaults to true.

## oh-my-pi adapter

Install and authenticate oh-my-pi using its native instructions:

```sh
bun install -g @oh-my-pi/pi-coding-agent
marionette setup --lead omp
```

Setup can install the missing required harness with the existing `--install-tools` workflow. Model discovery uses `omp models --json` and preserves exact `provider/model` IDs and supported thinking levels. Profiles launch with `--model provider/model --thinking LEVEL`; validation checks the returned provider/model and rejects fallback responses. Guarded OMP sessions disable automatic model fallback and the advisor.

OMP has no `mcp add` CLI subcommand. Administrative MCP registration uses its native `mcp.json`, preserves unrelated fields and servers, and participates in Marionette's existing registration receipt, upgrade, and removal lifecycle. The settings path follows OMP profile/config environment variables; `MARIONETTE_OMP_SETTINGS` can provide an explicit path. OMP has no equivalent workspace-trust switch, so Marionette does not fabricate one. Guarded sessions load a separate scoped MCP plugin.

References: [Codex hook coverage and compaction](https://learn.chatgpt.com/docs/hooks), [oh-my-pi installation](https://github.com/can1357/oh-my-pi), [OMP extensions](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md), [OMP configuration roots](https://github.com/can1357/oh-my-pi/blob/main/docs/config-usage.md).
