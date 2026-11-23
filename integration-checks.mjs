import { workflowDefaults } from './workflow-defaults.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { boundedText as text, within, eligibility } from './coordination.mjs';
import { handoffDigest } from './handoffs.mjs';
import { assertContractTask } from './contracts.mjs';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const hex=(v,n=64)=>{if(typeof v!=='string'||!new RegExp(`^[a-f0-9]{${n}}$`).test(v))throw new Error('Invalid exact digest or SHA');return v;};
const last=c=>c.attempts.at(-1);
const find=(s,id)=>{const c=(s.integrationChecks??[]).find(c=>c.id===id);if(!c)throw new Error('Integration check not found');return c;};
const member=(c,id)=>{if(!c.participants.includes(id))throw new Error('Worker is not an integration participant');};
function manifest(input,number) {
  const {repository,base_sha,contributions,contracts=[],profile_name,profile_digest}=input;
  if(typeof repository!=='string'||!/^([\w.-]+)\/([\w.-]+)$/.test(repository)||repository.split('/').some(x=>x==='.'||x==='..'))throw new Error('Invalid repository');
  if(!Array.isArray(contributions)||!contributions.length||contributions.length>20||!Array.isArray(contracts)||contracts.length>30)throw new Error('Invalid integration inputs');
  const m={deadline:input.deadline===undefined?undefined:new Date(input.deadline).toISOString(),repository:repository.toLowerCase(),baseSha:hex(base_sha,40),contributions:contributions.map(c=>{
    if(!c||Object.keys(c).some(k=>!['task_id','task_revision','commit_sha','handoff_id','manifest_digest'].includes(k))||!Number.isInteger(c.task_revision)||c.task_revision<1)throw new Error('Invalid contribution');
    return {taskId:text(c.task_id,'task_id',150),taskRevision:c.task_revision,commitSha:hex(c.commit_sha,40),handoffId:text(c.handoff_id,'handoff_id',150),manifestDigest:hex(c.manifest_digest)};
  }),contracts:contracts.map(c=>({contractId:text(c.contract_id,'contract_id',150),digest:hex(c.digest)})),profile:{name:text(profile_name,'profile_name',100),digest:hex(profile_digest)}};
  if(new Set(m.contributions.map(c=>c.taskId)).size!==m.contributions.length||new Set(m.contracts.map(c=>c.contractId)).size!==m.contracts.length)throw new Error('Duplicate integration input');
  return {...m,digest:hash(m),attempt:number};
}
function inputs(state,c,m,now) {
  if(c.paths&&JSON.stringify(m.paths)!==JSON.stringify(c.paths))throw new Error('Integration manifest paths differ from immutable declared scope');
  const paths=[],participants=[c.createdBy,c.verifierId];
  for(const x of m.contributions) {
    const t=(state.tasks??[]).find(t=>t.id===x.taskId),h=(state.handoffs??[]).find(h=>h.id===x.handoffId);
    if(!t||t.status!=='completed'||t.revision!==x.taskRevision)throw new Error('Source task must be completed at exact current revision');
    const completion=t.history?.find(e=>e.action==='complete'&&e.revision===h?.taskRevision+1);
    if(!h||h.digest!==handoffDigest(h)||h.digest!==x.manifestDigest||h.taskId!==t.id||h.commitSha!==x.commitSha||h.repository!==m.repository||h.senderId!==t.assigneeId||h.recipientId!==t.createdBy||h.receipt?.actorId!==h.recipientId||h.receipt?.verdict!=='accepted'||h.receipt?.taskRevision!==h.taskRevision||h.receipt?.manifestDigest!==h.digest||!completion||completion.handoffId!==h.id)throw new Error('Source requires accepted exact handoff bound to completion');
    const review=(state.reviewCycles??[]).find(r=>r.taskId===t.id);
    if(review&&(review.phase!=='approved'||review.submittedTaskRevision!==h.taskRevision))throw new Error('Source review is stale');
    if((t.goalId??null)!==c.goalId)throw new Error('Source task goal mismatch');
    if(t.contractId&&!m.contracts.some(k=>k.contractId===t.contractId&&k.digest===t.contractDigest))throw new Error('Missing source contract pin');
    assertContractTask(state,t,state.agents[t.assigneeId],now);
    if(!t.paths?.length)throw new Error('Source requires declared paths');paths.push(...t.paths);participants.push(t.assigneeId,t.createdBy);
  }
  for(const pin of m.contracts) {const k=(state.contracts??[]).find(k=>k.id===pin.contractId);if(!k||k.versions.at(-1).digest!==pin.digest||k.status!=='agreed'||Date.parse(k.deadline)<=now||k.repository!==m.repository||(k.goalId??null)!==c.goalId)throw new Error('Integration contract is stale');}
  if(c.paths&&paths.some(p=>!c.paths.some(root=>within(p,root))))throw new Error('Retry cannot expand paths');
  if(c.participants&&participants.some(id=>!c.participants.includes(id)))throw new Error('Retry cannot replace participants');
  if(c.goalId) {const g=(state.goals??[]).find(g=>g.id===c.goalId);if(!g||g.owner!==c.owner||g.status!=='active'||Date.parse(g.deadline)<=now||Date.parse(c.deadline)>Date.parse(g.deadline)||participants.some(id=>!g.participants.includes(id))||!g.allowedKinds.includes('testing')||paths.some(p=>!g.allowedPaths.some(root=>within(p,root))))throw new Error('Integration exceeds active goal scope');}
  const declaredPaths=[...new Set(paths)];
  if(declaredPaths.length>30)throw new Error('Integration scope exceeds 30 declared paths');
  return {paths:declaredPaths,participants:[...new Set(participants)]};
}
function executionTask(state,c,m,statuses=['ready','in_progress','blocked']) {
  const task=(state.tasks??[]).find(t=>t.id===c.executionTaskId);
  if(!task||task.kind!=='testing'||task.assigneeId!==c.verifierId||(task.goalId??null)!==c.goalId||!statuses.includes(task.status)||!task.paths?.length||c.paths.some(p=>!task.paths.some(root=>within(p,root)))||m.contributions.some(x=>x.taskId===task.id))throw new Error('Integration requires an assigned testing execution task in matching scope and state');
  return task;
}
function execution(state,c,policy,actor,now,assertCollaborationTaskAction) {
  if(!policy||policy.owner!==actor.owner||Date.parse(policy.expires_at)<=now||!policy.allowed_kinds.includes('testing')||c.paths.some(p=>!policy.allowed_paths.some(root=>within(p,root))))throw new Error('Current local testing policy required');
  const task=executionTask(state,c,last(c).manifest,['in_progress']);if(!Number.isFinite(task.startedAt))throw new Error('Execution task requires observed start timestamp');const checked=eligibility(state,actor,task,policy,now);if(!checked.allowed)throw new Error(checked.reasons.join('; '));assertCollaborationTaskAction(state,task,actor,policy,now,'accept');
  const owners=[...new Set(c.participants.map(id=>state.agents[id]?.owner))];
  for(const owner of owners)for(const peer of owners)if(owner!==peer&&!(state.collaborationAgreements??[]).some(a=>a.owner===owner&&a.peerOwner===peer&&a.status==='active'&&Date.parse(a.expiresAt)>now&&a.allowedKinds.includes('testing')&&c.paths.every(p=>a.allowedPaths.some(root=>within(p,root)))))throw new Error('Active bilateral testing agreements required');
  if((state.claims??[]).some(x=>x.agentId!==actor.id&&x.expiresAt>now&&x.paths.some(p=>c.paths.some(q=>within(p,q)||within(q,p)))))throw new Error('Active overlapping path claim');
  return task;
}
export function integrationView(c,now) {
  const a=last(c),status=now>=Date.parse(c.deadline)&&c.status!=='passed'?'expired':c.status;
  return {...c,status,attempt:a.number,manifest:a.manifest,interrupted:status==='running'&&now>=a.leaseUntil,exhausted:['failed','blocked'].includes(status)&&c.attempts.length>=c.maxAttempts,...(status==='running'?{execution:{manifest:a.manifest,run:{id:a.runId,leaseUntil:a.leaseUntil}}}:{}) ,note:'Integration results are verifier-reported observations, not independent attestation or merge permission.'};
}
export async function createIntegrationCheck(input) {
  const {agent_id,verifier_id,goal_id}=input,executionTaskId=text(input.execution_task_id,'execution_task_id',150),workId=text(input.work_id,'work_id',120),requestId=text(input.request_id,'request_id',120),maxAttempts=input.max_attempts??workflowDefaults.create_integration_check.max_attempts;
  if(!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>5||typeof input.deadline!=='string'||!Number.isFinite(Date.parse(input.deadline)))throw new Error('Invalid integration deadline or attempt budget');
  const m=manifest(input,1),deadline=new Date(input.deadline).toISOString(),payload={workId,executionTaskId,verifierId:text(verifier_id,'verifier_id',150),goalId:goal_id??null,deadline,maxAttempts,manifest:m},fp=hash(payload),id=randomUUID();
  return this.change(state=>{const actor=this.actor(state,agent_id),all=state.integrationChecks??=[],now=this.now();const old=all.find(c=>c.createdBy===agent_id&&c.requestId===requestId);if(old){if(old.fingerprint!==fp)throw new Error('request_id already used for different content');return integrationView(old,now);}
    if(all.some(c=>c.executionTaskId===executionTaskId))throw new Error('Execution task already belongs to an integration check');if(all.length>=100)throw new Error('Integration registry full');if(all.some(c=>c.owner===actor.owner&&c.workId===workId))throw new Error('Integration work already exists; do not reset budget');if(!state.agents[verifier_id]||Date.parse(deadline)<=now)throw new Error('Unknown verifier or expired deadline');
    const c={id,workId,executionTaskId,verifierId:verifier_id,goalId:goal_id??null,deadline,maxAttempts,owner:actor.owner,createdBy:agent_id,requestId,fingerprint:fp,status:'pending',revision:1,createdAt:now,updatedAt:now,history:[],attempts:[{number:1,manifest:m,status:'pending',createdAt:now}]};
    Object.assign(c,inputs(state,c,m,now));m.paths=[...c.paths];const {digest:oldDigest,attempt:oldAttempt,...content}=m;m.digest=hash(content);executionTask(state,c,m);all.push(c);return integrationView(c,now);});
}
export async function advanceIntegrationCheck(input) {
  const {agent_id,integration_id,expected_revision,action,input_digest,run_id,result}=input,requestId=text(input.request_id,'request_id',120),summary=text(input.summary,'summary',2000);
  if(!['start','result','retry','block'].includes(action)||!Number.isInteger(expected_revision)||expected_revision<1)throw new Error('Invalid integration action or revision');hex(input_digest);
  const recoveryEvidence=input.recovery_evidence??[];if(!Array.isArray(recoveryEvidence)||recoveryEvidence.length>20||recoveryEvidence.some(e=>typeof e!=='string'||!e.trim()||e.length>1000))throw new Error('Invalid recovery evidence');if(action!=='retry'&&recoveryEvidence.length)throw new Error('Recovery evidence only applies to retry');const replacement=action==='retry'?manifest(input,1):null,fp=hash({...input,summary}),policy=['start','result'].includes(action)?await this.readPolicy():null;
  const {assertCollaborationTaskAction}=await import('./collaboration.mjs');
  return this.change(state=>{const actor=this.actor(state,agent_id),c=find(state,integration_id),a=last(c),now=this.now();member(c,agent_id);
    const old=c.history.find(h=>h.actorId===agent_id&&h.requestId===requestId);if(old){if(old.fingerprint!==fp)throw new Error('request_id already used for different content');return integrationView(c,now);}
    if(c.revision!==expected_revision||a.manifest.digest!==input_digest)throw new Error('Integration revision or input digest changed');if(c.history.length>=100)throw new Error('Integration history full');
    if(Date.parse(c.deadline)<=now&&action!=='block')throw new Error('Integration deadline expired');
    if(action==='start'||action==='result') {
      if(c.verifierId!==agent_id)throw new Error('Only exact verifier may execute or report');inputs(state,c,a.manifest,now);const task=execution(state,c,policy,actor,now,assertCollaborationTaskAction);
      const run=(state.workerRuns??[]).find(r=>r.id===run_id&&r.agentId===agent_id&&r.status==='running'&&r.leaseUntil>now);if(!run)throw new Error('Live verifier worker run lease required');
      if(action==='start') {if(c.status!=='pending')throw new Error('Attempt must be pending');a.runId=run.id;a.leaseUntil=Math.min(run.leaseUntil,Date.parse(c.deadline),Date.parse(policy.expires_at),task.startedAt+policy.max_task_minutes*60000);a.startedAt=now;c.status=a.status='running';}
      else {if(c.status!=='running'||a.runId!==run.id||now>=a.leaseUntil)throw new Error('Result must bind the original running lease');
        if(!result||Object.keys(result).some(k=>!['inputDigest','attempt','profileDigest','runId','verdict','commitSha','treeSha','checks','evidence'].includes(k))||result.runId!==run.id||result.inputDigest!==a.manifest.digest||result.attempt!==a.number||result.profileDigest!==a.manifest.profile.digest||!['passed','failed','blocked'].includes(result.verdict))throw new Error('Result must bind exact attempt, inputs and profile');
        if(!Array.isArray(result.checks)||result.checks.length>30||!Array.isArray(result.evidence)||!result.evidence.length||result.evidence.length>20)throw new Error('Bounded result checks and evidence required');
        for(const check of result.checks){if(!check||typeof check!=='object'||Object.keys(check).some(k=>!['name','passed','detail'].includes(k)))throw new Error('Invalid observed check fields');text(check.name,'check name',150);if(typeof check.passed!=='boolean')throw new Error('Invalid observed check');if(check.detail!==undefined)text(check.detail,'check detail',2000);}
        result.evidence.forEach(e=>text(e,'evidence',2000));if(result.commitSha!==null)hex(result.commitSha,40);if(result.treeSha!==null)hex(result.treeSha,40);
        if(result.verdict==='passed'&&(!result.commitSha||!result.treeSha||!result.checks.length||result.checks.some(x=>!x.passed)))throw new Error('Passed result requires commit, tree and passing checks');
        a.result=structuredClone(result);a.finishedAt=now;c.status=a.status=result.verdict;
      }
    } else {
      if(agent_id!==c.createdBy&&agent_id!==c.verifierId)throw new Error('Only creator or verifier may retry or block');
      if(action==='block') {if(!['pending','running'].includes(c.status))throw new Error('Only an unfinished attempt may block');if(c.status==='running'&&a.leaseUntil>now&&agent_id!==c.verifierId)throw new Error('Verifier run still owns this attempt');c.status=a.status='blocked';a.blocker=summary;}
      else {if(!['passed','failed','blocked'].includes(c.status))throw new Error('Finish or explicitly block interrupted attempt before retry');if(c.attempts.length>=c.maxAttempts)throw new Error('Integration attempt budget exhausted');replacement.deadline=c.deadline;replacement.paths=[...c.paths];const {digest:discardDigest,attempt:discardAttempt,...retryContent}=replacement;replacement.digest=hash(retryContent);if(replacement.repository!==c.attempts[0].manifest.repository)throw new Error('Retry repository cannot change');inputs(state,c,replacement,now);replacement.attempt=c.attempts.length+1;if(replacement.digest===a.manifest.digest&&(c.status==='passed'||!recoveryEvidence.length))throw new Error('Same-input retry requires failed or blocked attempt and explicit recovery evidence');c.attempts.push({number:replacement.attempt,manifest:replacement,status:'pending',createdAt:now,recoveryEvidence:[...recoveryEvidence]});c.status='pending';}
    }
    c.revision++;c.updatedAt=now;c.history.push({actorId:agent_id,requestId,fingerprint:fp,action,summary,createdAt:now});return integrationView(c,now);
  });
}
export async function getIntegrationCheck({agent_id,integration_id}) {const {state}=await this.store.read();this.actor(state,agent_id);const c=find(state,integration_id);member(c,agent_id);return integrationView(c,this.now());}
export async function listIntegrationChecks({agent_id,after=0,limit=30}) {const {state}=await this.store.read();this.actor(state,agent_id);if(!Number.isInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Invalid pagination');const all=(state.integrationChecks??[]).filter(c=>c.participants.includes(agent_id)),page=all.slice(after,after+limit);return {integrationChecks:page.map(c=>integrationView(c,this.now())),nextAfter:after+page.length,hasMore:after+page.length<all.length};}
export function assertGoalIntegration(state,goal,now) {
  const required=goal.requiredIntegrationWorkIds??[];if(!required.length)return;
  const covered=new Set();for(const workId of required){const c=(state.integrationChecks??[]).find(c=>c.owner===goal.owner&&c.goalId===goal.id&&c.workId===workId);if(!c||c.status!=='passed'||last(c).result?.inputDigest!==last(c).manifest.digest)throw new Error('Goal requires passing current integration inputs');inputs(state,c,last(c).manifest,now);for(const x of last(c).manifest.contributions)covered.add(x.taskId);}
  if((state.tasks??[]).some(t=>t.goalId===goal.id&&t.kind==='implementation'&&t.status==='completed'&&!covered.has(t.id)))throw new Error('Goal integration must cover all completed implementation tasks');
}
const s={type:'string',minLength:1},integer={type:'integer',minimum:1},obj=(properties,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const contribution=obj({task_id:s,task_revision:integer,commit_sha:s,handoff_id:s,manifest_digest:s}),pin=obj({contract_id:s,digest:s});
const manifestFields={repository:s,base_sha:s,contributions:{type:'array',minItems:1,maxItems:20,items:contribution},contracts:{type:'array',maxItems:30,items:pin},profile_name:s,profile_digest:s};
const tool=(name,description,properties,required,readOnlyHint=false)=>({name,description,inputSchema:obj(properties,required),annotations:{readOnlyHint,destructiveHint:false,openWorldHint:true}});
export const integrationTools=[
 tool('create_integration_check','Create bounded exact-input integration work from completed tasks and accepted handoffs. No code is executed.',{agent_id:s,work_id:s,verifier_id:s,execution_task_id:s,...manifestFields,goal_id:s,deadline:s,max_attempts:{...integer,maximum:5},request_id:s},['agent_id','work_id','verifier_id','execution_task_id','repository','base_sha','contributions','profile_name','profile_digest','deadline','request_id']),
 tool('advance_integration_check','Start with a live verifier lease, record exact observed results, block or retry changed inputs within original scope and budget.',{agent_id:s,integration_id:s,expected_revision:integer,input_digest:s,request_id:s,action:{type:'string',enum:['start','result','retry','block']},summary:s,run_id:s,recovery_evidence:{type:'array',maxItems:20,items:{type:'string',minLength:1,maxLength:1000}},...manifestFields,result:obj({inputDigest:s,runId:s,attempt:integer,profileDigest:s,verdict:{type:'string',enum:['passed','failed','blocked']},commitSha:{type:['string','null']},treeSha:{type:['string','null']},checks:{type:'array',maxItems:30,items:obj({name:s,passed:{type:'boolean'},detail:s},['name','passed'])},evidence:{type:'array',minItems:1,maxItems:20,items:s}})},['agent_id','integration_id','expected_revision','input_digest','request_id','action','summary']),
 tool('get_integration_check','Inspect immutable attempts and reported integration evidence.',{agent_id:s,integration_id:s},['agent_id','integration_id'],true),
 tool('list_integration_checks','List your integration checks, following every page.',{agent_id:s,after:{type:'integer',minimum:0},limit:{...integer,maximum:100}},['agent_id'],true)
];
export const integrationMethods={create_integration_check:'createIntegrationCheck',advance_integration_check:'advanceIntegrationCheck',get_integration_check:'getIntegrationCheck',list_integration_checks:'listIntegrationChecks'};






