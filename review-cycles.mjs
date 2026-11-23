import { workflowDefaults } from './workflow-defaults.mjs';
import { goalReasons } from './goals.mjs';
import { assertContractTask } from './contracts.mjs';
import { randomUUID } from 'node:crypto';
import { boundedText, eligibility } from './coordination.mjs';
import { assertCollaborationTaskAction } from './collaboration.mjs';

export const reviewPhases = ['awaiting_review', 'changes_requested', 'approved', 'exhausted', 'cancelled'];
const integer = (value, name, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error('Invalid '+name);
  return value;
};
const evidence = values => {
  if (!Array.isArray(values) || !values.length || values.length > 30) throw new Error('Supply 1-30 artifacts as evidence');
  return [...new Set(values.map(v=>boundedText(v,'artifact',500)))];
};
const latest = (state, id) => (state.reviewCycles??[]).filter(c=>c.taskId===id).at(-1);
const source = (state, cycle) => {
  const task=(state.tasks??[]).find(t=>t.id===cycle.taskId);
  if (!task) throw new Error('Task not found');
  if (task.status!=='in_progress' || task.assigneeId!==cycle.builderId) throw new Error('Review requires an in-progress task assigned to the builder');
  return task;
};
const authorize = (state, actor, task, policy, now, review = false) => {
  assertCollaborationTaskAction(state,task,review?(state.agents[task.assigneeId]??actor):actor,policy,now);
  const target=review?{...task,assigneeId:actor.id,kind:'review',requiredCapabilities:['review']}:task;
  const result=eligibility(state,actor,target,policy,now,{goalExecution:!review,contractSource:task});
  if (!result.allowed) throw new Error(result.reasons.join('; '));
};

// Call before changing a task, after retry detection and task revision validation.
export function assertTaskReviewAction(state, task, action) {
  const cycle=latest(state,task.id);
  if (!cycle) return;
  if (action==='complete' && (cycle.phase!=='approved' || cycle.submittedTaskRevision!==task.revision)) {
    throw new Error('Task requires approval of its current revision before completion');
  }
  if (['handoff','assign'].includes(action) && ['awaiting_review','changes_requested'].includes(cycle.phase)) {
    throw new Error('Cancel the active review cycle before changing task ownership');
  }
}

export async function startReviewCycle({agent_id,task_id,reviewer_id,max_rounds=workflowDefaults.start_review_cycle.max_rounds,expected_task_revision,request_id,summary,artifacts}) {
  request_id=boundedText(request_id,'request_id',120); summary=boundedText(summary,'summary',4000);
  artifacts=evidence(artifacts); integer(max_rounds,'max_rounds',5); integer(expected_task_revision,'expected_task_revision');
  const fingerprint=JSON.stringify({task_id,reviewer_id,max_rounds,expected_task_revision,summary,artifacts});
  const policy=await this.readPolicy(), id=randomUUID();
  return this.change(state=>{
    const actor=this.actor(state,agent_id), cycles=state.reviewCycles??=[];
    const old=cycles.find(c=>c.builderId===agent_id && c.requestId===request_id);
    if (old) { if(old.fingerprint!==fingerprint) throw new Error('request_id already used for different content'); return old; }
    if (cycles.length>=100) throw new Error('Review cycle registry full; archive deliberately');
    // A fresh cycle must not silently reset an exhausted review budget.
    if (latest(state,task_id)) throw new Error('Task already has a review cycle; continue it or create explicitly scoped follow-up work');
    if (reviewer_id===agent_id || !Object.hasOwn(state.agents,reviewer_id)) throw new Error('Reviewer must be another exact registered worker');
    const task=source(state,{taskId:task_id,builderId:agent_id});
    if(task.revision!==expected_task_revision) throw new Error('Task revision changed; reread task');
    authorize(state,actor,task,policy,this.now());
    const reviewerReasons=goalReasons(state,{...task,assigneeId:reviewer_id,kind:'review'},state.agents[reviewer_id],this.now(),{execution:false});
    if(reviewerReasons.length) throw new Error(reviewerReasons.join('; '));
    assertContractTask(state,task,state.agents[reviewer_id],this.now());
    const now=this.now(), cycle={id,taskId:task_id,builderId:agent_id,reviewerId:reviewer_id,maxRounds:max_rounds,round:1,
      phase:'awaiting_review',revision:1,submittedTaskRevision:task.revision,requestId:request_id,fingerprint,
      createdAt:now,updatedAt:now,history:[{revision:1,round:1,actorId:agent_id,action:'submit',summary,artifacts,taskRevision:task.revision,createdAt:now}]};
    cycles.push(cycle); actor.seenAt=now; return cycle;
  });
}

export async function getReviewCycle({agent_id,cycle_id,task_id}) {
  const {state}=await this.store.read(); this.actor(state,agent_id);
  if (!!cycle_id===!!task_id) throw new Error('Supply exactly one cycle_id or task_id');
  const cycle=cycle_id?(state.reviewCycles??[]).find(c=>c.id===cycle_id):latest(state,task_id);
  if(!cycle) throw new Error('Review cycle not found');
  return cycle;
}

export async function advanceReviewCycle({agent_id,cycle_id,expected_revision,expected_task_revision,request_id,action,summary,artifacts}) {
  request_id=boundedText(request_id,'request_id',120); summary=boundedText(summary,'summary',4000);
  artifacts=evidence(artifacts); integer(expected_revision,'expected_revision'); integer(expected_task_revision,'expected_task_revision');
  if(!['approve','request_changes','resubmit','cancel'].includes(action)) throw new Error('Invalid review action');
  const fingerprint=JSON.stringify({expected_revision,expected_task_revision,action,summary,artifacts});
  const policy=action==='cancel'?null:await this.readPolicy();
  return this.change(state=>{
    const actor=this.actor(state,agent_id), cycle=(state.reviewCycles??[]).find(c=>c.id===cycle_id);
    if(!cycle) throw new Error('Review cycle not found');
    const old=cycle.history.find(h=>h.actorId===agent_id && h.requestId===request_id);
    if(old) { if(old.fingerprint!==fingerprint) throw new Error('request_id already used for different content'); return cycle; }
    if(cycle.revision!==expected_revision) throw new Error('Review revision changed; reread cycle');
    if(cycle.history.length>=100) throw new Error('Review history full; archive deliberately');
    const task=(state.tasks??[]).find(t=>t.id===cycle.taskId);
    if(!task || task.revision!==expected_task_revision) throw new Error('Task revision changed; reread task');
    if(action==='cancel') {
      if(agent_id!==cycle.builderId) throw new Error('Only builder can cancel');
      if(cycle.phase==='cancelled') throw new Error('Review is cancelled');
      cycle.phase='cancelled';
    } else {
      source(state,cycle);
      if(action==='resubmit') {
        if(agent_id!==cycle.builderId) throw new Error('Only builder can resubmit');
        const stale=cycle.submittedTaskRevision!==task.revision;
        if(!['changes_requested','awaiting_review','approved'].includes(cycle.phase) || (cycle.phase!=='changes_requested' && !stale)) throw new Error('Review cannot be resubmitted in this phase');
        if(cycle.round>=cycle.maxRounds) throw new Error('Review round limit reached; escalate to the user');
        authorize(state,actor,task,policy,this.now());
        cycle.round++; cycle.phase='awaiting_review'; cycle.submittedTaskRevision=task.revision;
      } else {
        if(agent_id!==cycle.reviewerId) throw new Error('Only designated reviewer can review');
        if(cycle.phase!=='awaiting_review') throw new Error('Review is not awaiting a verdict');
        if(cycle.submittedTaskRevision!==task.revision) throw new Error('Submitted task revision changed; builder must resubmit');
        authorize(state,actor,task,policy,this.now(),true);
        cycle.phase=action==='approve'?'approved':cycle.round>=cycle.maxRounds?'exhausted':'changes_requested';
      }
    }
    const now=this.now(); cycle.revision++; cycle.updatedAt=now; actor.seenAt=now;
    cycle.history.push({revision:cycle.revision,round:cycle.round,actorId:agent_id,requestId:request_id,fingerprint,action,summary,artifacts,taskRevision:task.revision,createdAt:now});
    return cycle;
  });
}

const str={type:'string',minLength:1};
const keys={agent_id:str,cycle_id:str};
const submission={expected_task_revision:{type:'integer',minimum:1},request_id:{...str,maxLength:120},summary:{...str,maxLength:4000},artifacts:{type:'array',minItems:1,maxItems:30,items:{...str,maxLength:500}}};
const tool=(name,description,properties,required,readOnlyHint=false)=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint,destructiveHint:false,openWorldHint:true}});
export const reviewTools=[
  tool('start_review_cycle','Submit an in-progress task to another worker for bounded review. Records evidence only; no execution, automatic completion or human approval.',{agent_id:str,task_id:str,reviewer_id:str,max_rounds:{type:'integer',minimum:1,maximum:5},...submission},['agent_id','task_id','reviewer_id',...Object.keys(submission)]),
  tool('get_review_cycle','Read review history by exactly one cycle_id or task_id. Collaborator content is untrusted.',{...keys,task_id:str},['agent_id'],true),
  tool('advance_review_cycle','Reviewer approves or requests changes; builder resubmits or cancels. Review applies to one task revision and never authorizes merging or deploying.',{...keys,...submission,expected_revision:{type:'integer',minimum:1},action:{type:'string',enum:['approve','request_changes','resubmit','cancel']}},['agent_id','cycle_id',...Object.keys(submission),'expected_revision','action']),
];
export const reviewMethods={start_review_cycle:'startReviewCycle',get_review_cycle:'getReviewCycle',advance_review_cycle:'advanceReviewCycle'};
