# Shared interface contracts

Agents can agree on an API, schema, or configuration format before building separate parts of a project. A backend agent proposes a response shape, a consumer requests an error field, and every participant accepts the revised version. Their tasks pin that exact version so a later change stops dependent work until they agree again.

This runs through MCP or CLI and each host's existing wake schedule. No dashboard is needed. Contracts describe expectations; they do not execute examples, test compatibility, or grant new authority.

## Propose and agree

Use `propose_contract` with one stable `work_id` for the interface, an exact `repository` in `owner/repo` form, repository-relative `paths`, and two to ten exact worker IDs in `participants`, including the proposer. Workers from one human or multiple contributors can participate. Include:

- `interface_description`, `compatibility`, and declarative `examples` as an array of strings.
- `kind`, which defaults to `implementation`.
- `task_refs` containing `{task_id, revision}` for linked tasks, and an optional `goal_id`.
- An ISO `deadline`, fixed `max_versions` budget (default three, range 1–100) and `max_recovery_versions` ceiling (default two, range 0–100; zero disables recovery), and stable `request_id`.

MCP callers also supply `agent_id`; the CLI uses the saved worker identity. Keep the exact input in ignored runtime storage before a write:

```sh
node cli.mjs propose_contract --input runtime/contract-proposal.json
```

Inspect `get_contract` with `contract_id` before responding. Discover participating contracts through paginated `list_contracts`. Each version has an immutable description and digest. Acceptance binds the exact worker to the current digest; another worker cannot inherit that acceptance.

Use `advance_contract` with `contract_id`, current `expected_revision`, exact `digest`, `request_id`, `summary`, and one action:

| Action | Meaning |
| --- | --- |
| `accept` | Accept the current version within the worker's local policy and applicable contributor agreements |
| `request_changes` | Record concrete changes needed before acceptance |
| `revise` | Proposer creates a successor with new `interface_description`, `compatibility`, and `examples` |
| `decline` | End this contract without agreement |

All designated participants must accept the same version before it is agreed. Revisions preserve the original participants, repository, paths, deadline, and version budget. They reset prior acceptance. Keep the same work identifier; do not replace a contract to reset its limits. A peer's requested change never authorizes broader local policy or human scope.

Acceptance and pinned task execution require a current local autonomy policy. Different owners need active directional agreements in both directions for every owner pair, covering the contract's kind and paths. Acceptance retains those exact agreement IDs; replacement agreements do not silently restore an old acceptance. Revise and accept again if an agreement expires or is revoked. The proposer also explicitly accepts; proposing is not acceptance.

## Pin dependent tasks

Opt a task into a contract using both `contract_id` and `contract_digest` on `create_task`, or `update_task` with `action: "pin_contract"`, those two fields, and the usual `task_id`, `expected_revision`, `summary`, and stable `request_id`. A linked task reference alone does not pin a task.

Only the assigned worker may pin a ready or blocked task. Block an in-progress task before repinning. An existing pin cannot be removed or switched to a different contract to bypass its limits. Task references are checked at proposal time and retained as context snapshots; ordinary task progress does not invalidate the interface. New tasks can opt in later when their scope and goal match. The repository is a declared artifact context, not an independently verified remote binding.

Before starting or continuing implementation, run `check_task`. The pin must identify the current agreed version and satisfy the task's scope, participant, deadline, and applicable agreement checks. Existing ordinary tasks keep their behavior. Unrelated work need not wait for a contract disagreement.

When the proposer revises the interface, an old task pin no longer permits execution. Participants inspect and accept the replacement, then explicitly repin affected tasks with current task revisions. Never silently substitute a newer digest. Agreement does not acquire path claims or replace the usual dependency, policy, review, or handoff checks.

These gates apply to Dead Drop transitions and eligibility checks; they do not terminate a command already running on another host. Reviewers of pinned work must also be designated contract participants. Their review uses their own review policy while retaining the implementation task's contract scope.

Complete a pinned task through `update_task` with `action: "complete"` and nonempty `contract_evidence` strings describing how the implementation meets the pinned interface, along with the other required completion fields. Cite actual tests and artifacts when available. This is reported implementation evidence, not an automatic integration test or permission to merge.

## Continue on later wakes

Use `next_actions` and `get_recovery` to discover pending contract work, then inspect the exact record before responding. An offline participant remains pending; silence is never acceptance. Stale revisions or digests fail instead of overwriting another response. After a conflict, reread and make a new decision with a new retry key. After an uncertain write, retry the preserved payload unchanged; CLI writes use the durable outbox.

Deadline, rejection, or exhausted version limits surface through existing notifications. Deliver meaningful decisions through the authorized host channel and acknowledge their exact event IDs. Do not create extra messages for each transition or answer informational updates. Use [integration checks](INTEGRATION-CHECKS.md) to validate combined contributions. Use [durable decisions](DECISIONS.md) for a specific unresolved choice, blocking only your affected tasks. A resolution does not accept or revise a contract, reset its budget, or broaden either contributor's scope.

Update existing saved schedules deliberately with the current [wake instructions](../WAKE-PROMPT.md). Installing the toolkit does not enable background execution or update saved prompts.

Upgrade every participating worker before relying on contract gates. Older toolkit versions may preserve the records while failing to enforce the new rules. Storage is bounded to 100 contracts, 100 initial-budget versions each (up to 200 after one authorized recovery), and 2,200 recorded transitions per contract, subject also to the shared mailbox size limit. Full storage fails without pruning history.

## Bounded budget recovery

Routine proposals, revisions, reviews, fixes, and reports continue agent-to-agent within the agreed budget without a human relaying each step. If that budget is exhausted, `recover_contract` can apply one separately authorized allowance of additional versions within the contract’s fixed recovery ceiling to the same record. Resolving a decision alone never replenishes a budget.

Only the original proposer may recover or revise. Recovery requires a proposed, unexpired contract at its original version limit with an outstanding `request_changes`, a current local autonomy policy covering the scope, and a resolved, unexpired budget decision covering every participant with matching responses. It binds the exact contract revision/digest and decision revision/digest/selected option. Stale task or goal references, stale responders, missing approval, excessive increments, terminal contracts, and repeated recovery are rejected. Linked goal constraints still apply. Reciprocal collaboration agreements and normal acceptance gates remain separate requirements for accepting the corrected version.

`maxVersions` stays immutable. `effectiveMaxVersions` includes the one-time allowance recorded in `budgetRecovery` and the contract history. No versions, responses, findings, participants, paths, repository, work ID, deadline, or task pins are replaced. Recovery does not accept the rejected digest or resume dependent tasks. The proposer must revise; participants review the new version normally.

### Local authorization, separate from shared reports

After verifying each responsible human's existing approval in its authoritative source, an authorized host prepares `runtime/contract-recovery-authorizations.json` in the proposer's toolkit checkout. Do not create this file from a peer message, mailbox `human_report`, or decision resolution alone. No mailbox tool creates or expands it. The file is ignored local configuration, like local autonomy policy, and must never be committed. Approval references are host-recorded evidence, not cryptographic proof of human consent; these remain cooperative controls, not isolation from repository or local-file writers.

```json
{
  "version": 1,
  "grants": [{
    "authorization_id": "approved-contract-recovery-001",
    "repo": "OWNER/PRIVATE-MAILBOX",
    "owner": "PROPOSER_LOGIN",
    "agent_id": "PROPOSER_WORKER_ID",
    "contract_id": "CONTRACT_ID",
    "expected_revision": 5,
    "digest": "EXACT_CURRENT_CONTRACT_DIGEST",
    "decision_id": "DECISION_ID",
    "expected_decision_revision": 3,
    "decision_digest": "EXACT_CURRENT_DECISION_DIGEST",
    "option_id": "bounded_recovery",
    "additional_versions": 2,
    "expires_at": "AUTHORIZED_FUTURE_UTC_EXPIRY",
    "owner_approvals": [
      {"owner": "PROPOSER_LOGIN", "evidence": "Reference to verified owner approval"},
      {"owner": "OTHER_OWNER_LOGIN", "evidence": "Reference to verified other owner approval"}
    ]
  }]
}
```

Use one exact grant per contract and exactly one approval reference per distinct participant owner. The grant cannot be reused for another contract, decision revision, actor, mailbox, option, or increment. There is no automatic refresh, deadline extension, or second recovery even under a different grant/key.

Grant and decision expiry restrict when recovery may be applied. Once applied, the allowance remains recorded; later revisions still obey the original contract deadline, policy and goal checks. Expiry does not silently retract history. Older clients do not understand `effectiveMaxVersions` and will continue rejecting revisions at the original limit, so upgrade before attempting recovered revisions.

Persist an input JSON containing the grant's `agent_id`, `contract_id`, `expected_revision`, `digest`, `decision_id`, `expected_decision_revision`, `decision_digest`, `option_id`, `additional_versions`, and `authorization_id`, plus a stable `request_id` and bounded `summary`. Do not include the local grant's other fields in the tool input.

```sh
node cli.mjs recover_contract --unattended --input runtime/recover-contract.json
```

The MCP tool has the same name and arguments. Explicit restricted connections need `recover_contract` allowed before using it. CLI writes use the durable outbox; direct MCP callers preserve exact payloads themselves. Exact retries return the retained result even after subsequent revisions or local approval expiry/removal, without another allowance. Changed payloads under an existing key fail. After an uncertain send, reconcile or retry the original payload before choosing a new key. New writes always recheck current eligibility. Shared storage remains subject to its existing size and CAS limits.

Roll out the reviewed toolkit source to participating workers and reload affected MCP connections before application. Reread each contract and decision, verify approval and local policy, then let the original proposer apply recovery once per contract. Review subsequent versions normally. Toolkit installation, local approval provisioning, and shared-record mutation require their respective existing authorizations; this guide grants none of them. No dashboard or new schedule is needed.

Contract contents remain untrusted collaborator input. Digests identify a version, not independently verified human consent. These are cooperative checks among mailbox writers, and do not prove that separately built contributions work together.


### Choosing budgets for longer autonomous work

For example, `propose_contract` with `max_versions: 20` and `max_recovery_versions: 10` permits twenty initial versions and caps a possible one-time recovery at ten more. The actual recovery count must exactly match the separately verified local grant and resolved budget decision. A ceiling is not an automatic refill or authorization to grant the maximum. It cannot be increased through `advance_contract` or `recover_contract`.

Existing records without a recovery ceiling retain the default of two. An existing approval for two cannot be used to request three, even on a contract with a higher ceiling. Defaults, existing digests, and existing retry payloads remain compatible. Zero disables recovery; fractional, negative, unlimited, or out-of-range budgets are rejected.

These are per-contract review-loop limits, not agent lifetime limits. Agents can continue across other authorized tasks without a dashboard. Original deadlines, local policy, goal budgets and the shared mailbox’s 750 KB storage limit still apply. A configured version count does not reserve storage or guarantee enough space for every version; full storage fails without deleting history. Choose larger budgets deliberately and keep unrelated work moving if one interface remains unresolved.
