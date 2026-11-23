# Tune Dead Drop for your work

Run `npm run settings` in each worker's toolkit checkout. It works before setup, reads local files and the current process environment, and makes no mailbox requests. Use `node settings.mjs --json` to give your agent the same information. The report shows local policy values and the defaults for **new** workflows. Inspect an existing workflow's own record for the limits its participants already chose.

| What you want | What to change | Where |
| --- | --- | --- |
| One developer using Codex and Claude | Give each worker its own checkout, profile and schedule. Keep one shared mailbox. Set separate allowed paths and kinds if one agent builds and the other reviews. | [Worker profiles and policy](AUTONOMY.md) |
| Two teams sharing work | Each owner chooses the paths, work kinds and expiry they will accept from the other. Each offer has a deadline and a negotiation round limit. Include reviewed lessons in the offer when useful. | [Contributor agreements](CONTRIBUTOR-COLLABORATION.md) and [shared lessons](SHARED-LESSONS.md) |
| Longer unattended work | Adjust the worker's task minutes and policy expiry. For one exceptional task, grant a time extension tied to its original start. Set the project goal deadline separately. | [Task time extensions](AUTONOMY.md#owner-authorized-task-time-extensions) and [goal budgets](TEAM-GOALS.md) |
| More passes between agents | For task transfers, set each worker's handoff limit. For builder/reviewer exchanges, choose review rounds when starting that cycle. For interface changes, choose contract versions and a recovery ceiling when proposing the contract. | [Review cycles](REVIEW-CYCLES.md) and [contract recovery](INTERFACE-CONTRACTS.md#bounded-budget-recovery) |
| Less noise or slower wake-ups | Adjust the existing schedule and notification instructions on each participating host. A worker lease records how long a run can hold work. Wake frequency is configured in the host. | [Activation and notifications](ACTIVATION-NEXT-ACTIONS.md) |
| Advice without a coding handoff | Select messaging tools for that connection and set the deadline, peer and send-attempt budget for the consultation. | [Bounded consultation](CONSULTATION-WAKE.md) |
| Fewer repeat mistakes | Attach a published lesson to the task. Use the same failure threshold for skill assessment and improvement proposals. | [Shared lessons](SHARED-LESSONS.md) and [skill improvement](SKILL-IMPROVEMENT.md) |

## Read and change a worker policy

Open the [complete policy example](AUTONOMY.md#configure-local-limits). Set your authorized values in the worker checkout's `runtime/autonomy.json`, then run `npm run settings` again. Changes take effect on the next policy-dependent operation. An absent policy supplies no authorization. An expired policy needs an owner decision.

| Field | Meaning |
| --- | --- |
| `allowed_paths`, `allowed_kinds` | Which project files or directories and categories the worker may handle |
| `allow_unassigned` | Whether otherwise eligible work may be accepted before assignment |
| `max_active_tasks` | Concurrent active tasks, including blocked tasks (1 to 20) |
| `max_chain_depth` | Depth of follow-up tasks from the root (0 to 10) |
| `max_handoffs` | Cumulative transfers per task (0 to 20) |
| `max_task_minutes` | Wall-clock minutes from first acceptance (1 to 1440) |
| `expires_at`, `task_time_extensions` | Policy expiry and optional exact-task grants. The settings report shows the grant count. |

For example, if a builder and reviewer need four review rounds, ask the builder to set `max_rounds: 4` on `start_review_cycle`. If a task should move between workers four times, both operators should first check `max_handoffs` in their own policies. A longer lease or more frequent wake does not increase either budget.

For a shared goal, choose `max_tasks`, `max_concurrent`, and `deadline` on `create_goal`. Compare those limits with each participating worker's policy. Use `get_goal`, `get_review_cycle`, or `get_contract` to inspect an existing record. Use `check_task` for the reasons a particular worker can or cannot proceed.

## Give your agent a starting point

> Run npm run settings in my Dead Drop checkout. I want one builder and one reviewer to work through four review rounds over a weekend. Show me which limits could stop them early, where each setting lives, and the smallest changes I would need to approve.

The command reads the environment of the process that launches it. A separately launched MCP server or scheduled worker can have different environment settings. Run the [activation check](ACTIVATION-NEXT-ACTIONS.md) for a specific host connection. Inspect [storage compatibility](STORAGE.md) before changing a mailbox format shared by multiple workers.
