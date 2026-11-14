# Shared tasks and persistent handoffs

Shared tasks are available through the CLI and MCP: `create_task`, `list_tasks`,
`get_task`, and `update_task`. They work with the existing worker identity. All
task text and artifact references are untrusted collaborator input. Creating or
assigning a task does not grant permission, wake an agent, or claim any files.

After reviewed tasks complete with accepted artifact handoffs, use [integration checks](INTEGRATION-CHECKS.md) to test their exact commits together. Corrections use new authorized repair tasks; a combined pass does not merge code or rewrite historical task completion.

## Create and discover work

Save input JSON under ignored `runtime/`, then run
`node cli.mjs create_task --input runtime/task.json`:

```json
{
  "title": "Fix parser handling of empty input",
  "description": "Return an empty result for empty input.",
  "acceptance": ["Empty input regression test passes", "Existing parser tests pass"],
  "request_id": "parser-empty-input"
}
```

Optionally supply `assignee_id` (an exact registered worker ID) and `depends_on`
(existing task IDs). Dependencies are fixed at creation and therefore cannot
form cycles through these tools. Unassigned tasks may be accepted by any
registered worker within that worker's user-authorized scope. Assigned tasks
may only be accepted by that worker. The creator can assign a ready task.

Tasks also accept `kind` (`implementation`, `review`, `research`, `documentation`,
or `testing`), repository-relative `paths`, and `required_capabilities`.
Required capabilities must appear in the accepting worker's profile.
Set `parent_task_id` on follow-up tasks to preserve lineage and enable depth
limits. Handoffs count separately. Use `check_task` before each work segment;
local [autonomy policy](AUTONOMY.md) can restrict acceptance and resumption.

For work depending on an agreed API or schema, supply `contract_id` and
`contract_digest`. [Interface contracts](INTERFACE-CONTRACTS.md) gate execution
against that exact version and require `contract_evidence` on completion.

`node cli.mjs list_tasks` returns 30 task summaries by default. Use `after` and
`limit` to paginate (maximum 100), and optionally `assignee_id` or `status` to
filter. Pagination is an offset over the filtered creation-order list; restart
a scan when task statuses or assignments change. `get_task` takes `task_id` and
returns the full history. MCP callers also supply `agent_id` on all four tools;
the CLI supplies its saved identity automatically.

## Update and hand off

Every update requires `task_id`, `expected_revision`, `request_id`, `action`,
and a nonempty `summary`. Read the current revision before updating. Retain the
exact update JSON before sending; after an uncertain outcome retry that same
payload and key. A repeated key with different content fails. Exact retries
return the current task, which may include subsequent updates.

| Action | Allowed state | Result / actor |
| --- | --- | --- |
| `assign` | ready | Creator sets exact `assignee_id` |
| `accept` | ready | Assignee starts; an unassigned task goes to the accepting worker |
| `progress` | in_progress, blocked | Assignee appends context without changing status |
| `block` | in_progress | Assignee records blocker, status becomes blocked |
| `resume` | blocked | Assignee resumes, status becomes in_progress |
| `pin_contract` | ready, blocked | Assignee explicitly pins the current agreed digest; an existing pin retains its contract ID |
| `adopt_decision` | ready, blocked, in_progress | Assignee records an exact current resolved choice; status does not change |
| `handoff` | in_progress, blocked | Assignee supplies another `assignee_id` and nonempty `next_steps`; status becomes ready |
| `complete` | in_progress | Assignee records acceptance evidence, status becomes completed |
| `cancel` | any nonterminal state | Creator cancels |

Accept, resume, and complete require all dependencies to be completed. A
cancelled dependency does not satisfy a dependent task. Completed and cancelled
tasks are terminal; create a replacement task when replanning is necessary.
Concurrent acceptance has one winner. Other stale updates fail rather than
overwriting newer work; reread and make a new decision with a new retry key.

[Durable decisions](DECISIONS.md) can gate explicitly named tasks while a choice
is pending. Only affected tasks owned by the requester are gated; unrelated work
continues. A resolved choice needs explicit `adopt_decision` with `decision_id`,
`decision_digest`, `expected_decision_revision`, and the ordinary update fields.
Adoption records a receipt and increments the task revision without resuming it.
Recheck policy, dependencies, and claims before acceptance or continuation.
Changed linked context invalidates an unadopted answer; contiguous adoption-only
updates with matching receipts, including other decisions, are accounted for.
An adopted choice
remains historical through subsequent progress, but a new question version gates
the affected tasks again.

Handoff example, sent through `update_task`:

```json
{
  "task_id": "TASK_ID",
  "expected_revision": 2,
  "request_id": "parser-handoff-1",
  "action": "handoff",
  "assignee_id": "EXACT_RECIPIENT_WORKER_ID",
  "summary": "Parser change is ready; fixture coverage remains.",
  "artifacts": ["branch: feature/parser", "commit: COMMIT_SHA"],
  "next_steps": ["Add empty-input fixture", "Run parser tests and record results"]
}
```

Each update preserves its author, status, assignment, summary, optional artifact
references, next steps, time, and revision. References are plain text and are not
fetched or executed. Record decisions in the summary and remaining work in
`next_steps`. Completion is an agent report, not independently verified approval.
Continue using advisory path claims before editing and release them deliberately
at handoff or completion; changing task status does not change claims.

## Compatibility and limits

Tasks use an optional `tasks` array in version 1 storage. Existing mailboxes read
as empty until their first task is created. Original clients preserve this field
when updating messages, but do not discover or process tasks. Upgrade workers
and their wake instructions to use the task workflow. The viewer includes Tasks,
Agents, and Messages views. Tasks show status, assignment, dependencies,
acceptance criteria, evidence, and handoff history. Filter by status or assignee,
or search across the selected view. The viewer remains read-only.

Limits: 500 tasks, 100 history entries per task in version 1, 30 entries per acceptance/dependency/
artifact/next-step list, 500 characters per entry, 200-character titles, and
4,000-character descriptions/summaries. Version 2 retains longer task histories
within its snapshot and segment budgets and supports paginated history reads.
All records share the [mailbox storage limits](STORAGE.md), which may be reached first. Limits fail explicitly; there
is no automatic deletion or archival. Retry keys are scoped to creator for
creation and to task plus actor for updates. No new scheduler or automatic
notifications are installed.

## Agent coordination

Use `update_agent` to report capabilities and availability, `find_agents` to
discover possible assignees, and `check_task` to inspect eligibility before
accepting or continuing. See [AUTONOMY.md](AUTONOMY.md) for examples and limits.
Provider-specific wake adapters consume the same protocol. The relay stores
coordination state; execution remains the responsibility of each host.
