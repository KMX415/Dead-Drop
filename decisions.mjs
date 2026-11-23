import { workflowDefaults } from './workflow-defaults.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { boundedText as text, strings, within } from './coordination.mjs';
import { goalReasons } from './goals.mjs';

const categories=['implementation','access','permission','budget','merge','deployment','product_scope'];
const current=d=>d.versions.at(-1);
const find=(s,id)=>{const d=(s.decisions??[]).find(d=>d.id===id);if(!d)throw new Error('Decision not found');return d;};
const receipt=(t,d)=>t.decisionReceipts?.some(r=>r.decisionId===d.id&&r.version===current(d).number&&r.digest===current(d).digest&&r.actorId===t.assigneeId);
const member=(d,id)=>d.createdBy===id||d.requiredResponders.includes(id);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function stale(d,state) {
  const v=current(d);
  return v.taskRefs.some(r=>{
    const t=(state.tasks??[]).find(t=>t.id===r.task_id);if(!t)return true;if(t.revision===r.revision)return false;
    const suffix=(t.history??[]).filter(h=>h.revision>r.revision);
    const metadataOnly=t.revision>r.revision&&suffix.length===t.revision-r.revision&&suffix.every((h,i)=>h.revision===r.revision+i+1&&h.action==='adopt_decision'&&h.actorId===t.assigneeId&&t.decisionReceipts?.some(receipt=>receipt.decisionId===h.decisionId&&receipt.version===h.version&&receipt.digest===h.digest&&receipt.actorId===h.actorId));
    return !metadataOnly;
  })||d.goalId!==null&&(state.goals??[]).find(g=>g.id===d.goalId)?.revision!==v.goalRevision;
}
export function decisionView(d,state,now) {
  const v=current(d),status=stale(d,state)?'superseded':d.status==='resolved'?'resolved':now>=Date.parse(d.deadline)?'expired':'open';
  return {...d,status,version:v.number,digest:v.digest,taskRefs:v.taskRefs,goalRevision:v.goalRevision,question:v.question,options:v.options,evidence:v.evidence,responses:v.responses,staleResponderIds:v.responses.filter(r=>!responseCurrent(state,d,r,now)).map(r=>r.actorId),resolution:v.resolution??null,exhausted:status==='superseded'&&d.versions.length>=d.maxRevisions};
}
export function decisionTaskReasons(state,task,now) {
  return (state.decisions??[]).filter(d=>d.blockedTaskIds.includes(task.id)&&!receipt(task,d)).map(d=>`Decision ${d.id} ${decisionView(d,state,now).status}; explicitly adopt its current resolved version before execution`);
}
export function assertDecisionAdoption(state,decisionId,task,actor,now,{expectedDecisionRevision,decisionDigest}) {
  const d=find(state,decisionId),v=current(d);
  if(d.revision!==expectedDecisionRevision||v.digest!==decisionDigest)throw new Error('Decision revision or digest changed');
  if(decisionView(d,state,now).status!=='resolved')throw new Error('Decision must be resolved and current');
  if(!d.blockedTaskIds.includes(task.id)||task.assigneeId!==actor.id)throw new Error('Only assigned blocked task worker can adopt decision');
  if(receipt(task,d))throw new Error('Task already adopted this decision version');
  return {decisionId:d.id,version:v.number,digest:v.digest,decisionRevision:d.revision,optionId:v.resolution.optionId,actorId:actor.id,adoptedAt:now};
}
function content(question,options,evidence,task_refs,goalRevision) {
  question=text(question,'question',4000);evidence=strings(evidence,'evidence',20);
  if(!evidence.length||!Array.isArray(options)||options.length<2||options.length>5)throw new Error('Decision requires evidence and 2-5 options');
  options=options.map(o=>{if(!o||Object.keys(o).some(k=>!['id','label','tradeoffs'].includes(k)))throw new Error('Invalid decision option');return {id:text(o.id,'option id',80),label:text(o.label,'option label',300),tradeoffs:text(o.tradeoffs,'tradeoffs',2000)};});
  if(new Set(options.map(o=>o.id)).size!==options.length)throw new Error('Duplicate option ID');
  if(!Array.isArray(task_refs)||!task_refs.length||task_refs.length>20)throw new Error('Decision requires 1-20 task references');
  const taskRefs=task_refs.map(r=>{if(!r||Object.keys(r).some(k=>!['task_id','revision'].includes(k))||!Number.isInteger(r.revision)||r.revision<1)throw new Error('Invalid task reference');return {task_id:text(r.task_id,'task_id',150),revision:r.revision};});
  if(new Set(taskRefs.map(r=>r.task_id)).size!==taskRefs.length)throw new Error('Duplicate task reference');
  return {question,options,evidence,taskRefs,goalRevision};
}
function context(state,terms,scope,actor,now) {
  for(const ref of terms.taskRefs) {
    const t=(state.tasks??[]).find(t=>t.id===ref.task_id);
    if(!t||t.revision!==ref.revision)throw new Error('Referenced task revision changed or missing');
    if(scope.blockedTaskIds.includes(t.id)&&(!t.assigneeId||!(t.assigneeId===actor.id||t.createdBy===actor.id&&t.status==='ready')))throw new Error('Only own assigned tasks or own assigned ready tasks may be blocked');
    if(scope.goalId!==null&&t.goalId!==scope.goalId)throw new Error('Task does not belong to linked goal');
  }
  if(scope.goalId!==null) {
    const g=(state.goals??[]).find(g=>g.id===scope.goalId);
    if(!g||g.revision!==terms.goalRevision||!g.participants.includes(actor.id))throw new Error('Goal revision changed or requester not a participant');
    if(Date.parse(scope.deadline)>Date.parse(g.deadline))throw new Error('Decision deadline exceeds goal deadline');
  }
}
function authority(state,d,actor,policy,now) {
  if(!policy||policy.owner!==actor.owner||now>=Date.parse(policy.expires_at))throw new Error('Current local autonomy policy required for agent resolution');
  const owners=[...new Set([d.owner,...d.requiredResponders.map(id=>state.agents[id].owner),...current(d).taskRefs.map(ref=>{const t=state.tasks.find(t=>t.id===ref.task_id);return state.agents[t.assigneeId??t.createdBy]?.owner;}).filter(Boolean)])],agreementIds=[];
  for(const ref of current(d).taskRefs) {
    const t=state.tasks.find(t=>t.id===ref.task_id);
    if(!policy.allowed_kinds.includes(t.kind)||!t.paths?.length||t.paths.some(p=>!policy.allowed_paths.some(root=>within(p,root))))throw new Error('Decision exceeds current local policy scope');
    const reasons=goalReasons(state,t,actor,now,{execution:false});if(reasons.length)throw new Error(reasons.join('; '));
    for(const owner of owners)for(const peer of owners)if(owner!==peer) {
      const a=(state.collaborationAgreements??[]).find(a=>a.owner===owner&&a.peerOwner===peer&&a.status==='active'&&Date.parse(a.expiresAt)>now&&a.allowedKinds.includes(t.kind)&&t.paths.every(p=>a.allowedPaths.some(root=>within(p,root))));
      if(!a)throw new Error('Active bilateral agreements must cover decision scope');agreementIds.push(a.id);
    }
  }
  return [...new Set(agreementIds)].sort();
}
function responseCurrent(state,d,response,now) {
  if(response.authority==='human_report')return true;
  if(!Number.isFinite(Date.parse(response.policyExpiresAt))||now>=Date.parse(response.policyExpiresAt))return false;
  const refs=current(d).taskRefs,tasks=refs.map(ref=>state.tasks.find(t=>t.id===ref.task_id));
  if(tasks.some(t=>!t)||d.requiredResponders.some(id=>!state.agents[id]))return false;
  const owners=[...new Set([d.owner,...d.requiredResponders.map(id=>state.agents[id].owner),...tasks.map(t=>state.agents[t.assigneeId??t.createdBy]?.owner).filter(Boolean)])];
  for(const task of tasks)for(const owner of owners)for(const peer of owners)if(owner!==peer) {
    if(!(state.collaborationAgreements??[]).some(a=>response.agreementIds.includes(a.id)&&a.owner===owner&&a.peerOwner===peer&&a.status==='active'&&Date.parse(a.expiresAt)>now&&a.allowedKinds.includes(task.kind)&&task.paths.every(p=>a.allowedPaths.some(root=>within(p,root)))))return false;
  }
  return true;
}
export async function requestDecision({agent_id,issue_key,required_responders,question,options,evidence,task_refs,blocked_task_ids=[],goal_id,expected_goal_revision,category='implementation',deadline,max_revisions=workflowDefaults.request_decision.max_revisions,expected_revision,request_id}) {
  issue_key=text(issue_key,'issue_key',120);request_id=text(request_id,'request_id',120);required_responders=strings(required_responders,'required_responders',10);blocked_task_ids=strings(blocked_task_ids,'blocked_task_ids',20);
  if(!required_responders.length||!categories.includes(category)||!Number.isInteger(max_revisions)||max_revisions<1||max_revisions>5)throw new Error('Invalid decision responders, category or revision budget');
  if(typeof deadline!=='string'||!Number.isFinite(Date.parse(deadline)))throw new Error('Invalid decision deadline');deadline=new Date(deadline).toISOString();
  if((goal_id===undefined)!==(expected_goal_revision===undefined)||expected_goal_revision!==undefined&&(!Number.isInteger(expected_goal_revision)||expected_goal_revision<1))throw new Error('Goal ID and exact revision required together');
  if(goal_id!==undefined)goal_id=text(goal_id,'goal_id',150);
  const terms=content(question,options,evidence,task_refs,expected_goal_revision??null);
  if(blocked_task_ids.some(id=>!terms.taskRefs.some(r=>r.task_id===id)))throw new Error('Blocked tasks must be linked tasks');
  const scope={requiredResponders:required_responders,blockedTaskIds:blocked_task_ids,goalId:goal_id??null,category,deadline,maxRevisions:max_revisions},fingerprint=JSON.stringify({issue_key,scope,terms,expected_revision});
  return this.change(state=>{
    const actor=this.actor(state,agent_id),all=state.decisions??=[];
    const retry=all.find(d=>d.history.some(h=>h.actorId===agent_id&&h.requestId===request_id));
    if(retry){if(retry.history.find(h=>h.actorId===agent_id&&h.requestId===request_id).fingerprint!==fingerprint)throw new Error('request_id already used for different content');return decisionView(retry,state,this.now());}
    if(required_responders.some(id=>!Object.hasOwn(state.agents,id)))throw new Error('Unknown decision responder');
    if(Date.parse(deadline)<=this.now())throw new Error('Decision deadline must be future');
    let d=all.find(d=>d.owner===actor.owner&&d.issueKey===issue_key);
    if(d) {
      if(d.createdBy!==agent_id||d.revision!==expected_revision)throw new Error('Existing issue requires original requester and exact revision; cannot reset budget');
      if(decisionView(d,state,this.now()).status!=='superseded')throw new Error('Only superseded decisions may be reassessed');
      if(d.versions.length>=d.maxRevisions)throw new Error('Decision revision budget exhausted');
      if(Object.keys(scope).some(k=>JSON.stringify(scope[k])!==JSON.stringify(d[k]))||JSON.stringify(terms.taskRefs.map(r=>r.task_id).sort())!==JSON.stringify(current(d).taskRefs.map(r=>r.task_id).sort()))throw new Error('Decision reassessment cannot change scope, responders, deadline or budget');
    } else {
      if(expected_revision!==undefined)throw new Error('Decision not found for reassessment');
      if(all.length>=100)throw new Error('Decision registry full');
      d={id:randomUUID(),issueKey:issue_key,owner:actor.owner,createdBy:agent_id,...scope,revision:0,versions:[],history:[],createdAt:this.now()};all.push(d);
    }
    if(d.history.length>=50)throw new Error('Decision history full');
    context(state,terms,scope,actor,this.now());
    const number=d.versions.length+1;d.versions.push({number,...terms,digest:hash({id:d.id,number,scope,terms}),responses:[],createdAt:this.now()});d.status='open';d.revision++;d.updatedAt=this.now();d.history.push({actorId:agent_id,requestId:request_id,fingerprint,action:'request',createdAt:this.now()});return decisionView(d,state,this.now());
  });
}
export async function resolveDecision({agent_id,decision_id,expected_revision,request_id,option_id,rationale,authority:mode='agent',authorization_evidence}) {
  request_id=text(request_id,'request_id',120);option_id=text(option_id,'option_id',80);rationale=text(rationale,'rationale',2000);authorization_evidence=strings(authorization_evidence,'authorization_evidence',20);
  if(!Number.isInteger(expected_revision)||expected_revision<1||!['agent','human_report'].includes(mode)||!authorization_evidence.length)throw new Error('Exact revision, authority and authorization evidence required');
  const fingerprint=JSON.stringify({decision_id,expected_revision,option_id,rationale,mode,authorization_evidence}),policy=mode==='agent'?await this.readPolicy():null;
  return this.change(state=>{
    const actor=this.actor(state,agent_id),d=find(state,decision_id);
    if(!d.requiredResponders.includes(agent_id))throw new Error('Only exact designated responder can answer');
    const retry=d.history.find(h=>h.actorId===agent_id&&h.requestId===request_id);
    if(retry){if(retry.fingerprint!==fingerprint)throw new Error('request_id already used for different content');return decisionView(d,state,this.now());}
    if(d.revision!==expected_revision)throw new Error('Decision revision changed; reread decision');
    if(decisionView(d,state,this.now()).status!=='open')throw new Error('Decision is not open and current');
    if(d.history.length>=50)throw new Error('Decision history full');
    const v=current(d);if(!v.options.some(o=>o.id===option_id))throw new Error('Unknown decision option');
    if(mode==='agent'&&d.category!=='implementation')throw new Error('Responsible human answer required for this category');
    const agreementIds=mode==='agent'?authority(state,d,actor,policy,this.now()):[];
    const response={actorId:agent_id,owner:actor.owner,optionId:option_id,rationale,authority:mode,authorizationEvidence:authorization_evidence,agreementIds,policyExpiresAt:mode==='agent'?policy.expires_at:null,humanConsentVerified:false,createdAt:this.now()};
    v.responses=v.responses.filter(r=>r.actorId!==agent_id);v.responses.push(response);
    if(d.requiredResponders.every(id=>v.responses.some(r=>r.actorId===id&&r.optionId===option_id&&responseCurrent(state,d,r,this.now())))){d.status='resolved';v.resolution={optionId:option_id,resolvedAt:this.now(),reportedHumanAnswer:v.responses.some(r=>r.authority==='human_report'),humanConsentVerified:false};}
    d.revision++;d.updatedAt=this.now();d.history.push({actorId:agent_id,requestId:request_id,fingerprint,action:'respond',response,createdAt:this.now()});return decisionView(d,state,this.now());
  });
}
export async function getDecision({agent_id,decision_id}) {const {state}=await this.store.read();this.actor(state,agent_id);return decisionView(find(state,decision_id),state,this.now());}
export async function listDecisions({agent_id,after=0,limit=30}) {const {state}=await this.store.read();this.actor(state,agent_id);if(!Number.isInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Invalid pagination');const all=(state.decisions??[]).filter(d=>member(d,agent_id)||d.blockedTaskIds.some(id=>state.tasks?.some(t=>t.id===id&&t.assigneeId===agent_id)));return {decisions:all.slice(after,after+limit).map(d=>decisionView(d,state,this.now())),nextAfter:after+Math.min(limit,Math.max(0,all.length-after)),hasMore:after+limit<all.length};}

const str={type:'string',minLength:1},arr={type:'array',maxItems:20,items:str},rev={type:'integer',minimum:1};
const tool=(name,description,properties,required,readOnlyHint=false)=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint,destructiveHint:false,openWorldHint:true}});
export const decisionTools=[
  tool('request_decision','Record one bounded issue. Explicit reassessment of stale context uses original scope and budget. No task or policy mutations.',{agent_id:str,issue_key:str,required_responders:{...arr,minItems:1,maxItems:10},question:str,options:{type:'array',minItems:2,maxItems:5,items:{type:'object',additionalProperties:false,properties:{id:str,label:str,tradeoffs:str},required:['id','label','tradeoffs']}},evidence:{...arr,minItems:1},task_refs:{type:'array',minItems:1,maxItems:20,items:{type:'object',additionalProperties:false,properties:{task_id:str,revision:rev},required:['task_id','revision']}},blocked_task_ids:arr,goal_id:str,expected_goal_revision:rev,category:{type:'string',enum:categories},deadline:str,max_revisions:{type:'integer',minimum:1,maximum:5},expected_revision:rev,request_id:str},['agent_id','issue_key','required_responders','question','options','evidence','task_refs','deadline','request_id']),
  tool('resolve_decision','Exact designated worker responds. Agent implementation choices require existing policy and agreements; human answers are unverified reports and never grant authority.',{agent_id:str,decision_id:str,expected_revision:rev,request_id:str,option_id:str,rationale:str,authority:{type:'string',enum:['agent','human_report']},authorization_evidence:{...arr,minItems:1}},['agent_id','decision_id','expected_revision','request_id','option_id','rationale','authorization_evidence']),
  tool('get_decision','Read exact decision, immutable versions, responses and derived freshness.',{agent_id:str,decision_id:str},['agent_id','decision_id'],true),
  tool('list_decisions','List relevant decisions with bounded pagination.',{agent_id:str,after:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100}},['agent_id'],true),
];
export const decisionMethods={request_decision:'requestDecision',resolve_decision:'resolveDecision',get_decision:'getDecision',list_decisions:'listDecisions'};
