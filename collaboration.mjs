import { workflowDefaults } from './workflow-defaults.mjs';
import { lessonIds, lessonIdsSchema, pinLessons } from './lessons.mjs';
import { assertGoalTask } from './goals.mjs';
import { randomUUID } from 'node:crypto';
import { boundedText, strings, relativePath, taskKinds, within, eligibility } from './coordination.mjs';

const text = (v,n,max=500) => boundedText(v,n,max);
const revision = v => { if (!Number.isInteger(v) || v < 1) throw new Error('Invalid expected_revision'); };
const timestamp = (v,n) => { if(typeof v !== 'string' || !Number.isFinite(Date.parse(v))) throw new Error('Invalid '+n); return new Date(v).toISOString(); };
const list = (v,n) => strings(v,n).map(x=>text(x,n));
function termsView(input) {
  if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(k=>!['title','description','acceptance','kind','paths','required_capabilities','lesson_ids'].includes(k))) throw new Error('Invalid negotiation terms');
  const result={title:text(input.title,'title',200),description:text(input.description,'description',4000),acceptance:list(input.acceptance,'acceptance'),
    kind:input.kind??'implementation',paths:list(input.paths,'paths').map(relativePath),requiredCapabilities:list(input.required_capabilities??[],'capabilities').map(c=>c.toLowerCase())};
  if(!result.acceptance.length || !result.paths.length || !taskKinds.includes(result.kind)) throw new Error('Terms require acceptance, paths and valid kind');
  const ids = lessonIds(input.lesson_ids === undefined ? [] : input.lesson_ids);
  if (ids.length) result.lessonIds = ids;
  return result;
}
const termKey = t => JSON.stringify({title:t.title,description:t.description,acceptance:t.acceptance,kind:t.kind,paths:t.paths,requiredCapabilities:t.requiredCapabilities,...(t.lessonIds ? {lessonIds:t.lessonIds} : {}),...(t.lessons ? {lessons:t.lessons} : {})});
function pinnedTerms(state, terms) {
  return terms.lessonIds ? {...terms,lessons:pinLessons(state,terms.lessonIds)} : terms;
}
const active = (a,now) => a.status==='active' && Date.parse(a.expiresAt)>now;
function agreementsFor(state,from,to,terms,now) {
  return [ [from,to], [to,from] ].map(([owner,peer])=>{
    const agreement=(state.collaborationAgreements??[]).find(a=>a.owner===owner && a.peerOwner===peer && active(a,now) && a.allowedKinds.includes(terms.kind) && terms.paths.every(p=>a.allowedPaths.some(root=>within(p,root))));
    if(!agreement) throw new Error('Active bilateral collaboration agreements must cover the terms');
    return agreement;
  });
}
const retry = (history, actor, key, fingerprint) => {
  const previous=history.find(h=>h.actorId===actor && h.requestId===key);
  if(previous && previous.fingerprint!==fingerprint) throw new Error('request_id already used for different content');
  return previous;
};

export async function setCollaborationAgreement({agent_id,peer_owner,allowed_kinds,allowed_paths,expires_at,request_id}) {
  peer_owner=text(peer_owner,'peer_owner',100); request_id=text(request_id,'request_id',120);
  allowed_kinds=list(allowed_kinds,'allowed_kinds'); allowed_paths=list(allowed_paths,'allowed_paths').map(relativePath);
  expires_at=timestamp(expires_at,'expires_at');
  if(!allowed_kinds.length || allowed_kinds.some(k=>!taskKinds.includes(k)) || !allowed_paths.length) throw new Error('Invalid agreement scope');
  const fingerprint=JSON.stringify({peer_owner,allowed_kinds,allowed_paths,expires_at}),id=randomUUID();
  return this.change(state=>{
    const actor=this.actor(state,agent_id),all=state.collaborationAgreements??=[];
    const old=all.find(a=>a.owner===actor.owner && a.requestId===request_id);
    if(old) {if(old.fingerprint!==fingerprint)throw new Error('request_id already used for different content');return old;}
    if(actor.owner===peer_owner || !Object.values(state.agents).some(a=>a.owner===peer_owner)) throw new Error('Peer must be a different registered contributor owner');
    if(Date.parse(expires_at)<=this.now())throw new Error('Agreement expiry must be in the future');
    if(all.some(a=>a.owner===actor.owner && a.peerOwner===peer_owner && active(a,this.now())))throw new Error('Revoke existing directional agreement before replacement');
    if(all.length>=200)throw new Error('Collaboration agreement registry full');
    const agreement={id,owner:actor.owner,peerOwner:peer_owner,createdBy:agent_id,allowedKinds:allowed_kinds,allowedPaths:allowed_paths,expiresAt:expires_at,
      status:'active',revision:1,requestId:request_id,fingerprint,createdAt:this.now(),history:[]};
    all.push(agreement);return agreement;
  });
}
export async function revokeCollaborationAgreement({agent_id,agreement_id,expected_revision,request_id,summary}) {
  revision(expected_revision);request_id=text(request_id,'request_id',120);summary=text(summary,'summary',2000);
  const fingerprint=JSON.stringify({expected_revision,summary});
  return this.change(state=>{
    const actor=this.actor(state,agent_id),a=(state.collaborationAgreements??[]).find(a=>a.id===agreement_id);
    if(!a || a.owner!==actor.owner)throw new Error('Only agreement owner can revoke');
    if(retry(a.history,agent_id,request_id,fingerprint))return a;
    if(a.revision!==expected_revision)throw new Error('Agreement revision changed');
    if(a.status!=='active')throw new Error('Agreement already revoked');
    a.status='revoked';a.revision++;a.revokedAt=this.now();
    a.history.push({actorId:agent_id,requestId:request_id,fingerprint,summary,createdAt:this.now()});return a;
  });
}
export async function listCollaborationAgreements({agent_id,after=0,limit=30}) {
  const {state}=await this.store.read(),actor=this.actor(state,agent_id);
  return page((state.collaborationAgreements??[]).filter(a=>a.owner===actor.owner || a.peerOwner===actor.owner),after,limit,'agreements');
}
function page(all,after,limit,key) {
  if(!Number.isInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Invalid pagination');
  const items=all.slice(after,after+limit);return {[key]:items,nextAfter:after+items.length,hasMore:after+items.length<all.length};
}

export async function proposeNegotiation({agent_id,recipient_id,work_id,terms,deadline,max_rounds=workflowDefaults.propose_negotiation.max_rounds,request_id,goal_id}) {
  request_id=text(request_id,'request_id',120);work_id=text(work_id,'work_id',120);terms=termsView(terms);deadline=timestamp(deadline,'deadline');
  if(!Number.isInteger(max_rounds)||max_rounds<1||max_rounds>5)throw new Error('Negotiation requires 1-5 rounds');
  if(goal_id!==undefined)goal_id=text(goal_id,'goal_id',150);
  const fingerprint=JSON.stringify({recipient_id,work_id,terms,deadline,max_rounds,...(goal_id?{goal_id}:{})}),id=randomUUID();
  return this.change(state=>{
    const actor=this.actor(state,agent_id),all=state.negotiations??=[];
    const old=all.find(n=>n.requesterId===agent_id && n.requestId===request_id);
    if(old){if(old.fingerprint!==fingerprint)throw new Error('request_id already used for different content');return old;}
    const peer=state.agents[recipient_id];
    if(!peer || peer.owner===actor.owner)throw new Error('Recipient must be an exact worker of another contributor');
    if(Date.parse(deadline)<=this.now())throw new Error('Negotiation deadline must be in the future');
    if(all.some(n=>n.requesterOwner===actor.owner && n.workId===work_id))throw new Error('Work already has a negotiation; do not reset its budget');
    if(all.length>=200)throw new Error('Negotiation registry full');
    const offer = pinnedTerms(state,terms);
    const n={id,...(goal_id?{goalId:goal_id}:{}),workId:work_id,requesterId:agent_id,recipientId:recipient_id,requesterOwner:actor.owner,performerOwner:peer.owner,
      terms:offer,deadline,maxRounds:max_rounds,round:1,offeredBy:agent_id,status:'proposed',revision:1,requestId:request_id,fingerprint,
      createdAt:this.now(),updatedAt:this.now(),history:[{actorId:agent_id,offeredBy:agent_id,action:'propose',terms:structuredClone(offer),round:1,createdAt:this.now()}]};
    assertGoalTask(state,taskFor(n,'pending',this.now()),actor,this.now(),'create');
    all.push(n);return n;
  });
}
export async function getNegotiation({agent_id,negotiation_id}) {
  const {state}=await this.store.read();this.actor(state,agent_id);
  const n=(state.negotiations??[]).find(n=>n.id===negotiation_id);
  if(!n || ![n.requesterId,n.recipientId].includes(agent_id))throw new Error('Negotiation belongs to other workers');
  return n;
}
export async function listNegotiations({agent_id,after=0,limit=30}) {
  const {state}=await this.store.read();this.actor(state,agent_id);
  return page((state.negotiations??[]).filter(n=>[n.requesterId,n.recipientId].includes(agent_id)),after,limit,'negotiations');
}
function taskFor(n,id,now) {
  return {id,...(n.goalId?{goalId:n.goalId}:{}),...structuredClone(n.terms),createdBy:n.requesterId,assigneeId:n.recipientId,dependsOn:[],parentTaskId:null,
    requestId:'negotiation-'+n.id,fingerprint:termKey(n.terms),status:'ready',revision:1,chainDepth:0,handoffCount:0,
    createdAt:now,updatedAt:now,history:[],negotiationId:n.id};
}
export async function advanceNegotiation({agent_id,negotiation_id,expected_revision,request_id,action,summary,terms}) {
  revision(expected_revision);request_id=text(request_id,'request_id',120);summary=text(summary,'summary',2000);
  if(!['counter','accept','decline','defer','cancel'].includes(action))throw new Error('Invalid negotiation action');
  if(action==='counter')terms=termsView(terms);else if(terms!==undefined)throw new Error('Only counter may change terms');
  const fingerprint=JSON.stringify({expected_revision,action,summary,terms});
  const policy=action==='accept'?await this.readPolicy():null,taskId=randomUUID();
  return this.change(state=>{
    const actor=this.actor(state,agent_id),n=(state.negotiations??[]).find(n=>n.id===negotiation_id);
    if(!n || ![n.requesterId,n.recipientId].includes(agent_id))throw new Error('Negotiation belongs to other workers');
    if(retry(n.history,agent_id,request_id,fingerprint))return n;
    if(n.revision!==expected_revision)throw new Error('Negotiation revision changed');
    if(!['proposed','deferred'].includes(n.status))throw new Error('Negotiation is terminal');
    if(action!=='cancel' && this.now()>=Date.parse(n.deadline))throw new Error('Negotiation deadline expired; decision required');
    if(n.history.length>=30)throw new Error('Negotiation history full');
    if(action==='cancel') {if(agent_id!==n.requesterId)throw new Error('Only requester can cancel');n.status='cancelled';}
    else {
      if(n.offeredBy===agent_id)throw new Error('Wait for other participant to respond to latest offer');
      if(action==='counter') {
        if(n.round>=n.maxRounds)throw new Error('Negotiation round budget exhausted; decision required');
        assertGoalTask(state,taskFor({...n,terms},'pending',this.now()),actor,this.now(),'create');
        n.round++;n.terms=pinnedTerms(state,terms);n.offeredBy=agent_id;n.status='proposed';
      } else if(action==='accept') {
        if (termKey(pinnedTerms(state,n.terms)) !== termKey(n.terms)) throw new Error('Offered lesson pins changed');
        const agreements=agreementsFor(state,n.requesterOwner,n.performerOwner,n.terms,this.now());
        const task=taskFor(n,taskId,this.now());
        assertGoalTask(state,task,actor,this.now(),'create');
        if(!policy)throw new Error('Local autonomy policy required to accept negotiated work');
        // A requester can approve a performer counter only within its own scope.
        // The recipient still checks its independent policy when accepting task.
        const localTask={...task,assigneeId:actor.id,requiredCapabilities:agent_id===n.recipientId?task.requiredCapabilities:[]};
        delete localTask.negotiationId;
        const decision=eligibility(state,actor,localTask,policy,this.now(),{goalExecution:false});
        if(!decision.allowed)throw new Error(decision.reasons.join('; '));
        const tasks=state.tasks??=[];if(tasks.length>=500)throw new Error('Task registry full');
        n.status='accepted';n.taskId=task.id;n.agreementIds=agreements.map(a=>a.id);n.acceptedTermsKey=termKey(n.terms);
        tasks.push(task);
      } else n.status=action==='defer'?'deferred':'declined';
    }
    n.revision++;n.updatedAt=this.now();n.history.push({actorId:agent_id,requestId:request_id,fingerprint,action,summary,createdAt:this.now(),round:n.round,offeredBy:n.offeredBy,...(['counter','accept'].includes(action)?{terms:structuredClone(n.terms)}:{})});return n;
  });
}

// Run after idempotent retry detection. Progress/complete must recheck scope;
// block/cancel remain available to record a stop after revocation or expiry.
export function assertCollaborationTaskAction(state,task,actor,policy,now,action='accept') {
  if(!task.negotiationId)return;
  if(['block','cancel'].includes(action))return;
  if(['assign','handoff','route'].includes(action))throw new Error('Negotiated task worker binding cannot change; negotiate separate scoped work');
  const n=(state.negotiations??[]).find(n=>n.id===task.negotiationId);
  if(!n || n.status!=='accepted' || n.taskId!==task.id || n.recipientId!==task.assigneeId || n.requesterId!==task.createdBy ||
     state.agents[n.recipientId]?.owner!==n.performerOwner || state.agents[n.requesterId]?.owner!==n.requesterOwner ||
     (task.goalId??null)!==(n.goalId??null) || termKey(task)!==n.acceptedTermsKey || termKey(n.terms)!==n.acceptedTermsKey || actor.id!==n.recipientId)throw new Error('Negotiated task terms or worker binding changed');
  const current=agreementsFor(state,n.requesterOwner,n.performerOwner,n.terms,now);
  if(!Array.isArray(n.agreementIds) || current.some(a=>!n.agreementIds.includes(a.id)))throw new Error('Accepted collaboration agreement replaced or revoked');
  if(!policy)throw new Error('Local autonomy policy required for negotiated execution');
}

const str={type:'string',minLength:1},arr={type:'array',items:str,maxItems:30},integer={type:'integer',minimum:1};
const actor={agent_id:str},mutation={...actor,expected_revision:integer,request_id:str,summary:str};
const termSchema={type:'object',properties:{title:str,description:str,acceptance:arr,kind:{...str,enum:taskKinds},paths:arr,required_capabilities:arr,lesson_ids:lessonIdsSchema},required:['title','description','acceptance','paths'],additionalProperties:false};
const tool=(name,description,properties,required,readOnlyHint=false)=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint,destructiveHint:false,openWorldHint:true}});
export const collaborationTools=[
  tool('set_collaboration_agreement','Record owner-authorized directional scope. This shared declaration never grants local execution permission or changes policy.',{...actor,peer_owner:str,allowed_kinds:arr,allowed_paths:arr,expires_at:str,request_id:str},['agent_id','peer_owner','allowed_kinds','allowed_paths','expires_at','request_id']),
  tool('revoke_collaboration_agreement','Owner revokes a directional agreement. Negotiated execution stops; records remain.',{...mutation,agreement_id:str},['agent_id','agreement_id','expected_revision','request_id','summary']),
  tool('list_collaboration_agreements','Read agreements involving your contributor. Expired/revoked records remain evidence.',{...actor,after:{type:'integer',minimum:0},limit:integer},['agent_id'],true),
  tool('propose_negotiation','Propose bounded work to an exact worker of another contributor. work_id must identify the same work across retries; never invent a new ID to reset limits.',{...actor,recipient_id:str,work_id:str,goal_id:str,terms:termSchema,deadline:str,max_rounds:{...integer,maximum:5},request_id:str},['agent_id','recipient_id','work_id','terms','deadline','request_id']),
  tool('advance_negotiation','Counter or respond to latest other-side offer. Acceptance creates ready work, never executes it. Defer preserves deadline and rounds.',{...mutation,negotiation_id:str,action:{...str,enum:['counter','accept','decline','defer','cancel']},terms:termSchema},['agent_id','negotiation_id','expected_revision','request_id','action','summary']),
  tool('get_negotiation','Inspect exact negotiation, terms, budget and task reference.',{...actor,negotiation_id:str},['agent_id','negotiation_id'],true),
  tool('list_negotiations','List negotiations for your exact worker; follow pagination.',{...actor,after:{type:'integer',minimum:0},limit:integer},['agent_id'],true),
];
export const collaborationMethods={set_collaboration_agreement:'setCollaborationAgreement',revoke_collaboration_agreement:'revokeCollaborationAgreement',list_collaboration_agreements:'listCollaborationAgreements',propose_negotiation:'proposeNegotiation',advance_negotiation:'advanceNegotiation',get_negotiation:'getNegotiation',list_negotiations:'listNegotiations'};
