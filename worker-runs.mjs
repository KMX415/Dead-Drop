import { workflowDefaults } from './workflow-defaults.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { boundedText } from './coordination.mjs';

const note='Run records are worker self-reports, not independent scheduler proof. Leases coordinate compliant workers; they do not start, stop, or sandbox a process. Reconcile external effects before retrying interrupted work.';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text=(v,n,max=300)=>boundedText(v,n,max);
const evidenceList=value=>{
  if(!Array.isArray(value)||!value.length||value.length>20)throw new Error('Supply 1-20 evidence entries');
  return value.map(v=>text(v,'evidence',1000));
};
export const runView=(run,now)=>{
  const {fingerprint,finishFingerprint,requestId,finishRequestId,...visible}=run;
  return {...visible,archiveDigest:hash(visible),effectiveStatus:run.status==='running'&&now>=run.leaseUntil?'interrupted':run.status,note};
};
export async function beginWorkerRun({agent_id,request_id,host,provider,trigger,schedule_id,scheduler_run_id,evidence,lease_minutes=workflowDefaults.begin_worker_run.lease_minutes}) {
  request_id=text(request_id,'request_id',120);host=text(host,'host');provider=text(provider,'provider',80);
  if(!['interactive','scheduled'].includes(trigger))throw new Error('Invalid trigger');
  if(!Number.isInteger(lease_minutes)||lease_minutes<1||lease_minutes>60)throw new Error('Lease must be 1-60 minutes');
  if(trigger==='scheduled') {schedule_id=text(schedule_id,'schedule_id');scheduler_run_id=text(scheduler_run_id,'scheduler_run_id');}
  else if(schedule_id!==undefined||scheduler_run_id!==undefined)throw new Error('Interactive runs cannot claim scheduler identifiers');
  evidence=evidenceList(evidence);
  const content={host,provider,trigger,scheduleId:schedule_id??null,schedulerRunId:scheduler_run_id??null,evidence,leaseMinutes:lease_minutes};
  const fingerprint=hash(content),id=randomUUID();
  return this.change(state=>{
    const actor=this.actor(state,agent_id),runs=state.workerRuns??=[],now=this.now();
    if((state.archivedWorkerRuns??[]).some(r=>r.agentId===agent_id&&(r.requestId===request_id||(trigger==='scheduled'&&r.schedulerKey===hash({host,schedule_id,scheduler_run_id})))))throw new Error('Run already archived; inspect saved evidence, do not repeat effects');
    const old=runs.find(r=>r.agentId===agent_id&&r.requestId===request_id);
    if(old){if(old.fingerprint!==fingerprint)throw new Error('request_id already used for different content');return runView(old,now);}
    if(trigger==='scheduled'&&runs.some(r=>r.agentId===agent_id&&r.host===host&&r.scheduleId===schedule_id&&r.schedulerRunId===scheduler_run_id))throw new Error('Scheduler run already recorded; reuse original request_id');
    if(runs.some(r=>r.agentId===agent_id&&r.status==='running'&&r.leaseUntil>now))throw new Error('Worker already has an active run lease');
    if(runs.length>=500)throw new Error('Run registry full; archive deliberately');
    const run={id,agentId:agent_id,...content,startedAt:now,leaseUntil:now+lease_minutes*60000,status:'running',revision:1,requestId:request_id,fingerprint};
    runs.push(run);actor.seenAt=now;return runView(run,now);
  });
}
export async function finishWorkerRun({agent_id,run_id,request_id,expected_revision,status,summary,evidence}) {
  request_id=text(request_id,'request_id',120);summary=text(summary,'summary',2000);evidence=evidenceList(evidence);
  if(!['completed','blocked','failed'].includes(status))throw new Error('Invalid run outcome');
  if(expected_revision!==1)throw new Error('Invalid run revision');
  const fingerprint=hash({status,summary,evidence,expected_revision});
  return this.change(state=>{
    this.actor(state,agent_id);const run=(state.workerRuns??[]).find(r=>r.id===run_id&&r.agentId===agent_id);
    if((state.archivedWorkerRuns??[]).some(r=>r.id===run_id&&r.agentId===agent_id))throw new Error('Run already archived; inspect saved evidence');
    if(!run)throw new Error('Worker run not found');
    if(run.finishRequestId===request_id){if(run.finishFingerprint!==fingerprint)throw new Error('request_id already used for different content');return runView(run,this.now());}
    if(run.status!=='running'||run.revision!==expected_revision)throw new Error('Run already finalized');
    // Late evidence is useful, but must never turn an expired lease into a verified success.
    const now=this.now();
    Object.assign(run,{status:now>=run.leaseUntil?'interrupted':status,reportedOutcome:status,summary,resultEvidence:evidence,finishedAt:now,revision:2,finishRequestId:request_id,finishFingerprint:fingerprint});
    return runView(run,now);
  });
}
export async function listWorkerRuns({agent_id,after=0,limit=30}) {
  if(!Number.isInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Invalid pagination');
  const {state}=await this.store.read();this.actor(state,agent_id);
  const runs=(state.workerRuns??[]).filter(r=>r.agentId===agent_id).map(r=>runView(r,this.now()));
  return {runs:runs.slice(after,after+limit),hasMore:runs.length>after+limit,nextAfter:after+Math.min(limit,Math.max(0,runs.length-after)),note};
}
export async function archiveWorkerRun({agent_id,run_id,request_id,expected_digest,archive_evidence}) {
  request_id=text(request_id,'request_id',120);archive_evidence=text(archive_evidence,'archive_evidence',1000);
  expected_digest=text(expected_digest,'expected_digest',64);
  const fingerprint=hash({run_id,expected_digest,archive_evidence});
  return this.change(state=>{
    this.actor(state,agent_id);const archived=state.archivedWorkerRuns??=[];
    const old=archived.find(r=>r.agentId===agent_id&&r.archiveRequestId===request_id);
    if(old){if(old.archiveFingerprint!==fingerprint)throw new Error('request_id already used for different content');return {archived:true,runId:old.id};}
    const run=(state.workerRuns??[]).find(r=>r.id===run_id&&r.agentId===agent_id);
    if(!run||run.status==='running')throw new Error('Finalize the exact worker run before archiving');
    if(runView(run,this.now()).archiveDigest!==expected_digest)throw new Error('Run evidence changed; save current record before archiving');
    if(archived.length>=2000)throw new Error('Run archive index full; deliberately migrate mailbox history before more archiving');
    archived.push({id:run.id,agentId:agent_id,requestId:run.requestId,schedulerKey:run.trigger==='scheduled'?hash({host:run.host,schedule_id:run.scheduleId,scheduler_run_id:run.schedulerRunId}):null,archiveRequestId:request_id,archiveFingerprint:fingerprint,archiveEvidence:archive_evidence});
    state.workerRuns=state.workerRuns.filter(r=>r.id!==run.id);
    return {archived:true,runId:run.id};
  });
}
const s={type:'string',minLength:1},agent={agent_id:s},items={type:'array',minItems:1,maxItems:20,items:s};
const tool=(name,description,properties,required,readOnly=false)=>({name,description,inputSchema:{type:'object',additionalProperties:false,properties,required},annotations:{readOnlyHint:readOnly,destructiveHint:false,openWorldHint:true}});
export const runTools=[
  tool('begin_worker_run','Record an observed host wake and acquire a bounded worker lease. Does not launch work or configure a scheduler. Scheduled identifiers and evidence must come from the actual host.',{...agent,request_id:s,host:s,provider:s,trigger:{type:'string',enum:['interactive','scheduled']},schedule_id:s,scheduler_run_id:s,evidence:items,lease_minutes:{type:'integer',minimum:1,maximum:60}},['agent_id','request_id','host','provider','trigger','evidence']),
  tool('finish_worker_run','Record actual results after a bounded wake. Expired runs remain interrupted even with late completion evidence.',{...agent,run_id:s,request_id:s,expected_revision:{type:'integer',minimum:1},status:{type:'string',enum:['completed','blocked','failed']},summary:s,evidence:items},['agent_id','run_id','request_id','expected_revision','status','summary','evidence']),
  tool('list_worker_runs','Inspect your run evidence and expired leases before recovering. Self-reports never prove a host scheduler ran.',{...agent,after:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100}},['agent_id'],true),
  tool('archive_worker_run','After saving the complete final record locally, archive it using its exact archiveDigest. Retains a tombstone to reject duplicate execution. Backup evidence is self-reported.',{...agent,run_id:s,request_id:s,expected_digest:s,archive_evidence:s},['agent_id','run_id','request_id','expected_digest','archive_evidence']),
];
export const runMethods={begin_worker_run:'beginWorkerRun',finish_worker_run:'finishWorkerRun',list_worker_runs:'listWorkerRuns',archive_worker_run:'archiveWorkerRun'};
