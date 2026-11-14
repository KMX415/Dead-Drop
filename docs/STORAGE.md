# Mailbox storage

Dead Drop supports two private mailbox formats. New and existing installations continue using version 1 unless an operator explicitly migrates them. No dashboard is needed for either format.

| | Version 1 | Version 2 |
| --- | --- | --- |
| Storage | One `mailbox.json` document | Small manifest and immutable, SHA-256-addressed segments |
| Logical snapshot limit | 750,000 UTF-8 bytes | 32,000,000 UTF-8 bytes |
| Physical segment limit | Not applicable | 240,000 UTF-8 bytes |
| Task history | At most 100 entries | Retained within the snapshot and segment budgets |
| Publication | Contents API compare-and-swap | Git commit followed by non-forced branch update |
| Compatibility | Existing clients | Upgraded clients only |

The new format preserves worker IDs, message IDs, sequence numbers, task revisions, full histories, retry fingerprints, agreements, and archived run records. It does not reset or extend authorization, execution, routing, review, contract, or consultation budgets. Other collection limits still apply.

## Before migrating

Migration is a coordinated operator action, not an autonomous recovery suggestion. Obtain authorization for the target mailbox and arrange a quiet window for its writers. Upgrade every client that reads or writes that mailbox, including separate machines and bundled engines. Keep the mailbox private and separate from development code.

**The frozen Dead Drop Hermes plugin release does not support version 2. Do not migrate a mailbox that it still uses.** Updating this toolkit does not update another product's bundled engine. There is no compatibility mirror for old clients: they reject the version 2 manifest instead of writing incomplete state.

Record the current storage branch commit and retain a private recovery copy before migration. Never merge the `dev-agent-mailbox` branch into a code branch. Migration itself preserves the preceding commit and does not delete history or old files.

## Inspect, then apply

From an upgraded toolkit checkout with an authenticated GitHub user who has write access, run a read-only plan with an explicit repository:

```sh
node storage.mjs --repo OWNER/PRIVATE-MAILBOX
```

The plan reports the exact `head`, proposed format, snapshot bytes, and segment count. It does not register workers, change schedules, or write mailbox data. Check that the repository is the intended mailbox and that every participant has upgraded.

Only after that check and authorization, substitute the full 40-character `head` from the plan:

```sh
node storage.mjs --repo OWNER/PRIVATE-MAILBOX --apply --expected-head FULL_COMMIT_SHA --all-clients-upgraded
```

The confirmation flag is an operator assertion, not automatic discovery of installed clients. A changed branch head stops migration; inspect a fresh plan and reconcile activity before trying again. Restricted agent connections configured with `DEAD_DROP_TOOLS` cannot invoke this migration CLI.

Read a harmless mailbox query with each upgraded client before resuming work. Preserve the reported `previousHead` and new `head` privately. Do not generate fresh worker identities, replacement tasks, or new request IDs to work around uncertain results.

## Atomic writes and recovery

Readers pin their manifest and segment reads to one Git commit and verify segment hashes. Writers upload new objects, construct one commit, and publish it with a non-forced update of the storage branch. Competing sibling commits cannot both fast-forward; normal coordination writes reread and retry using the existing bounded conflict handling.

An interruption before publication leaves the previous snapshot active. An interruption after publication can leave the caller unsure whether the write succeeded. For migration, rerun the read-only plan: it reports `alreadyMigrated` after successful publication. For coordination writes, follow the [durable outbox workflow](RECOVERY-HEALTH.md), inspect current state, and retry the exact saved payload and request ID. Do not invent a replacement request. Unpublished Git objects can remain after failed attempts.

Missing, malformed, oversized, or hash-mismatched segments stop the read. Do not initialize over corruption or force-push an older snapshot as routine recovery. Inspect the last known good commit and affected writes first. Restoring an old snapshot after subsequent work would lose coordination records and could permit repeated effects. There is no automated downgrade or garbage collector.

## Reading long task histories

On version 2, `get_task` returns the latest 30 history entries by default. To inspect from the beginning, use `history_after: 0` and a `history_limit` from 1 to 100. Follow `historyPagination.nextAfter` while `hasMore` is true. The pagination record includes the task revision and total entries; if the revision changes between pages, restart the inspection for a consistent view.

Task mutation tool responses with more than 100 history entries also return the latest 30 entries and pagination metadata. Storage and internal checks retain the complete history, so pagination does not discard retry or review evidence. Version 1 reads retain their previous default behavior; explicit history pagination is available there too.

## Capacity and validation boundaries

This is bounded segmented snapshot storage, not an unlimited database. Each read reconstructs the complete logical snapshot in memory. A cold read fetches all referenced segments; verified segments are cached in the current process up to 32 MB. Short-lived CLI processes start with a cold cache. GitHub API requests, latency, and rate limits still matter. A small change can reuse unchanged content, but changes that shift chunk boundaries may rewrite multiple segments.

Snapshots additionally enforce at most 4,096 segment visits and bounded graph depth. Old immutable files remain in the storage tree and Git history, so repository storage continues growing. Removing message records does not erase Git history. Size and integrity checks are separate from work authorization.

Automated tests use an isolated Git API fixture to cover migration, larger snapshots, simultaneous writers, interrupted publication, exact retries, old-client rejection, corruption, privacy checks, and long task histories. No production mailbox needs to be migrated to run `npm test`.

A live GitHub test on November 14, 2026 passed in a separate private mailbox containing only synthetic data. It migrated a 684,254-byte snapshot without changing its records, updated a task beyond 100 history entries, and round-tripped a 1,614,741-byte snapshot through a fresh reader. Competing writers produced a real GitHub conflict and successful retry without losing either message. Injected failures before publication and after a successful publication verified unchanged-state recovery and duplicate-free message retries. The actual pre-change transport rejected both the new format and a stale write; linked answers and acknowledgements also survived fresh reads.

That run used two worker identities under one GitHub account. It did not test independent account permissions, the full 32 MB ceiling, sustained throughput, or a Hermes plugin upgrade. No production mailbox was migrated. Detailed test payloads, identities, and evidence remain outside the source repository.
