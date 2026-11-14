import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mailbox } from '../mailbox.mjs';
import { emptyState } from '../github.mjs';
import { call } from '../tools.mjs';
import { validatePolicy, policyReader, taskDeadline } from '../coordination.mjs';

class Store {
  state=emptyState(); revision=0;
  async read(){return {state:structuredClone(this.state),sha:this.revision};}
  async write(state,sha){
    if(sha!==this.revision)throw Object.assign(new Error('Conflict'),{status:409});
    this.state=structuredClone(state);this.revision++;
  }
}
const policy=()=>({version:1,repo:'team/mailbox',owner:'alice',allowed_kinds:['implementation','review'],
  allowed_paths:['src'],allow_unassigned:false,max_active_tasks:1,max_chain_depth:1,max_handoffs:1,
  max_task_minutes:30,expires_at:'2030-01-01T00:00:00Z'});
async function setup() {
  const store=new Store();let clock=Date.parse('2026-10-12T12:00:00Z'), localPolicy=null;
  const alice=new Mailbox(store,'alice',()=>clock,async()=>localPolicy);
  const bob=new Mailbox(store,'bob',()=>clock);
  const a=(await alice.join({label:'Implementation',task:'Code'})).id;
  const b=(await bob.join({label:'Review',task:'Review'})).id;
  const create=(extra={})=>call(alice,'create_task',JSON.parse(JSON.stringify({agent_id:a,title:'Fix parser',description:'Handle empty input',
    acceptance:['Tests pass'],request_id:'task',paths:['src/parser.mjs'],assignee_id:a,...extra})));
  const update=(task,action,extra={})=>call(alice,'update_task',{agent_id:a,task_id:task.id,
    expected_revision:task.revision,request_id:action+'-'+task.revision,action,summary:'Progress recorded',...extra});
  return {store,alice,bob,a,b,create,update,setPolicy:p=>localPolicy=p,advance:ms=>clock+=ms};
}
test('profiles are owner-only, revision checked, filterable, and expire without writes',async()=>{
  const {alice,bob,a,b,advance,store}=await setup();
  const input={agent_id:a,expected_revision:0,provider:'codex',capabilities:['JavaScript','review'],
    label:'Parser specialist',paths:['SRC'],availability:'available',lease_minutes:5};
  await assert.rejects(call(bob,'update_agent',input),/identity/);
  await call(alice,'update_agent',input);
  await call(bob,'update_agent',{...input,agent_id:b,provider:'claude',availability:'busy'});
  await assert.rejects(call(alice,'update_agent',input),/revision/);
  const match=await call(alice,'find_agents',{capabilities:['javascript'],paths:['src/parser.mjs']});
  assert.deepEqual(match.agents.map(a=>a.id),[a]);
  assert.equal(match.agents[0].label,'Parser specialist');
  assert.equal((await alice.findAgents({paths:['src-other/file']})).agents.length,0);
  assert.equal((await alice.findAgents({available_only:false,limit:1})).hasMore,true);
  const revision=store.revision;
  advance(5*60000);
  assert.equal((await alice.findAgents({})).agents.length,0);
  assert.equal((await alice.status()).agents.find(x=>x.id===a).profile.availability,'unknown');
  assert.equal(store.revision,revision);
});
test('required capabilities gate acceptance even without a local policy',async()=>{
  const {alice,a,create,update}=await setup();
  const task=await create({required_capabilities:['Review']});
  await assert.rejects(update(task,'accept'),/capabilities/);
  await alice.updateAgent({agent_id:a,expected_revision:0,provider:'claude',capabilities:['review']});
  assert.equal((await update(task,'accept')).status,'in_progress');
});
test('policy checks explain category, bounded path and assignment restrictions',async()=>{
  const {alice,a,create,update,setPolicy}=await setup(); setPolicy(policy());
  for(const [key,extra,reason] of [
    ['kind',{kind:'research'},/category/],
    ['paths',{paths:['src-other/file']},/paths/],
    ['empty',{paths:[]},/paths/],
    ['assignment',{assignee_id:undefined},/Unassigned/],
  ]) {
    const task=await create({...extra,request_id:key});
    const decision=await call(alice,'check_task',{agent_id:a,task_id:task.id});
    assert.equal(decision.allowed,false);assert.equal(decision.policyConfigured,true);
    await assert.rejects(update(task,'accept'),reason);
  }
});
test('concurrent acceptance respects active-work cap; expired work can still record blockers',async()=>{
  const {alice,a,create,update,setPolicy,advance}=await setup(); setPolicy(policy());
  const one=await create(),two=await create({request_id:'two'});
  const results=await Promise.allSettled([update(one,'accept'),update(two,'accept')]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.match(results.find(r=>r.status==='rejected').reason.message,/Active task limit/);
  let active=results.find(r=>r.status==='fulfilled').value;
  advance(30*60000);
  const decision=await alice.checkTask({agent_id:a,task_id:active.id});
  assert.equal(decision.allowed,false);assert.match(decision.reasons.join(' '),/time budget/);
  active=await update(active,'block',{summary:'Time budget exhausted; needs user input'});
  await assert.rejects(update(active,'resume'),/time budget/);
  assert.equal((await update(active,'cancel')).status,'cancelled');
});
test('follow-up depth and handoff count persist and gate further autonomous chaining',async()=>{
  const {alice,bob,a,b,create,update,setPolicy}=await setup(); setPolicy(policy());
  let root=await create();
  const child=await create({request_id:'child',parent_task_id:root.id});
  assert.equal(child.chainDepth,1);
  await assert.rejects(create({request_id:'grandchild',parent_task_id:child.id}),/chain depth/);
  root=await update(root,'accept');
  root=await update(root,'handoff',{assignee_id:b,next_steps:['Review result']});
  root=await bob.updateTask({agent_id:b,task_id:root.id,expected_revision:root.revision,
    request_id:'accept',action:'accept',summary:'Reviewing'});
  root=await bob.updateTask({agent_id:b,task_id:root.id,expected_revision:root.revision,
    request_id:'return',action:'handoff',summary:'Needs another pass',assignee_id:a,next_steps:['Fix review notes']});
  assert.equal(root.handoffCount,2);
  await assert.rejects(update(root,'accept'),/Handoff count/);
});
test('policy expiry is enforced on fresh work and legacy operation stays compatible',async()=>{
  const {alice,a,create,update,setPolicy}=await setup();
  const task=await create();
  assert.equal((await alice.checkTask({agent_id:a,task_id:task.id})).policyConfigured,false);
  setPolicy({...policy(),expires_at:'2020-01-01T00:00:00Z'});
  await assert.rejects(update(task,'accept'),/expired/);
  setPolicy(null);
  assert.equal((await update(task,'accept')).status,'in_progress');
});
test('local policy validates owner/repo and reloads edits; malformed data fails closed',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'relay-policy-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'autonomy.json'),read=policyReader('team/mailbox','alice',path);
  assert.equal(await read(),null);
  await writeFile(path,JSON.stringify(policy()));
  assert.equal((await read()).max_active_tasks,1);
  await writeFile(path,JSON.stringify({...policy(),max_active_tasks:2}));
  assert.equal((await read()).max_active_tasks,2);
  for(const invalid of [{owner:'bob'},{repo:'another/mailbox'},{allowed_paths:['../x']},{max_task_minutes:0},
    {allowed_kinds:['deploy']},{expires_at:'never'},{unexpected:true}]) {
    assert.throws(()=>validatePolicy({...policy(),...invalid},'team/mailbox','alice'));
  }
  await writeFile(path,'{bad');
  await assert.rejects(read());
});

test('owner extension is exact-task/start bound and preserves original history',async()=>{
 const f=await setup(); f.setPolicy(policy()); let t=await f.update(await f.create(),'accept');
 const started=t.startedAt; f.advance(31*60000);
 assert.equal((await f.alice.checkTask({agent_id:f.a,task_id:t.id})).allowed,false);
 const p=validatePolicy({...policy(),task_time_extensions:[{task_id:t.id,started_at:started,until:new Date(started+7*86400000).toISOString(),authorization_evidence:'Owner explicitly approved seven days'}]},'team/mailbox','alice');
 f.setPolicy(p);assert.equal((await f.alice.checkTask({agent_id:f.a,task_id:t.id})).allowed,true);
 assert.equal(taskDeadline({...t,id:'other'},p),started+30*60000);
 assert.equal(taskDeadline({...t,startedAt:started+1},p),started+1+30*60000);
 assert.equal(f.store.state.tasks.find(x=>x.id===t.id).startedAt,started);
 f.advance(7*86400000);assert.equal((await f.alice.checkTask({agent_id:f.a,task_id:t.id})).allowed,false);
});
test('malformed and overlong extensions fail closed',()=>{
 const e={task_id:'task',started_at:1000,until:new Date(86401000).toISOString(),authorization_evidence:'Owner approved'};
 for(const extensions of [null,{},[e,e],[{...e,authorization_evidence:''}],[{...e,until:'never'}],[{...e,started_at:-1}],[{...e,until:new Date(1000+31*86400000).toISOString()}],[{...e,extra:true}]])assert.throws(()=>validatePolicy({...policy(),task_time_extensions:extensions},'team/mailbox','alice'));
 assert.throws(()=>validatePolicy({...policy(),expires_at:new Date(2000).toISOString(),task_time_extensions:[e]},'team/mailbox','alice'));
});
