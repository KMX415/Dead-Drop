import { skillDigest } from '../skills.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox } from '../mailbox.mjs';
import { emptyState } from '../github.mjs';
import * as collaboration from '../collaboration.mjs';

async function fixture() {
  let time=Date.parse('2026-01-01T00:00:00Z');
  const store={state:emptyState(),revision:0,async read(){return {state:structuredClone(this.state),sha:this.revision};},async write(state,sha){if(sha!==this.revision)throw Object.assign(new Error('Conflict'),{status:409});this.state=structuredClone(state);this.revision++;}};
  const boxes={},ids={},policies={};
  for(const owner of ['alice','bob','carol']) {
    policies[owner]={allowed_kinds:['implementation','review'],allowed_paths:['src'],allow_unassigned:false,max_active_tasks:3,max_chain_depth:3,max_handoffs:3,max_task_minutes:120,expires_at:'2026-01-02T00:00:00Z'};
    boxes[owner]=new Mailbox(store,owner,()=>time,async()=>policies[owner]);
    for(const name of Object.values(collaboration.collaborationMethods))boxes[owner][name]=collaboration[name];
    ids[owner]=(await boxes[owner].join({label:owner,task:'Collaboration test'})).id;
    await boxes[owner].updateAgent({agent_id:ids[owner],expected_revision:0,provider:'synthetic',capabilities:['testing'],paths:['src']});
  }
  const terms={title:'Implement parser',description:'Scoped parser work',acceptance:['Tests pass'],kind:'implementation',paths:['src/parser'],required_capabilities:['testing']};
  const agreement=(owner,peer)=>boxes[owner].setCollaborationAgreement({agent_id:ids[owner],peer_owner:peer,allowed_kinds:['implementation'],allowed_paths:['src'],expires_at:'2026-01-01T01:00:00Z',request_id:'agreement-'+peer});
  const propose=(extra={})=>boxes.alice.proposeNegotiation({agent_id:ids.alice,recipient_id:ids.bob,work_id:'parser',terms,deadline:'2026-01-01T00:30:00Z',max_rounds:3,request_id:'propose',...extra});
  const advance=(owner,n,action,extra={})=>boxes[owner].advanceNegotiation({agent_id:ids[owner],negotiation_id:n.id,expected_revision:n.revision,request_id:action+'-'+n.revision,action,summary:'Observed scoped decision',...extra});
  return {store,boxes,ids,policies,terms,agreement,propose,advance,now:()=>time,advanceTime:ms=>time+=ms};
}

test('bilateral agreement and local policy gates; acceptance atomically creates one ready task',async()=>{
  const f=await fixture(),n=await f.propose();
  await assert.rejects(f.advance('bob',n,'accept'),/bilateral/);
  await f.agreement('alice','bob');await f.agreement('bob','alice');
  const saved=f.policies.bob;f.policies.bob=null;
  await assert.rejects(f.advance('bob',n,'accept'),/policy required/);f.policies.bob=saved;
  const accepted=await f.advance('bob',n,'accept');
  const retried=await f.advance('bob',n,'accept');
  assert.equal(retried.taskId,accepted.taskId);assert.equal(f.store.state.tasks.length,1);
  const task=f.store.state.tasks[0];assert.equal(task.status,'ready');assert.equal(task.assigneeId,f.ids.bob);
  assert.equal(task.createdBy,f.ids.alice);assert.equal(task.negotiationId,n.id);
  assert.equal(task.startedAt,undefined);
  collaboration.assertCollaborationTaskAction(f.store.state,task,f.store.state.agents[f.ids.bob],saved,f.now());
});

test('counteroffer changes exact terms and only opposite participant accepts current revision',async()=>{
  const f=await fixture();await f.agreement('alice','bob');await f.agreement('bob','alice');
  let n=await f.propose();
  await assert.rejects(f.advance('alice',n,'accept'),/other participant/);
  n=await f.advance('bob',n,'counter',{terms:{...f.terms,paths:['src/narrow']}});
  await assert.rejects(f.advance('bob',n,'accept'),/other participant/);
  await assert.rejects(f.advance('carol',n,'accept'),/other workers/);
  const accepted=await f.advance('alice',n,'accept');
  assert.equal(accepted.status,'accepted');assert.deepEqual(f.store.state.tasks[0].paths,['src/narrow']);
  assert.deepEqual(accepted.history[0].terms.paths,['src/parser']);
  assert.equal(accepted.history[0].offeredBy,f.ids.alice);
  assert.deepEqual(accepted.history[1].terms.paths,['src/narrow']);
  assert.equal(accepted.history[1].offeredBy,f.ids.bob);
  assert.deepEqual(accepted.history[2].terms,accepted.history[1].terms);
  // Requester approval never claims that the remote worker's local scope passed.
  f.policies.bob=null;
  assert.throws(()=>collaboration.assertCollaborationTaskAction(f.store.state,f.store.state.tasks[0],f.store.state.agents[f.ids.bob],null,f.now()),/policy required/);
});

test('defer, exhausted round limits and deadlines cannot reset work budget',async()=>{
  const f=await fixture();let n=await f.propose({max_rounds:1});
  n=await f.advance('bob',n,'defer');assert.equal(n.round,1);assert.equal(n.status,'deferred');
  await assert.rejects(f.advance('bob',n,'counter',{terms:f.terms}),/budget exhausted/);
  await assert.rejects(f.propose({request_id:'reset'}),/reset its budget/);
  f.advanceTime(31*60000);
  await assert.rejects(f.advance('bob',n,'accept'),/deadline expired/);
  n=await f.advance('alice',n,'cancel');assert.equal(n.status,'cancelled');
  await assert.rejects(f.advance('bob',n,'decline'),/terminal/);
});

test('revocation, expiry, term mutation and reassignment stop negotiated execution',async()=>{
  const f=await fixture();const a=await f.agreement('alice','bob');await f.agreement('bob','alice');
  const n=await f.propose();await f.advance('bob',n,'accept');
  const task=f.store.state.tasks[0],actor=f.store.state.agents[f.ids.bob];
  const gate=(taskArg=task,action='accept')=>collaboration.assertCollaborationTaskAction(f.store.state,taskArg,actor,f.policies.bob,f.now(),action);
  assert.throws(()=>gate({...task,title:'Changed'}),/terms or worker/);
  assert.throws(()=>gate({...task,assigneeId:f.ids.carol}),/terms or worker/);
  assert.throws(()=>gate(task,'handoff'),/binding cannot change/);
  await assert.rejects(f.boxes.bob.revokeCollaborationAgreement({agent_id:f.ids.bob,agreement_id:a.id,expected_revision:1,request_id:'revoke',summary:'Not mine'}),/owner/);
  await f.boxes.alice.revokeCollaborationAgreement({agent_id:f.ids.alice,agreement_id:a.id,expected_revision:1,request_id:'revoke',summary:'Owner revoked'});
  assert.throws(()=>gate(),/bilateral/);assert.doesNotThrow(()=>gate(task,'block'));
  await f.boxes.alice.setCollaborationAgreement({agent_id:f.ids.alice,peer_owner:'bob',allowed_kinds:['implementation'],allowed_paths:['src'],expires_at:'2026-01-01T02:00:00Z',request_id:'replacement'});
  assert.throws(()=>gate(),/replaced or revoked/);
  f.advanceTime(61*60000);assert.throws(()=>gate(),/bilateral/);
});

test('concurrent accepts cannot duplicate tasks and changed retry payload fails',async()=>{
  const f=await fixture();await f.agreement('alice','bob');await f.agreement('bob','alice');const n=await f.propose();
  const [a,b]=await Promise.all([f.advance('bob',n,'accept'),f.advance('bob',n,'accept')]);
  assert.equal(a.taskId,b.taskId);assert.equal(f.store.state.tasks.length,1);
  await assert.rejects(f.advance('bob',n,'accept',{summary:'Different'}),/different content/);
  await assert.rejects(f.propose({terms:{...f.terms,title:'Different'}}),/different content/);
});

test('declining, pagination and validated scopes retain inspectable negotiation records',async()=>{
  const f=await fixture();const n=await f.propose();const declined=await f.advance('bob',n,'decline');assert.equal(declined.status,'declined');
  assert.equal((await f.boxes.bob.getNegotiation({agent_id:f.ids.bob,negotiation_id:n.id})).id,n.id);
  assert.equal((await f.boxes.bob.listNegotiations({agent_id:f.ids.bob,limit:1})).negotiations.length,1);
  await assert.rejects(f.boxes.carol.getNegotiation({agent_id:f.ids.carol,negotiation_id:n.id}),/other workers/);
  await assert.rejects(f.propose({work_id:'bad',request_id:'bad',terms:{...f.terms,paths:['../escape']}}),/relative/);
  await assert.rejects(f.propose({work_id:'bad',request_id:'bad',terms:{...f.terms,unexpected:true}}),/terms/);
});

test('acceptance refuses expired local policy and unreported recipient capabilities',async()=>{
  const f=await fixture();await f.agreement('alice','bob');await f.agreement('bob','alice');const n=await f.propose();
  f.policies.bob.expires_at='2025-12-31T23:59:59Z';
  await assert.rejects(f.advance('bob',n,'accept'),/policy expired/);
  f.policies.bob.expires_at='2026-01-02T00:00:00Z';
  await f.boxes.bob.updateAgent({agent_id:f.ids.bob,expected_revision:1,provider:'synthetic',capabilities:[],paths:['src']});
  await assert.rejects(f.advance('bob',n,'accept'),/capabilities/);
  assert.equal((f.store.state.tasks??[]).length,0);
});

test('offers bind exact lesson versions through counters, retries and task creation',async()=>{
  const f=await fixture();
  const skills=['one','two'].map(id=>{
    const skill={id,name:id,version:1,status:'published'};
    return {...skill,digest:skillDigest(skill)};
  });
  f.store.state.skills=skills;
  await f.agreement('alice','bob');await f.agreement('bob','alice');
  const terms={...f.terms,lesson_ids:['one']};
  const offer=await f.propose({terms});
  assert.equal(offer.terms.lessons[0].digest,skills[0].digest);
  const counter=await f.advance('bob',offer,'counter',{terms:{...terms,lesson_ids:['two']}});
  f.store.state.skills[1].status='retired';
  await assert.rejects(f.advance('alice',counter,'accept'),/published/);
  assert.equal((await f.propose({terms})).id,offer.id);
  f.store.state.skills[1].status='published';
  f.store.state.skills[1].version=2;
  f.store.state.skills[1].digest=skillDigest(f.store.state.skills[1]);
  await assert.rejects(f.advance('alice',counter,'accept'),/pins changed/);
  f.store.state.skills[1]={...skills[1]};
  const accepted=await f.advance('alice',counter,'accept');
  const task=f.store.state.tasks[0];
  assert.deepEqual(task.lessons,[{id:'two',version:1,digest:skills[1].digest}]);
  assert.deepEqual(accepted.history[0].terms.lessonIds,['one']);
  assert.throws(()=>collaboration.assertCollaborationTaskAction(f.store.state,{...task,lessons:[]},f.store.state.agents[f.ids.bob],f.policies.bob,f.now()),/terms or worker/);
});
