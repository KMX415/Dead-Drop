import { workflowDefaults } from './workflow-defaults.mjs';
import { randomUUID } from 'node:crypto';
import { boundedText, strings, within, eligibility } from './coordination.mjs';
import { assertCollaborationTaskAction } from './collaboration.mjs';
import { goalReasons } from './goals.mjs';

const integer=(n,name,max=Number.MAX_SAFE_INTEGER)=>{if(!Number.isInteger(n)||n<1||n>max)throw new Error('Invalid '+name);};
const evidence=items=>{const result=strings(items,'evidence');if(!result.length)throw new Error('Evidence required');return result;};
const participant=(record,id)=>record.requesterId===id||record.history.some(h=>h.recipientId===id);
export function peerHelpView(record,now){return {...record,effectivePhase:['resolved','escalated'].includes(record.phase)?record.phase:now>=Date.parse(record.deadline)?'expired':record.phase==='responded'&&record.attempt>=record.maxAttempts?'exhausted':record.phase};}
function source(state,record,revision){
  const task=(state.tasks??[]).find(t=>t.id===record.taskId);
  if(!task||task.revision!==revision||record.taskRevision!==revision)throw new Error('Task revision changed; escalate stale help');
  if(task.status!=='blocked'||task.assigneeId!==record.requesterId)throw new Error('Help requires blocked task assigned to requester');
  return task;
}
function agreements(state,requester,peer,task,now){
  if(requester.owner===peer.owner)return;
  for(const [owner,other] of [[requester.owner,peer.owner],[peer.owner,requester.owner]]){
    if(!(state.collaborationAgreements??[]).some(a=>a.owner===owner&&a.peerOwner===other&&a.status==='active'&&Date.parse(a.expiresAt)>now&&a.allowedKinds.includes('review')&&task.paths?.length&&task.paths.every(p=>a.allowedPaths.some(root=>within(p,root)))))throw new Error('Active bilateral review agreements must cover help scope');
  }
}
function selectPeer(state,actor,task,id,capabilities,now){
  const candidates=id?[state.agents[id]]:Object.values(state.agents).sort((a,b)=>a.id.localeCompare(b.id));
  const peers=candidates.filter(p=>p&&p.id!==actor.id&&capabilities.every(c=>p.profile?.capabilities?.includes(c))&&(!id?p.profile?.availability==='available'&&p.profile.availableUntil>now:true));
  for(const peer of peers){try{
    const reasons=goalReasons(state,{...task,assigneeId:peer.id,kind:'review',requiredCapabilities:[]},peer,now,{execution:false});
    if(reasons.length)throw new Error(reasons.join('; '));
    agreements(state,actor,peer,task,now);return peer;
  }catch(error){if(id)throw error;}}
  throw new Error('No eligible exact peer; wait or escalate');
}
function authorize(state,actor,task,policy,now,review=false){
  assertCollaborationTaskAction(state,task,review?state.agents[task.assigneeId]:actor,policy,now);
  const result=eligibility(state,actor,review?{...task,assigneeId:actor.id,kind:'review',requiredCapabilities:[]}:task,policy,now,{goalExecution:false});
  if(!result.allowed)throw new Error(result.reasons.join('; '));
}
export async function requestPeerHelp({agent_id,task_id,expected_task_revision,recipient_id,required_capabilities=[],max_attempts=workflowDefaults.request_peer_help.max_attempts,deadline,summary,request_id}){
  integer(expected_task_revision,'expected_task_revision');integer(max_attempts,'max_attempts',5);
  summary=boundedText(summary,'summary',4000);request_id=boundedText(request_id,'request_id',120);required_capabilities=strings(required_capabilities,'required_capabilities');
  if(!recipient_id&&!required_capabilities.length)throw new Error('Supply exact recipient or required capabilities');
  if(typeof deadline!=='string'||!Number.isFinite(Date.parse(deadline)))throw new Error('Invalid deadline');
  const fingerprint=JSON.stringify({task_id,expected_task_revision,recipient_id,required_capabilities,max_attempts,deadline,summary}),id=randomUUID();
  const policy=await this.readPolicy();
  return this.change(state=>{
    const actor=this.actor(state,agent_id),all=state.peerHelp??=[];
    const old=all.find(r=>r.requesterId===agent_id&&r.requestId===request_id);
    if(old){if(old.fingerprint!==fingerprint)throw new Error('request_id already used for different content');return old;}
    if(all.some(r=>r.taskId===task_id))throw new Error('Task already has help; its budget cannot reset');
    if(all.length>=200)throw new Error('Peer help registry full');
    const now=this.now();if(Date.parse(deadline)<=now)throw new Error('Deadline must be future');
    const task=source(state,{taskId:task_id,taskRevision:expected_task_revision,requesterId:agent_id},expected_task_revision);
    authorize(state,actor,task,policy,now);
    const peer=selectPeer(state,actor,task,recipient_id,required_capabilities,now);
    const record={id,taskId:task_id,taskRevision:task.revision,requesterId:agent_id,recipientId:peer.id,requiredCapabilities:required_capabilities,maxAttempts:max_attempts,attempt:1,deadline,summary,phase:'awaiting_response',revision:1,requestId:request_id,fingerprint,createdAt:now,updatedAt:now,history:[{action:'request',actorId:agent_id,recipientId:peer.id,summary,createdAt:now}]};
    all.push(record);return record;
  });
}
export async function advancePeerHelp({agent_id,help_id,expected_revision,expected_task_revision,action,summary,evidence:items=[],recipient_id,request_id}){
  integer(expected_revision,'expected_revision');integer(expected_task_revision,'expected_task_revision');
  if(!['respond','retry','resolve','escalate'].includes(action))throw new Error('Invalid help action');
  if(action!=='retry'&&recipient_id!==undefined)throw new Error('Recipient only applies to retry');
  summary=boundedText(summary,'summary',4000);request_id=boundedText(request_id,'request_id',120);
  items=['respond','resolve'].includes(action)?evidence(items):strings(items,'evidence');
  const fingerprint=JSON.stringify({expected_revision,expected_task_revision,action,summary,items,recipient_id});
  const policy=['respond','retry'].includes(action)?await this.readPolicy():null;
  return this.change(state=>{
    const actor=this.actor(state,agent_id),record=(state.peerHelp??[]).find(r=>r.id===help_id);
    if(!record)throw new Error('Help not found');
    const old=record.history.find(h=>h.actorId===agent_id&&h.requestId===request_id);
    if(old){if(old.fingerprint!==fingerprint)throw new Error('request_id already used for different content');return record;}
    if(record.revision!==expected_revision)throw new Error('Help revision changed');
    if(['resolved','escalated'].includes(record.phase))throw new Error('Help is terminal');
    if(action==='respond'?agent_id!==record.recipientId:agent_id!==record.requesterId)throw new Error('Only exact designated worker can perform help action');
    const now=this.now();
    if(action==='escalate'){record.phase='escalated';}
    else{
      const task=source(state,record,expected_task_revision);
      if(now>=Date.parse(record.deadline))throw new Error('Help deadline expired; escalate');
      if(action==='respond'){
        if(record.phase!=='awaiting_response')throw new Error('Help is not awaiting response');
        agreements(state,state.agents[record.requesterId],actor,task,now);authorize(state,actor,task,policy,now,true);record.phase='responded';
      }else if(action==='retry'){
        if(record.phase!=='responded')throw new Error('Wait for response or escalate');
        if(record.attempt>=record.maxAttempts)throw new Error('Help attempt budget exhausted; escalate');
        authorize(state,actor,task,policy,now);
        record.recipientId=selectPeer(state,actor,task,recipient_id,record.requiredCapabilities,now).id;
        record.attempt++;record.phase='awaiting_response';
      }else{
        if(record.phase!=='responded')throw new Error('Response required before resolution');
        record.phase='resolved';
      }
    }
    record.revision++;record.updatedAt=now;
    record.history.push({actorId:agent_id,recipientId:record.recipientId,requestId:request_id,fingerprint,action,summary,evidence:items,attempt:record.attempt,createdAt:now});
    return record;
  });
}
export async function getPeerHelp({agent_id,help_id}){
  const {state}=await this.store.read();this.actor(state,agent_id);
  const record=(state.peerHelp??[]).find(r=>r.id===help_id);if(!record||!participant(record,agent_id))throw new Error('Help not found for worker');
  return peerHelpView(record,this.now());
}
export async function listPeerHelp({agent_id,after=0,limit=30}){
  if(!Number.isInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Invalid pagination');
  const {state}=await this.store.read();this.actor(state,agent_id);
  const all=(state.peerHelp??[]).filter(r=>participant(r,agent_id)),items=all.slice(after,after+limit).map(r=>peerHelpView(r,this.now()));
  return {help:items,nextAfter:after+items.length,hasMore:after+items.length<all.length};
}
const str={type:'string',minLength:1},int={type:'integer',minimum:1},arr={type:'array',maxItems:30,items:str};
const tool=(name,description,properties,required,readOnlyHint=false)=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint,destructiveHint:false,openWorldHint:true}});
export const peerHelpTools=[
  tool('request_peer_help','Request bounded advice on a blocked task. One help budget per task. No execution permission, messages or automatic resume.',{agent_id:str,task_id:str,expected_task_revision:int,recipient_id:str,required_capabilities:arr,max_attempts:{...int,maximum:5},deadline:str,summary:str,request_id:str},['agent_id','task_id','expected_task_revision','deadline','summary','request_id']),
  tool('advance_peer_help','Exact peer responds with evidence; requester retries within fixed budget, resolves advice, or escalates. Resolution does not resume task.',{agent_id:str,help_id:str,expected_revision:int,expected_task_revision:int,action:{...str,enum:['respond','retry','resolve','escalate']},summary:str,evidence:arr,recipient_id:str,request_id:str},['agent_id','help_id','expected_revision','expected_task_revision','action','summary','request_id']),
  tool('get_peer_help','Read exact help record and untrusted peer evidence.',{agent_id:str,help_id:str},['agent_id','help_id'],true),
  tool('list_peer_help','Read paginated help involving exact worker; expired and exhausted records need escalation.',{agent_id:str,after:{type:'integer',minimum:0},limit:{...int,maximum:100}},['agent_id'],true),
];
export const peerHelpMethods={request_peer_help:'requestPeerHelp',advance_peer_help:'advancePeerHelp',get_peer_help:'getPeerHelp',list_peer_help:'listPeerHelp'};
