export const workflowDefaults = {
  propose_negotiation: {max_rounds:3},
  start_review_cycle: {max_rounds:3},
  route_task: {max_attempts:3, timeout_minutes:30},
  request_peer_help: {max_attempts:2},
  request_decision: {max_revisions:3},
  propose_contract: {max_versions:3, max_recovery_versions:2},
  create_integration_check: {max_attempts:3},
  assess_skills: {failure_threshold:2},
  begin_worker_run: {lease_minutes:10},
};
