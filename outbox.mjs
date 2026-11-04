import { mkdir,readFile,readdir,writeFile,link,unlink,stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';

const allowed=new Set(['recover_contract','request_decision','resolve_decision','create_integration_check','advance_integration_check','propose_contract','advance_contract','create_goal','update_goal','reserve_goal_usage','settle_goal_usage','request_peer_help','advance_peer_help','record_skill_validation','begin_worker_run','finish_worker_run','archive_worker_run','send_message','create_task','update_task','create_skill','review_skill','update_skill','record_skill_use','route_task','save_checkpoint','start_review_cycle','advance_review_cycle','propose_skill_improvement','resolve_skill_improvement','set_collaboration_agreement','revoke_collaboration_agreement','propose_negotiation','advance_negotiation','create_handoff','record_handoff_verification']);
const hash=text=>createHash('sha256').update(text).digest('hex');
const canonical=value=> {
  if (value===null || typeof value!=='object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
};
const encoded=value=>JSON.stringify(canonical(value));
export const supportsDurable=(tool,args)=>allowed.has(tool) && typeof args?.request_id==='string' && !!args.request_id.trim() && args.request_id.length<=120 && typeof args?.agent_id==='string' && !!args.agent_id.trim();
const nameFor=(tool,args)=>hash(encoded({tool,agentId:args.agent_id,requestId:args.request_id,target:args.task_id??args.skill_id??args.cycle_id??args.improvement_id??args.agreement_id??args.negotiation_id??args.handoff_id??args.goal_id??args.help_id??args.run_id??args.contract_id??args.integration_id??args.decision_id??null}));
const tooLarge=()=>new Error('Outbox record exceeds 100 KB');
async function atomicCreate(path,content) {
  const temporary=path+'.'+randomUUID()+'.tmp';
  await writeFile(temporary,content,{flag:'wx',mode:0o600});
  try { await link(temporary,path); return true; }
  catch (error) { if (error.code==='EEXIST') return false; throw error; }
  finally { await unlink(temporary).catch(()=>{}); }
}
async function readRecord(directory,file) {
  try {
    const path=join(directory,file);
    if ((await stat(path)).size>102400) throw tooLarge();
    const content=await readFile(path,'utf8');
    if (Buffer.byteLength(content)>102400) throw tooLarge();
    const record=JSON.parse(content);
    if (record.version!==1 || Object.keys(record).sort().join(',')!=='args,tool,version' || !supportsDurable(record.tool,record.args) || file!==nameFor(record.tool,record.args)+'.json') throw new Error();
    return record;
  } catch { throw new Error('Invalid outbox record; inspect local storage before retrying'); }
}
async function delivered(directory,name,record) {
  try {
    const marker=join(directory,name+'.done');
    if ((await stat(marker)).size!==64 || (await readFile(marker,'utf8'))!==hash(encoded(record))) throw new Error('Invalid marker');
    return true;
  }
  catch (error) { if (error.code==='ENOENT') return false; throw new Error('Cannot read outbox delivery marker'); }
}
export async function runDurable({directory,tool,args,invoke}) {
  if (!supportsDurable(tool,args)) throw new Error('Operation does not support durable retries');
  const record=JSON.parse(encoded({version:1,tool,args})), content=encoded(record);
  if (Buffer.byteLength(content)>102400) throw tooLarge();
  await mkdir(directory,{recursive:true});
  const name=nameFor(tool,args), file=name+'.json';
  let existing;
  try { existing=await readRecord(directory,file); }
  catch (error) {
    // Distinguish an absent record from malformed persisted input; never replace the latter.
    try { await stat(join(directory,file)); } catch (missing) { if (missing.code==='ENOENT') existing=null; else throw error; }
    if (existing!==null) throw error;
  }
  if (!existing) {
    if ((await readdir(directory)).filter(f=>f.endsWith('.json')).length>=500) throw new Error('Outbox full; archive deliberately before continuing');
    const created=await atomicCreate(join(directory,file),content);
    if (created && (await readdir(directory)).filter(f=>f.endsWith('.json')).length>500) {
      // A concurrent caller may already have read this same immutable payload
      // and started delivery. Never remove a persisted operation on overflow:
      // interruption after that delivery must still leave a recoverable record.
      throw new Error('Outbox full; persisted operation retained. Inspect and archive deliberately before continuing');
    }
    existing=await readRecord(directory,file);
  }
  if (encoded(existing)!==content) throw new Error('Outbox retry key already used for different content');
  await delivered(directory,name,record); // Reject corrupt markers before any explicit retry.
  // Calling a delivered operation again is an explicit retry; server-side keys return its current result.
  const result=await invoke(tool,record.args);
  await atomicCreate(join(directory,name+'.done'),hash(content));
  return result;
}
export async function replayOutbox({directory,invoke,agentId}) {
  if (typeof agentId!=='string' || !agentId.trim()) throw new Error('Replay requires an exact agent identity');
  let files;
  try { files=(await readdir(directory)).filter(f=>f.endsWith('.json')).sort(); }
  catch (error) { if (error.code==='ENOENT') return {operations:[],hasMore:false}; throw new Error('Cannot read local outbox'); }
  if (files.length>500) throw new Error('Outbox capacity exceeded; inspect local storage');
  // Validate the entire bounded collection before invoking any operation.
  const pending=[];
  for (const file of files) {
    const record=await readRecord(directory,file), name=file.slice(0,-5);
    if (record.args.agent_id===agentId && !await delivered(directory,name,record)) pending.push({name,record});
  }
  const operations=[];
  for (const {name,record} of pending.slice(0,20)) {
    try {
      await invoke(record.tool,record.args);
      await atomicCreate(join(directory,name+'.done'),hash(encoded(record)));
      operations.push({operationId:name,tool:record.tool,status:'delivered'});
    } catch {
      operations.push({operationId:name,tool:record.tool,status:'pending',reason:'Delivery not confirmed. Inspect current task and authorization before retrying.'});
    }
  }
  return {operations,hasMore:pending.length>20};
}
