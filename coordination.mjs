import { decisionTaskReasons } from './decisions.mjs';
import { goalReasons } from './goals.mjs';
import { contractTaskReasons } from './contracts.mjs';
import { readFile } from 'node:fs/promises';

export const taskKinds = ['implementation', 'review', 'research', 'documentation', 'testing'];
export function boundedText(value, name, max = 300) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid '+name);
  return value.trim();
}
export function strings(value, name, max = 30) {
  if (!Array.isArray(value) || value.length > max) throw new Error('Invalid '+name);
  return [...new Set(value.map(v => boundedText(v,name)))];
}
export function relativePath(value) {
  const path = boundedText(value,'path').replaceAll('\\','/').replace(/\/+$/,'').toLowerCase();
  if (!path || path.startsWith('/') || /[:*?\x00-\x1f]/.test(path) || path.split('/').some(p=>!p||p==='.'||p==='..')) throw new Error('Invalid repository-relative path');
  return path;
}
export const within = (path, root) => path === root || path.startsWith(root+'/');
export function profileView(agent, now) {
  const p = agent.profile;
  return {provider:p?.provider ?? 'unspecified', capabilities:p?.capabilities ?? [],
    paths:p?.paths ?? [], availability:p && p.availableUntil > now ? p.availability : 'unknown',
    reportedAt:p?.reportedAt ?? null, availableUntil:p?.availableUntil ?? null, revision:p?.revision ?? 0};
}
export async function updateAgent({agent_id, expected_revision, provider, label, capabilities=[], paths=[], availability='available', lease_minutes=15}) {
  provider=boundedText(provider,'provider',80);
  if (label!==undefined) label=boundedText(label,'label',80);
  capabilities=strings(capabilities,'capabilities').map(c=>c.toLowerCase());
  paths=strings(paths,'paths').map(relativePath);
  if (!['available','busy','offline'].includes(availability)) throw new Error('Invalid availability');
  if (!Number.isInteger(lease_minutes) || lease_minutes<1 || lease_minutes>120) throw new Error('Availability lease must be 1-120 minutes');
  if (!Number.isInteger(expected_revision) || expected_revision<0) throw new Error('Invalid profile revision');
  return this.change(state=>{
    const a=this.actor(state,agent_id), now=this.now();
    if ((a.profile?.revision??0)!==expected_revision) throw new Error('Profile revision changed; read team_status');
    if (label!==undefined) a.label=label;
    a.profile={provider,capabilities:[...new Set(capabilities)],paths,availability,
      reportedAt:now,availableUntil:now+lease_minutes*60000,revision:expected_revision+1};
    a.seenAt=now; return {agentId:a.id,label:a.label,...profileView(a,now)};
  });
}
export async function findAgents({capabilities=[], paths=[], available_only=true, after=0, limit=30}) {
  capabilities=strings(capabilities,'capabilities').map(c=>c.toLowerCase());
  paths=strings(paths,'paths').map(relativePath);
  if (typeof available_only!=='boolean' || !Number.isInteger(after) || after<0 || !Number.isInteger(limit) || limit<1 || limit>100) throw new Error('Invalid agent filter or pagination');
  const {state}=await this.store.read(), now=this.now();
  const matches=Object.values(state.agents).map(a=>({id:a.id,owner:a.owner,label:a.label,seenAt:a.seenAt,profile:profileView(a,now)}))
    .filter(a=>(!available_only||a.profile.availability==='available') &&
      capabilities.every(c=>a.profile.capabilities.includes(c)) &&
      paths.every(path=>a.profile.paths.some(root=>within(path,root))));
  return {agents:matches.slice(after,after+limit),hasMore:matches.length>after+limit,
    nextAfter:after+Math.min(limit,Math.max(0,matches.length-after)),note:'Capabilities and availability are self-reported, not verified access or live presence.'};
}

export function validatePolicy(input, repo, login) {
  if (!input || typeof input!=='object' || Array.isArray(input)) throw new Error('Invalid autonomy policy');
  const allowed=['version','repo','owner','allowed_kinds','allowed_paths','allow_unassigned','max_active_tasks','max_chain_depth','max_handoffs','max_task_minutes','expires_at','task_time_extensions'];
  if (Object.keys(input).some(k=>!allowed.includes(k)) || input.version!==1 || input.repo!==repo || input.owner!==login) throw new Error('Autonomy policy version, repository, owner or fields do not match');
  const kinds=strings(input.allowed_kinds,'allowed_kinds');
  const paths=strings(input.allowed_paths,'allowed_paths').map(relativePath);
  if (!kinds.length || kinds.some(k=>!taskKinds.includes(k)) || !paths.length || typeof input.allow_unassigned!=='boolean') throw new Error('Invalid autonomy scope');
  for (const [key,min,max] of [['max_active_tasks',1,20],['max_chain_depth',0,10],['max_handoffs',0,20],['max_task_minutes',1,1440]]) {
    if (!Number.isInteger(input[key]) || input[key]<min || input[key]>max) throw new Error('Invalid '+key);
  }
  if (typeof input.expires_at!=='string' || !Number.isFinite(Date.parse(input.expires_at))) throw new Error('Invalid policy expiry');
  if (input.task_time_extensions!==undefined) {
    if (!Array.isArray(input.task_time_extensions) || input.task_time_extensions.length>100) throw new Error('Invalid task time extensions');
    const ids=new Set();
    for (const e of input.task_time_extensions) {
      if (!e || typeof e!=='object' || Object.keys(e).sort().join(',')!=='authorization_evidence,started_at,task_id,until') throw new Error('Invalid task time extension fields');
      boundedText(e.task_id,'extension task id',100); boundedText(e.authorization_evidence,'extension authorization evidence',2000);
      const until=Date.parse(e.until);
      if (ids.has(e.task_id) || !Number.isSafeInteger(e.started_at) || e.started_at<0 || typeof e.until!=='string' || !Number.isFinite(until) || until<=e.started_at || until>e.started_at+30*86400000 || until>Date.parse(input.expires_at)) throw new Error('Invalid task time extension bounds');
      ids.add(e.task_id);
    }
  }
  return {...input,allowed_kinds:kinds,allowed_paths:paths};
}
// Local owner authorization only: exact task and original start, never a reset.
export function taskDeadline(task, policy) {
  if (task.startedAt===undefined) return Date.parse(policy.expires_at);
  const base=task.startedAt+policy.max_task_minutes*60000;
  const extension=policy.task_time_extensions?.find(e=>e.task_id===task.id && e.started_at===task.startedAt);
  return Math.min(Date.parse(policy.expires_at), Math.max(base,extension?Date.parse(extension.until):base));
}
export function policyReader(repo, login, path=new URL('./runtime/autonomy.json',import.meta.url)) {
  return async()=>{
    let content;
    try { content=await readFile(path,'utf8'); } catch(error) { if(error.code==='ENOENT') return null; throw new Error('Cannot read autonomy policy'); }
    return validatePolicy(JSON.parse(content),repo,login);
  };
}
export function eligibility(state, actor, task, policy, now, {goalExecution=true,contractSource=task}={}) {
  const reasons=[...decisionTaskReasons(state,contractSource,now),...goalReasons(state,task,actor,now,{execution:goalExecution}),...contractTaskReasons(state,contractSource,actor,now)];
  if(task.decisionReceipts?.length&&!policy)reasons.push('Local autonomy policy required after decision adoption');
  if(task.contractId&&!policy)reasons.push('Local autonomy policy required for contract execution');
  if (!['ready','in_progress','blocked'].includes(task.status)) reasons.push('Task is terminal');
  if (task.assigneeId && task.assigneeId!==actor.id) reasons.push('Task belongs to another worker');
  if (task.dependsOn.some(id=>(state.tasks??[]).find(t=>t.id===id)?.status!=='completed')) reasons.push('Dependencies are not completed');
  if ((task.requiredCapabilities??[]).some(c=>!actor.profile?.capabilities.includes(c))) reasons.push('Worker lacks required reported capabilities');
  if (policy) {
    if (now>=Date.parse(policy.expires_at)) reasons.push('Autonomy policy expired; ask the user to renew it');
    if (!policy.allowed_kinds.includes(task.kind??'implementation')) reasons.push('Task category needs user approval');
    if (!task.paths?.length || task.paths.some(p=>!policy.allowed_paths.some(root=>within(p,root)))) reasons.push('Task paths need user approval');
    if (!task.assigneeId && !policy.allow_unassigned) reasons.push('Unassigned work is not authorized');
    if ((task.chainDepth??0)>policy.max_chain_depth) reasons.push('Task chain depth exceeds policy');
    if ((task.handoffCount??0)>policy.max_handoffs) reasons.push('Handoff count exceeds policy');
    const active=(state.tasks??[]).filter(t=>t.id!==task.id && t.assigneeId===actor.id && ['in_progress','blocked'].includes(t.status)).length;
    if (active>=policy.max_active_tasks) reasons.push('Active task limit reached');
    if (task.startedAt!==undefined && now>=taskDeadline(task,policy)) reasons.push('Task time budget exhausted; record progress and escalate');
  }
  return {allowed:reasons.length===0,reasons,policyConfigured:!!policy,
    note:policy?'Dead Drop scope checks do not sandbox execution. Recheck before each work segment.':'No local autonomy policy. Existing user authorization is still required.'};
}
export async function checkTask({agent_id, task_id}) {
  const policy=await this.readPolicy(), {state}=await this.store.read(), actor=this.actor(state,agent_id);
  const task=(state.tasks??[]).find(t=>t.id===task_id);
  if (!task) throw new Error('Task not found');
  const result=eligibility(state,actor,task,policy,this.now());
  if (task.negotiationId) {
    const {assertCollaborationTaskAction}=await import('./collaboration.mjs');
    try { assertCollaborationTaskAction(state,task,actor,policy,this.now(),'accept'); }
    catch(error) { result.reasons.push(error.message); result.allowed=false; }
  }
  return result;
}
