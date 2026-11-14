import { decisionTaskReasons, assertDecisionAdoption } from './decisions.mjs';
import { assertGoalTask } from './goals.mjs';
import { assertContractTask, contractPin } from './contracts.mjs';
import { randomUUID } from 'node:crypto';
import { taskKinds, relativePath, eligibility, within } from './coordination.mjs';
import { assertTaskReviewAction } from './review-cycles.mjs';
import { assertCollaborationTaskAction } from './collaboration.mjs';
import { assertVerifiedHandoff } from './handoffs.mjs';

export const taskStatuses = ['ready', 'in_progress', 'blocked', 'completed', 'cancelled'];
const text = (value, name, max = 4000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${name}`);
  return value.trim();
};
const list = (value, name) => {
  if (!Array.isArray(value) || value.length > 30) throw new Error(`Invalid ${name}`);
  return [...new Set(value.map(v => text(v, name, 500)))];
};
const records = state => state.tasks ??= [];
const known = (state, id) => {
  if (!Object.hasOwn(state.agents, id)) throw new Error('Assignee must be an exact registered agent ID');
};

export async function createTask({agent_id, title, description, acceptance, assignee_id, depends_on = [], request_id,
  kind='implementation', paths=[], required_capabilities=[], parent_task_id, goal_id, contract_id, contract_digest}) {
  title = text(title, 'title', 200); description = text(description, 'description');
  acceptance = list(acceptance, 'acceptance');
  if (!acceptance.length) throw new Error('Specify acceptance criteria');
  depends_on = list(depends_on, 'dependencies'); request_id = text(request_id, 'request_id', 120);
  if (!taskKinds.includes(kind)) throw new Error('Invalid task category');
  paths=list(paths,'paths').map(relativePath);
  required_capabilities=list(required_capabilities,'capabilities').map(c=>c.toLowerCase());
  const payload = {title, description, acceptance, assigneeId:assignee_id ?? null, dependsOn:depends_on,
    kind,paths,requiredCapabilities:[...new Set(required_capabilities)],parentTaskId:parent_task_id??null,...(goal_id?{goalId:text(goal_id,'goal_id',150)}:{}),...contractPin(contract_id,contract_digest)};
  const policy=await this.readPolicy();
  const fingerprint = JSON.stringify(payload), id = randomUUID();
  return this.change(state => {
    const actor = this.actor(state, agent_id), tasks = records(state);
    const old = tasks.find(t => t.createdBy === agent_id && t.requestId === request_id);
    if (old) {
      if (old.fingerprint !== fingerprint) throw new Error('request_id already used for different content');
      return old;
    }
    if (tasks.length >= 500) throw new Error('Task registry full; archive deliberately before continuing');
    if (assignee_id !== undefined) known(state, assignee_id);
    if (depends_on.some(dep => !tasks.some(t => t.id === dep))) throw new Error('Unknown dependency');
    const parent=parent_task_id ? tasks.find(t=>t.id===parent_task_id) : null;
    if (parent_task_id && !parent) throw new Error('Parent task not found');
    if(parent?.goalId) { if(goal_id && goal_id!==parent.goalId) throw new Error('Child task must retain parent goal'); payload.goalId=parent.goalId; }
    const chainDepth=parent?(parent.chainDepth??0)+1:0;
    if (policy && chainDepth>policy.max_chain_depth) throw new Error('Task chain depth exceeds policy; ask the user');
    const now = this.now();
    const task = {id, ...payload, createdBy:agent_id, requestId:request_id, fingerprint,
      status:'ready', revision:1, createdAt:now, updatedAt:now, chainDepth,handoffCount:0,history:[]};
    assertGoalTask(state,task,actor,now,'create');
    assertContractTask(state,task,actor,now);
    tasks.push(task); actor.seenAt = now; return task;
  });
}

export async function listTasks({agent_id, assignee_id, status, after = 0, limit = 30}) {
  const {state} = await this.store.read(); this.actor(state, agent_id);
  if (status !== undefined && !taskStatuses.includes(status)) throw new Error('Invalid task status');
  if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid task pagination');
  const tasks = (state.tasks ?? []).filter(t => (!assignee_id || t.assigneeId === assignee_id) && (!status || t.status === status));
  const page = tasks.slice(after, after + limit).map(({history, fingerprint, ...task}) => task);
  return {tasks:page, nextAfter:after + page.length, hasMore:after + page.length < tasks.length};
}

export function taskHistoryPage(task,after=0,limit=30) {
  if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Invalid task history pagination');
  const history=task.history.slice(after,after+limit);
  return {...task,history,historyPagination:{after,nextAfter:after+history.length,hasMore:after+history.length<task.history.length,total:task.history.length,revision:task.revision}};
}
export async function getTask({agent_id, task_id, history_after, history_limit}) {
  const {state} = await this.store.read(); this.actor(state, agent_id);
  const task = (state.tasks ?? []).find(t => t.id === task_id);
  if (!task) throw new Error('Task not found');
  if(state.version===2 || history_after!==undefined || history_limit!==undefined)
    return taskHistoryPage(task,history_after??Math.max(0,task.history.length-(history_limit??30)),history_limit??30);
  return task;
}

export async function updateTask({agent_id, task_id, expected_revision, request_id, action, summary, assignee_id, artifacts = [], next_steps = [], handoff_id, contract_id, contract_digest, contract_evidence, decision_id, decision_digest, expected_decision_revision}) {
  request_id = text(request_id, 'request_id', 120); summary = text(summary, 'summary');
  artifacts = list(artifacts, 'artifacts'); next_steps = list(next_steps, 'next_steps');
  if (!['assign', 'accept', 'progress', 'block', 'resume', 'handoff', 'complete', 'cancel', 'evidence', 'pin_contract', 'adopt_decision'].includes(action)) throw new Error('Invalid task action');
  const adoption=action==='adopt_decision'?{decision_id:text(decision_id,'decision_id',150),decision_digest:text(decision_digest,'decision_digest',64),expected_decision_revision}:null;
  if(adoption&&(!Number.isInteger(expected_decision_revision)||expected_decision_revision<1))throw new Error('Invalid expected_decision_revision');
  if(!adoption&&[decision_id,decision_digest,expected_decision_revision].some(v=>v!==undefined))throw new Error('Decision fields require adopt_decision');
  const pin=contractPin(contract_id,contract_digest);
  if(action==='pin_contract'&&!pin.contractId)throw new Error('Pin requires contract ID and digest');
  if(action!=='pin_contract'&&pin.contractId)throw new Error('Only pin_contract changes a contract pin');
  if(contract_evidence!==undefined) {
    if(action!=='complete')throw new Error('Contract evidence only applies to completion');
    contract_evidence=list(contract_evidence,'contract_evidence');
  }
  if (!Number.isInteger(expected_revision) || expected_revision < 1) throw new Error('Invalid expected_revision');
  if (!['assign','handoff'].includes(action) && assignee_id !== undefined) throw new Error('Assignee only allowed for assign or handoff');
  if (handoff_id!==undefined) {
    handoff_id=text(handoff_id,'handoff_id',150);
    if (!['handoff','complete'].includes(action)) throw new Error('Handoff evidence only applies to handoff or complete');
  }
  const fingerprint = JSON.stringify({expected_revision, action, summary, assignee_id, artifacts, next_steps,...(adoption??{}),...(handoff_id?{handoff_id}:{}),...pin,...(contract_evidence!==undefined?{contract_evidence}:{})});
  let policy=null;
  if (['accept','resume','handoff','pin_contract','adopt_decision'].includes(action)) policy=await this.readPolicy();
  else if (['progress','complete'].includes(action)) {
    const {state}=await this.store.read();this.actor(state,agent_id);
    const current=(state.tasks??[]).find(t=>t.id===task_id);
    const old=current?.history.find(h=>h.actorId===agent_id && h.requestId===request_id);
    if (old) {
      if (old.fingerprint!==fingerprint) throw new Error('request_id already used for different content');
      return current;
    }
    if (current?.negotiationId || current?.goalId || current?.contractId || current?.decisionReceipts?.length) policy=await this.readPolicy();
  }
  return this.change(state => {
    const actor = this.actor(state, agent_id), tasks = records(state), task = tasks.find(t => t.id === task_id);
    if (!task) throw new Error('Task not found');
    const old = task.history.find(h => h.actorId === agent_id && h.requestId === request_id);
    if (old) {
      if (old.fingerprint !== fingerprint) throw new Error('request_id already used for different content');
      return task;
    }
    if (task.revision !== expected_revision) throw new Error('Task revision changed; read task before updating');
    if(!['block','cancel','evidence','pin_contract','adopt_decision'].includes(action))assertContractTask(state,task,actor,this.now());
    if(assignee_id)assertContractTask(state,{...task,assigneeId:assignee_id},actor,this.now());
    if(['assign','accept','resume','progress','complete','handoff'].includes(action)) {
      const reasons=decisionTaskReasons(state,task,this.now());
      if(reasons.length)throw new Error(reasons.join('; '));
    }
    let adopted=null;
    if(action!=='evidence') assertCollaborationTaskAction(state,task,actor,policy,this.now(),action);
    if(action!=='evidence') assertTaskReviewAction(state,task,action);
    assertGoalTask(state,task,actor,this.now(),action);
    if(assignee_id && task.goalId) assertGoalTask(state,{...task,assigneeId:assignee_id},actor,this.now(),action);
    if (['completed','cancelled'].includes(task.status)) throw new Error('Task is terminal');
    if (state.version !== 2 && task.history.length >= 100) throw new Error('Task history full; archive deliberately before continuing');
    const owner = task.assigneeId === agent_id, creator = task.createdBy === agent_id;
    if (action === 'assign') {
      if (!creator || task.status !== 'ready') throw new Error('Only creator can assign a ready task');
      known(state, assignee_id); task.assigneeId = assignee_id;
    } else if (action === 'cancel') {
      if (!creator) throw new Error('Only creator can cancel task');
      task.status = 'cancelled';
    } else {
      if (!owner && !(action === 'accept' && task.assigneeId === null)) throw new Error('Only assigned agent can perform this action');
      const allowed = {adopt_decision:['ready','blocked','in_progress'],pin_contract:['ready','blocked'],evidence:['ready','in_progress','blocked'],accept:['ready'], progress:['in_progress','blocked'], block:['in_progress'], resume:['blocked'], handoff:['in_progress','blocked'], complete:['in_progress']};
      if (!allowed[action].includes(task.status)) throw new Error('Invalid task transition');
      if(action==='adopt_decision') {
        if(!policy||policy.owner!==actor.owner||this.now()>=Date.parse(policy.expires_at)||!policy.allowed_kinds.includes(task.kind)||!task.paths?.length||task.paths.some(p=>!policy.allowed_paths.some(root=>within(p,root))))throw new Error('Current local policy must cover decision adoption');
        adopted=assertDecisionAdoption(state,decision_id,task,actor,this.now(),{expectedDecisionRevision:expected_decision_revision,decisionDigest:decision_digest});
        (task.decisionReceipts??=[]).push(adopted);
      }
      if(action==='pin_contract') {
        if(task.contractId&&task.contractId!==pin.contractId)throw new Error('Cannot replace contract work identity');
        const candidate={...task,...pin};
        const decision=eligibility(state,actor,candidate,policy,this.now(),{goalExecution:false});
        if(!decision.allowed)throw new Error(decision.reasons.join('; '));
        Object.assign(task,pin);
      }
      if (['accept','resume'].includes(action) || ((task.negotiationId || task.goalId || task.contractId || task.decisionReceipts?.length) && ['progress','complete'].includes(action))) {
        const decision=eligibility(state,actor,task,policy,this.now());
        if (!decision.allowed) throw new Error(decision.reasons.join('; '));
      }
      if (['accept','resume','complete'].includes(action) && task.dependsOn.some(id => tasks.find(t => t.id === id)?.status !== 'completed')) throw new Error('Dependencies must be completed');
      if (action === 'handoff') {
        if (policy && (task.handoffCount??0)+1>policy.max_handoffs) throw new Error('Handoff count exceeds policy; ask the user');
        known(state, assignee_id);
        if (assignee_id === agent_id || !next_steps.length) throw new Error('Handoff needs another agent and next steps');
        if (handoff_id) assertVerifiedHandoff(state,task,agent_id,assignee_id,handoff_id);
        task.assigneeId = assignee_id; task.status = 'ready'; task.handoffCount=(task.handoffCount??0)+1;
      } else if (action === 'accept') { task.assigneeId = agent_id; task.status = 'in_progress'; task.startedAt??=this.now(); }
      else if (action === 'resume') task.status = 'in_progress';
      else if (action === 'block') task.status = 'blocked';
      else if (action === 'complete') {
        if(task.contractId&&!contract_evidence?.length)throw new Error('Contract completion requires implementation evidence');
        if(!task.contractId&&contract_evidence!==undefined)throw new Error('Task has no contract for this evidence');
        if (task.negotiationId || handoff_id) assertVerifiedHandoff(state,task,agent_id,task.createdBy,handoff_id);
        task.status = 'completed';
      }
    }
    if (['accept','assign','handoff','cancel','complete'].includes(action)) delete task.routing;
    const now = this.now(); task.revision++; task.updatedAt = now; actor.seenAt = now;
    task.history.push({revision:task.revision, actorId:agent_id, requestId:request_id, fingerprint,
      ...(adopted?{decisionId:adopted.decisionId,version:adopted.version,digest:adopted.digest}:{}),action, summary, artifacts, nextSteps:next_steps, assigneeId:task.assigneeId, status:task.status, createdAt:now,...(handoff_id?{handoffId:handoff_id}:{}),...(task.contractId?{contractId:task.contractId,contractDigest:task.contractDigest}:{}),...(contract_evidence?{contractEvidence:contract_evidence}:{})});
    return task;
  });
}
