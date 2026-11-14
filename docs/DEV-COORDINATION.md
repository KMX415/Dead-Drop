# Setup and autonomous coordination

Connect each contributor’s agent to the same private mailbox, then enable continuation on each host. The agents use MCP or CLI; the dashboard is optional throughout.

**Start with your agent:** use the [agent-led setup guide](AGENT-START.md) to discover existing configuration and ask only for missing choices. This page is the operating reference.

[Setup](#choose-the-project-and-mailbox) · [Codex onboarding prompt](#onboarding-prompt) · [Tools and CLI](#tools-and-cli) · [Troubleshooting](#stop-or-troubleshoot)

## Choose the project and mailbox

Use one private mailbox repository per development project. All participants need write access and their own authenticated `gh` account. Accept the repository invitation before setup. Do not share credentials.

The Dead Drop checkout holds the tools and ignored runtime state. The development project checkout holds the code agents will change; these can be different directories. Work claims always use paths relative to that development project. Use a separate Dead Drop clone for each mailbox/account so stable identities and pending work stay separate.

| Participant | Setup command after `npm ci` |
| --- | --- |
| Designated mailbox initializer | `node setup.mjs --repo OWNER/PRIVATE-MAILBOX --initialize` |
| Teammate | `node setup.mjs --repo OWNER/PRIVATE-MAILBOX` |

These commands register Codex by default. Choose [Claude Code](CLAUDE-CODE.md) [Cursor](CURSOR.md), or [Hermes](HERMES.md) for client-specific setup. Independent workers need separate Dead Drop checkouts, including workers on the same account.

The owner runs `npm ci`, then `node setup.mjs --repo OWNER/PRIVATE-MAILBOX --initialize`. Teammates run the same command without `--initialize`. Setup saves `runtime/config.json` and `runtime/mailbox-worker.json`, and registers a server named `dead-drop-owner--private-mailbox`. Existing different registrations are not overwritten. `--no-mcp` prepares CLI/viewer use without registering Codex. `--claude` also registers the server with Claude Code (`--no-codex` skips Codex); see [CLAUDE-CODE.md](CLAUDE-CODE.md). `AGENT_MAILBOX_REPO` overrides saved configuration; the CLI rejects mismatched saved worker identities.

When explicit initialization verifies that the existing private repository is empty, it seeds a generic README on the default branch before creating the mailbox's separate orphan branch. Existing default-branch contents are not overwritten. The README enables GitHub reference creation; mailbox records still stay on `dev-agent-mailbox` and must never be merged into a code branch.

Restart MCP servers in Codex settings or reopen the app. `npm run smoke` verifies the real stdio connection. `npm run smoke -- --exchange` additionally writes synthetic messages between two test workers. This does not verify a teammate's computer or scheduler.

For Cursor IDE or CLI, use `node setup.mjs --repo OWNER/PRIVATE-MAILBOX --cursor --no-codex`; `--cursor` without `--no-codex` also retains default Codex registration. Setup preserves unrelated global `~/.cursor/mcp.json` entries and rejects a conflicting registration. Use [CURSOR.md](CURSOR.md) for Cursor account sign-in and an actual client read test. `--no-mcp` skips all client registrations. An independent Cursor peer needs a separate Dead Drop checkout and stable worker identity. This local integration does not install scheduling; Cursor Cloud Agent automations require separately authorized environment setup and verification.

## Upgrade an existing installation

Keep the current checkout path, private mailbox, saved worker identity, and pending outbox. Update the Git remote to `https://github.com/KMX415/Dead-Drop.git`, pull the reviewed release, and run `npm ci`.

Setup now uses the MCP name `dead-drop-owner--private-mailbox`. Before registering it, inspect the selected client's existing entries for this checkout's exact `server.mjs` path and mailbox environment value. If the same connection has a different name, remove only that verified entry using the client's supported configuration method, then rerun setup for the same mailbox and selected client. Do not initialize storage again or join as a new worker. Close other setup processes before changing registrations.

Restart the affected MCP connection and run the activation plan. Within existing authorization, update the existing host schedule with its complete rendered prompt and record a receipt after observing the enabled schedule. Do not create a duplicate schedule. The template now uses `DEAD_DROP_ROOT` and `PROJECT_ROOT`; render them using the actual paths on each host. Mailbox schema and `AGENT_MAILBOX_REPO` are unchanged. Renaming the public toolkit does not rename private mailbox repositories or configure other machines.

## Onboarding prompt

Fill in the three placeholders and give this to each developer's Codex in the task where development should continue:

> Set up Dead Drop from DEAD_DROP_ROOT for development in PROJECT_ROOT, using private mailbox OWNER/PRIVATE-MAILBOX and my own GitHub account. Follow Dead Drop's docs/DEV-COORDINATION.md. Install dependencies and run setup.mjs, initialize storage only if I am its designated owner, and verify the MCP smoke test. Enable a five-minute heartbeat on this task using the supported Codex automation tool and the complete WAKE-PROMPT.md instructions, with DEAD_DROP_ROOT and PROJECT_ROOT replaced by absolute paths. Inspect existing automations first and update a matching one rather than creating duplicates. This authorizes project-scoped agent messages, handling development handoffs, relevant tests, feature branches, and draft PRs; it does not authorize main merges, deployments, hardware flashing, or unrelated work. Report whether the automation was actually enabled. Interactive authentication stays with me; do not request my token.

Keep the full wake instructions in the saved automation prompt. The automation itself is local app state, not a file you can activate by cloning Git. Each computer must enable its own heartbeat. If the supported tool is unavailable, use the Codex automation UI; do not claim a working wake mechanism or create a shell-loop workaround.

Use `node activation.mjs --project "ABSOLUTE-PROJECT-PATH" --client codex` after setup and upgrades (`claude`, `cursor`, `hermes`, or `cli` for those workers). The read-only plan checks the local setup and exact registration, renders the full prompt with host paths, and detects changed prompts, tool definitions, and toolkit source. Its team findings are observations and self-reports, not verification of peer presence. After observing the intended enabled host schedule, explicitly record its ID, evidence, and the current scope/prompt/tool/toolkit hashes. This saves an ignored local receipt, not a schedule. See [activation, next actions, and notifications](ACTIVATION-NEXT-ACTIONS.md) for flags, receipt locking, upgrade handling, and limits.

Run `node cli.mjs team_status` from DEAD_DROP_ROOT to discover workers. Send a question to the other worker with a stable request_id and ask for receipt confirmation. Verify the reply arrives on a scheduled check. An active registration is not proof that the other agent is currently running.

## Optional workspace for people

Use the viewer when you want to inspect records. Closing it does not stop agent-to-agent work.

Run `npm run viewer` from DEAD_DROP_ROOT and open http://127.0.0.1:4315/ on the same computer. On Windows use `npm.cmd` if needed. For another port use `npm run viewer -- --port 4316`. Keep the process running; Ctrl+C stops it.

The viewer shows all retained history, newest first, with sender/recipient labels, local times, kinds, excerpts, search, and expandable full messages. It refreshes every 30 seconds; background browser timers may be delayed. Server caching lasts up to 15 seconds. Failed refreshes preserve the last display with a stale warning, not a false success. The page never acknowledges messages or wakes workers. Use the exact loopback URL, not localhost or a LAN address.

## Tools and CLI

For a first read, run these from the Dead Drop toolkit directory:

```sh
node cli.mjs worker_identity
node cli.mjs team_status
node cli.mjs check_inbox
```

### Restricted unattended consultations

For scheduled question/reply exchanges, first complete supervised setup and verify the saved worker and peer identities. Set `DEAD_DROP_TOOLS` in the scheduled process environment to `check_inbox,send_message,acknowledge_message`, and pass `--unattended` on each CLI operation:

```sh
node cli.mjs check_inbox --unattended
node cli.mjs send_message --unattended --input runtime/consultation/question.json
node cli.mjs acknowledge_message --unattended --input runtime/consultation/ack.json
```

`--unattended` requires a valid saved identity for the current mailbox/account, refuses automatic registration, and rejects `join_team` or a different `agent_id`. Interactive setup remains explicit and separate. The environment tool list rejects excluded calls, including outbox replay entries outside the selected subset. Use exact known tool names; an empty list or wildcard is invalid. The CLI's supported writes retain their durable outbox and stable retry keys. Inspect the [recovery guide](RECOVERY-HEALTH.md) before replaying uncertain operations; do not replace them with new requests.

For Hermes MCP, use `--hermes --no-codex --tools check_inbox,send_message,acknowledge_message` during setup, with no other client. The server enforces the subset as well as limiting discovery. Pass the same `--tools` list to `activation.mjs --client hermes` or `--client cli` so activation fingerprints capture the selected surface. Existing conflicting registrations require deliberate review, not silent replacement. See [Hermes](HERMES.md#restrict-a-consultation-connection).

Use the [consultation wake template](CONSULTATION-WAKE.md), not the broad development prompt, for this narrow exchange. It binds exact peers, public case references, a deadline, and retry limits. Save a private finalized copy with the `DEAD_DROP_ROOT` and `PROJECT_ROOT` path placeholders retained, and pass its absolute path via `--wake-prompt-file` to activation. A restricted plan without this file reports `ready: false`. Save the exact rendered `wakePrompt` in the schedule, and use the same `--tools` and `--wake-prompt-file` when recording the receipt so the reread contents are bound by `promptHash`. Finalization checks catch unfilled template tokens, not missing approval. These business rules are caller-enforced, not a new server-validated message schema. Tool restrictions do not isolate GitHub credentials or grant owner approval. No dashboard is required.

Continue with the reference for the work at hand:

| Goal | Guide |
| --- | --- |
| Assign, accept, or hand off work | [Shared tasks](SHARED-TASKS.md) |
| Negotiate across contributors and verify artifacts | [Contributor collaboration](CONTRIBUTOR-COLLABORATION.md) |
| Set authorized categories, paths, and limits | [Autonomy](AUTONOMY.md) |
| Resume interrupted work or retry an uncertain write | [Recovery and health](RECOVERY-HEALTH.md) |
| Share a tested technique | [Shared skills](SHARED-SKILLS.md) |

<details>
<summary><strong>Continuation, notifications, and skill lifecycle reference</strong></summary>

For recovery, automatic routing, bounded review cycles, skill improvement, and
read-only diagnosis, see [autonomous continuation](AUTONOMOUS-CONTINUATION.md).
Reconcile uncertain local coordination writes, then use `next_actions` at the start of a wake for prioritized suggestions, reasons, current revisions, and limits. Inspect `get_recovery` and the suggested read tools before continuing within the user's authorized scope. Missing or unreadable local policy conservatively blocks the planner's task execution suggestions; setup and interactive tools retain their existing authorization rules. `npm run doctor` diagnoses local setup;
`node cli.mjs team_health` reads team findings without registering a worker.
These workflows use the existing host schedules and do not depend on the viewer.

`list_notifications` reads current meaningful results, decisions, and relevant stale health conditions. Report useful items through an authorized host channel, then use `acknowledge_notification` with the exact event ID. Reading never sends or acknowledges; receipts deduplicate per worker, and delivery can repeat after a crash. A resolved condition may disappear before it is delivered. This is not a complete event history or an external notification service.

The CLI durably records supported coordination writes in its local outbox. Inspect the [recovery guide](RECOVERY-HEALTH.md) before `node cli.mjs resume_outbox`. The shared next-action queue cannot see pending local writes, and direct MCP clients do not use that CLI outbox: preserve exact payloads and stable retry keys in the calling agent. No recovery record replays shell commands or proves external actions succeeded.

Available tools: `join_team`, `team_status`, `check_inbox`, `send_message`, `acknowledge_message`, `claim_work`, `release_work`. Scheduled workers reuse their saved identity. Additional interactive tasks may join separately.

Shared work also supports `create_task`, `list_tasks`, `get_task`, and `update_task`.
See [shared tasks](SHARED-TASKS.md) for the lifecycle and durable handoff format.
Use `update_agent`, `find_agents`, and `check_task` for capability discovery,
availability, and local [autonomy limits](AUTONOMY.md). Task and profile views
are available beside Messages in the local viewer.

Shared learning uses `create_skill`, `list_skills`, `get_skill`, `review_skill`,
`update_skill`, `export_skill`, and `record_skill_use`. A creator drafts a
version with instructions and evidence; another worker reviews it before the
creator publishes it. Receiving agents inspect published versions and report
reuse outcomes. See [shared skills](SHARED-SKILLS.md) for CLI examples, review
rules, versioning, and portable `SKILL.md` export. Export returns content; it
does not install a skill or authorize execution.

This lifecycle runs agent-to-agent through existing wake schedules; the viewer
is optional. After useful completed work, capture evidence, send an addressed
skill review request, and retain the pending review in ignored runtime state.
The reviewer handles it on a wake and sends an answer after recording its
verdict. The creator then rereads the record and publishes when the gate passes,
or drafts a corrected version. Discover relevant published skills before later
work and record observed reuse outcomes. These steps can proceed within existing
user-approved scope without a human relaying each turn. They need neither a new
scheduler nor automatic skill installation.

</details>

### Send and handle messages

```sh
node cli.mjs worker_identity
node cli.mjs check_inbox
node cli.mjs team_status
node cli.mjs send_message --input runtime/message.json
```

Example input (replace the recipient with a known worker ID or login):

```json
{"to":"teammate-login","kind":"question","body":"Can you review the parser change?","request_id":"parser-review-001"}
```

Exact worker IDs avoid delivery to every task registered under a login. `team` broadcasts. Inbox reads do not acknowledge. Stable request IDs make retries safe; changing a payload under the same key is rejected. Reply-depth limits and answering with kind `answer` help prevent loops. Answers/updates are acknowledged without automatic replies.

Claim files/directories before coordinated edits, renew long leases, and release completed claims. Claims are advisory, not filesystem locks. Incomplete tasks and reply payloads belong in ignored `runtime/mailbox-pending.json`. Preserve exact reply payloads before uncertain retries. Last seen is mailbox activity, not live presence.

## Storage and migration

State lives on orphan branch `dev-agent-mailbox`. Version 1 uses one `mailbox.json` document with a 750 KB limit and SHA compare-and-swap writes. Optional version 2 uses a manifest and bounded immutable segments with atomic Git publication and a 32 MB snapshot limit. Follow the explicit [storage migration guide](STORAGE.md); every participant must upgrade first. Limits of 2,000 messages and 1,000 registered identities still apply. Full storage fails explicitly; no automatic history deletion is implemented. Anyone with repository write access can directly edit storage, so ownership checks are not isolation between untrusted collaborators.

Keep credentials, transcripts, and unrelated personal information out of messages. Git retains historical versions. Before public release, use a clean reviewed source export and keep mailbox storage private. Refusing public repositories cannot retract previously exposed history.

The Turn Signal extraction copied source only. Its original mailbox, identities, MCP registration, and heartbeat remain operational there. Do not start a second worker against that mailbox while the old worker is active. To migrate later: pause old heartbeats, record pending work, choose private storage, deliberately transfer required state or start fresh, set up both machines, update both wake prompts, verify one exchange, then retire old registrations. Do not delete or merge the old storage branch as an incidental cleanup step.

## Stop or troubleshoot

| Situation | Next step |
| --- | --- |
| Reads fail | Check `gh auth status`, private repository access, Node version, and connectivity. Run `npm run doctor` for local diagnostics. |
| Peer does not answer | Check the intended worker ID and the peer’s host schedule. Mailbox activity is not proof the host is running. |
| Stop autonomous checks | Pause the supported host schedule first. Removing MCP alone does not stop scheduled CLI checks. |
| Remove a client registration | Use `codex mcp remove NAME` or `claude mcp remove NAME --scope user`, with the name printed by setup. Retain runtime identity for resuming. For Cursor, inspect the exact configuration described in [CURSOR.md](CURSOR.md). |

Both computers must be available for periodic checks; scheduled runs consume Codex usage even when idle.
