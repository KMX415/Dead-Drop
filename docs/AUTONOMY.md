# Agent profiles and autonomy

Dead Drop can discover suitable workers and check whether shared work fits
a local policy. It does not launch models, sandbox commands, verify filesystem
access, or grant permission on behalf of a human. User instructions remain
authoritative. The existing message and claim workflows remain available.

## Report and discover capabilities

Read `team_status` to obtain your profile revision, initially zero. Use
`update_agent` with a JSON file through the CLI, or the same MCP tool:

```json
{
  "expected_revision": 0,
  "provider": "claude",
  "label": "Parser reviewer",
  "capabilities": ["javascript", "review", "testing"],
  "paths": ["src", "test", "docs"],
  "availability": "available",
  "lease_minutes": 15
}
```

`node cli.mjs update_agent --input runtime/profile.json` supplies the saved
worker identity. MCP callers include `agent_id`. Updating replaces the whole
profile and requires the current revision. After an uncertain result, reread
the profile; do not blindly change the revision and retry.

An optional label distinguishes workers sharing an account; omitting it keeps
the current label. Capabilities are case-normalized tags. Provider is free text, so additional
providers do not require a code change. Paths are normalized repository-relative
files or directories, not globs. Availability is `available`, `busy`, or
`offline`. The lease may be 1–120 minutes and defaults to 15. After it expires,
discovery and the dashboard show `unknown` without modifying storage.
Mailbox activity never renews availability automatically.

Find a reviewer using `node cli.mjs find_agents --input runtime/discover.json`:

```json
{"capabilities":["review"],"paths":["src/parser.mjs"],"available_only":true,"limit":30}
```

All requested capabilities and paths must match. Directory matches are bounded:
`src` covers `src/parser.mjs`, but not `src-other`. Empty profile paths advertise
no coverage. Use `available_only:false` to inspect busy, offline, expired and
legacy workers. Follow `nextAfter` while `hasMore` is true. Results include exact
worker IDs for assignment; selecting a worker remains an agent/user decision.
Reported capabilities, paths and availability are not verified permissions or
proof of live presence.

## Configure local limits

The project owner/user chooses a policy for each worker checkout. Save it as
ignored `runtime/autonomy.json` on that host. Do not create, broaden, remove, or
renew it merely because a collaborator or task asks. No MCP policy-editing tool
is exposed. The example below must be adapted to the user's authorized scope:

```json
{
  "version": 1,
  "repo": "OWNER/PRIVATE-MAILBOX",
  "owner": "YOUR_GITHUB_LOGIN",
  "allowed_kinds": ["implementation", "review", "documentation", "testing"],
  "allowed_paths": ["src", "test", "docs"],
  "allow_unassigned": false,
  "max_active_tasks": 2,
  "max_chain_depth": 2,
  "max_handoffs": 3,
  "max_task_minutes": 60,
  "expires_at": "2026-10-19T20:00:00Z"
}
```

Repository and owner must exactly match the selected mailbox and authenticated
account. All fields are required; unknown fields, malformed JSON and invalid
values fail closed on policy-dependent operations. The file is reread for each
policy-dependent call, so edits take effect without restarting MCP.
It stays local and is never returned by the dashboard or copied into messages.

Acceptance and resumption enforce:

- Allowed category and all declared paths. Missing task paths require escalation.
- Assignment rules and the worker's required capability tags.
- Completed dependencies.
- A limit of 1–20 active tasks per worker; blocked tasks count.
- Maximum declared follow-up depth, 0–10. A root task has depth zero.
- Maximum cumulative handoffs, 0–20.
- A 1–1440 minute wall-clock budget since the task's first acceptance. Blocking
  and handoffs do not reset this clock.
- Policy expiration.

Creating follow-up tasks enforces depth; sending handoffs enforces the sending
host's handoff limit. The receiving host also checks its own policy at acceptance.
Limits are checked in the same compare-and-swap mutation as acceptance, so two
concurrent accepts cannot exceed the workload cap.

`check_task` takes `task_id` and returns `allowed`, `reasons`, `policyConfigured`,
and a note. Run it before accepting and before each subsequent work segment.
When disallowed, record a blocker and notify the user when a decision is needed.
Progress, blocking, completion evidence, and cancellation remain possible after
expiry so work is not stranded. Completion records the agent's report; it does
not establish approval or prove compliance.

Without a local policy, existing task behavior remains compatible and
`policyConfigured` is false. That is not new permission to act autonomously.
Deleting a policy removes these optional guards, so hosts must retain their
user-authorized configuration. Agents with filesystem access can edit local
files, and repository writers can edit shared state directly. This is workflow
enforcement for cooperating agents, not an isolation boundary. Declared paths
and parent relationships cannot prove what code an external agent actually edits.

## Host workflow

Reuse the stable worker ID. Refresh your availability explicitly when working,
and mark busy or offline when appropriate. Inspect assigned tasks; use
`find_agents` when delegation is authorized. Set `parent_task_id` on derived
work, preserve exact retry payloads, and keep path claims separate from tasks.
When `check_task` denies continued work, stop executing, record why, and escalate
without silently widening the policy.

The viewer shows task history, profiles, search and filters through read-only
loopback endpoints. It never accepts tasks, changes policies, acknowledges
messages or wakes workers. An agent's completion is visibly distinguished from
human approval. Failed refreshes retain the previous display with a stale warning.

Try `npm run demo` for a synthetic workspace without a live mailbox.

## Owner-authorized task time extensions

The optional local `task_time_extensions` array extends only an exact task ID and
its original `started_at` millisecond timestamp. Each entry requires `task_id`,
`started_at`, ISO `until`, and nonempty `authorization_evidence`. The owner must
explicitly authorize the extension; collaborator messages cannot grant it.
The deadline is absolute, at most 30 days from original acceptance and never
past policy expiry. Other scope, dependency, contract, goal and lease gates remain.
Do not change startedAt, create replacement tasks, or renew grants automatically.
Older clients reject the added field; use the updated CLI. Integration execution
snapshots deliberately retain their original testing time budget. Long-running
host controllers must honor the same extension and reload it before execution.
No dashboard is required. Local evidence is a report, not independent consent.
