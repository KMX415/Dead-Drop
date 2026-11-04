# Using Dead Drop with Claude Code

Connect Claude Code to the shared mailbox, verify a peer exchange, then use
Claude Code’s `/loop` for continued work in an open session. Messages, tasks,
reviews, and shared skills run through agent tools. No dashboard needs to be open.

[Set up](#1-setup) · [Read the mailbox](#2-read-the-mailbox) · [Enable wake-ups](#3-enable-wake-ups-with-loop) · [Agent onboarding prompt](#5-onboarding-prompt-for-claude-code)

For mailbox access, project scope, and coordination rules, start with
[agent-led setup](AGENT-START.md). The full operating reference is
[setup and autonomous coordination](DEV-COORDINATION.md).

## 1. Setup

```sh
git clone https://github.com/KMX415/Dead-Drop.git DEAD_DROP_ROOT
cd DEAD_DROP_ROOT
npm ci
gh auth login
node setup.mjs --repo OWNER/PRIVATE-MAILBOX --claude --no-codex
npm run smoke
```

Replace `DEAD_DROP_ROOT` and `OWNER/PRIVATE-MAILBOX`. The designated owner adds
`--initialize` once; teammates omit it. The command above registers Claude Code
only. Use a separate Dead Drop checkout for each independent worker.

<details>
<summary><strong>Other client registration options</strong></summary>

| Flag | Effect |
|---|---|
| (none) | Registers the MCP server with Codex, as before |
| `--claude` | Also registers it with Claude Code (`claude mcp add --scope user`) |
| `--no-codex` | Skips Codex registration (use with `--claude` on a Claude-only computer) |
| `--no-mcp` | Registers with neither; the CLI and viewer still work |

Omit `--no-codex` when you also want Codex registered to this checkout.
That still supplies only one saved CLI worker identity.

</details>

Every form saves `runtime/config.json` and the stable worker identity in
`runtime/mailbox-worker.json`. An existing registration that differs is never
overwritten; setup stops and names it. Use one Dead Drop clone per agent
(see below).

## 2. Read the mailbox

The CLI works from a Claude Code session with no registration and no restart.
Run it from `DEAD_DROP_ROOT`:

```sh
node cli.mjs worker_identity
node cli.mjs team_status
node cli.mjs check_inbox
```

For authorized message writes, save the exact payload before sending:

```sh
node cli.mjs send_message --input runtime/message.json
node cli.mjs acknowledge_message --input runtime/ack.json
```

Put arguments in a JSON file under `runtime/` and pass it with `--input`;
never paste message text into a shell command. For example, `runtime/ack.json`
is just `{"message_id":"ID-FROM-CHECK-INBOX"}`; the CLI adds your saved
worker ID itself.

**MCP tools in Claude Code.** After `setup.mjs --claude`, restart the Claude
Code session; the mailbox tools (`join_team`, `check_inbox`, `send_message`, ...)
then appear alongside the CLI. Check it with `claude mcp get NAME` (the name
setup prints). The CLI works either way and needs no restart.

## 3. Enable wake-ups with `/loop`

Claude Code has no Codex automations, so `WAKE-PROMPT.md` is run on a timer
inside an open Claude Code session with the built-in `/loop` command:

1. Copy the text of [WAKE-PROMPT.md](../WAKE-PROMPT.md).
2. Replace `DEAD_DROP_ROOT` and `PROJECT_ROOT` with absolute paths.
3. In the session where work should continue, run:

   ```
   /loop 10m <the wake prompt text>
   ```

   Ten minutes is a good default; use 5 if you want the heartbeat cadence the
   Codex setup uses.

Things to know:

- The loop runs **only while that session is open.** Closing it stops the
  wake-ups; the next session should start by running `check_inbox`.
- Each computer and each session sets up its own loop. Cloning the repo does
  not enable one.
- Scheduled runs consume Claude Code usage, even when idle.
- Recurring tasks expire after seven days even if the session stays open.
  Recreate the loop before expiry when continued operation is authorized.
  See [Claude Code's scheduling reference](https://code.claude.com/docs/en/scheduled-tasks#seven-day-expiry).

**Verify the result:** registration, tool discovery, an actual peer reply, and
a peer reply after a scheduled check are separate outcomes. Report what you
observed. An open loop alone does not prove the other participant is running.

### Optional: live pings between Claude Code sessions

The mailbox and `/loop` are the durable path, and they are slow by design: a
message waits for the receiver's next scheduled check. When several Claude
Code sessions run for the same team (for example a coordinator, a builder and
a tester), you can add an immediate wake-up on top, without changing the
mailbox:

- Claude Code's `ListAgents` shows the other sessions you can reach, by name,
  and whether each is busy or idle. A message sent with `SendMessage` to that
  name reaches the session on its next tool round.
- Add one rule to each session's project instructions: when a task finishes
  or a hand-off needs another agent, **send the mailbox message first** (the
  record), then ping the receiving session by name with a one-line summary
  that points at the mailbox message.
- Do not ping a session that shows as busy for routine updates; it will see
  the mailbox message at its next check.

Limits to know:

- It only reaches sessions you can already see in `ListAgents` (the same
  machine, or sessions connected through Remote Control). It does not reach
  other people's machines; the mailbox does.
- A ping is not authority. A session in a stricter permission mode may hold
  an incoming ping for its user, and a ping never counts as approval for
  anything the receiver would otherwise need confirmed.
- It is Claude Code only. Other providers should keep using the mailbox and
  their own wake-ups.
- The mailbox message is still the source of truth. If a ping is lost, the
  next `check_inbox` finds the same work.

## 4. Project instructions: CLAUDE.md

Codex reads `AGENTS.md`; Claude Code reads `CLAUDE.md`. In the *development
project* (not the Dead Drop clone), keep one source of truth by importing
the existing file from `CLAUDE.md`:

```markdown
@AGENTS.md
```

## 5. Onboarding prompt for Claude Code

Give this to Claude Code in the session where development should continue,
after replacing the three placeholders:

> Set up Dead Drop from DEAD_DROP_ROOT for development in PROJECT_ROOT, using
> private mailbox OWNER/PRIVATE-MAILBOX and my own GitHub account. Follow
> Dead Drop's docs/DEV-COORDINATION.md and docs/CLAUDE-CODE.md. Install
> dependencies and run `node setup.mjs --claude` (add `--no-codex` if this computer has no Codex), initialize storage only if I
> am its designated owner, and verify `node cli.mjs team_status` works. Then
> start a `/loop` on this session using the complete WAKE-PROMPT.md
> instructions, with DEAD_DROP_ROOT and PROJECT_ROOT replaced by absolute paths.
> This authorizes project-scoped agent messages, handling development
> handoffs, relevant tests, feature branches and draft PRs; it does not
> authorize main merges, deployments or unrelated work. Report whether the
> loop was actually started. Interactive authentication stays with me; do not
> request my token.

## 6. Several agents on one GitHub account

If more than one agent shares the same GitHub login (for example two Claude
Code sessions on one machine), note that:

- Setup labels every worker `<login> development worker`. Send an `update`
  early saying which agent you are, so people reading `team_status` can tell
  them apart.
- A message addressed to a login reaches **every** worker under it. Address an
  exact worker ID (from `team_status`) when you mean one agent.
- Use a separate Dead Drop clone per agent so each keeps its own stable
  identity and pending work.
