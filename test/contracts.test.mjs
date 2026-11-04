import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox } from '../mailbox.mjs';
import { emptyState, GitHubStore } from '../github.mjs';
import { call } from '../tools.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDurable, replayOutbox, supportsDurable } from '../outbox.mjs';

async function fixture() {
  let now=Date.parse('2026-01-01T00:00:00Z');
  const store={state:emptyState(),revision:0,async read(){return {state:structuredClone(this.state),sha:this.revision};},async write(state,sha){if(sha!==this.revision)throw Object.assign(new Error('Conflict'),{status:409});this.state=structuredClone(state);this.revision++;}};
  const boxes={},ids={},policies={};
  for(const owner of ['alice','bob','carol']) {
    policies[owner]={owner,allowed_kinds:['implementation'],allowed_paths:['src'],allow_unassigned:false,max_active_tasks:10,max_chain_depth:3,max_handoffs:3,max_task_minutes:120,expires_at:'2026-01-02T00:00:00Z'};
    boxes[owner]=new Mailbox(store,owner,()=>now,async()=>policies[owner]);
    ids[owner]=(await boxes[owner].join({label:owner,task:'Synthetic interface contract test'})).id;
    await boxes[owner].updateAgent({agent_id:ids[owner],expected_revision:0,provider:'synthetic',capabilities:['testing'],paths:['src']});
  }
  const invoke=(owner,name,args={})=>call(boxes[owner],name,{agent_id:ids[owner],...args});
  const agreement=(owner,peer,extra={})=>invoke(owner,'set_collaboration_agreement',{peer_owner:peer,allowed_kinds:['implementation'],allowed_paths:['src'],expires_at:'2026-01-01T01:00:00Z',request_id:'agreement-'+peer,...extra});
  const agreeAll=async()=>{for(const owner of Object.keys(ids))for(const peer of Object.keys(ids))if(owner!==peer)await agreement(owner,peer);};
  const terms={interface_description:'GET /items returns {items: [{id: string}]}',compatibility:'Existing IDs remain strings',examples:['An empty collection returns {items: []}']};
  const propose=(extra={})=>invoke('alice','propose_contract',{work_id:'items-api',participants:Object.values(ids),repository:'example/project',paths:['src'],...terms,deadline:'2026-01-01T00:30:00Z',max_versions:3,request_id:'propose',...extra});
  const advance=(owner,c,action,extra={})=>invoke(owner,'advance_contract',{contract_id:c.id,expected_revision:c.revision,digest:c.digest,action,summary:'Inspected declarative interface',request_id:action+'-'+c.revision,...extra});
  const acceptAll=async c=>{for(const owner of Object.keys(ids))c=await advance(owner,c,'accept');return c;};
  const create=(c,extra={})=>invoke('alice','create_task',{title:'Implement items',description:'Implement accepted schema',acceptance:['Schema fixture passes'],kind:'implementation',paths:['src/items'],assignee_id:ids.bob,request_id:'task',...(c?{contract_id:c.id,contract_digest:c.digest}:{}),...extra});
  const update=(owner,t,action,extra={})=>invoke(owner,'update_task',{task_id:t.id,expected_revision:t.revision,request_id:action+'-'+t.revision,action,summary:'Observed fixture evidence',...extra});
  return {store,boxes,ids,policies,invoke,agreement,agreeAll,terms,propose,advance,acceptAll,create,update,tick:ms=>now+=ms};
}

test('three contributors explicitly accept one digest under all bilateral agreements and local policy',async()=>{
  const f=await fixture();let c=await f.propose();
  assert.equal(c.status,'proposed');assert.deepEqual(c.versions[0].responses,[]);
  await assert.rejects(f.advance('alice',c,'accept'),/bilateral/);
  await f.agreeAll();
  const savedPolicy=f.policies.bob;f.policies.bob=null;
  await assert.rejects(f.advance('bob',c,'accept'),/policy/i);f.policies.bob=savedPolicy;
  f.policies.bob.expires_at='2025-12-31T00:00:00Z';
  await assert.rejects(f.advance('bob',c,'accept'),/policy/i);f.policies.bob.expires_at='2026-01-02T00:00:00Z';
  f.policies.bob.allowed_paths=['other'];await assert.rejects(f.advance('bob',c,'accept'),/policy/i);f.policies.bob.allowed_paths=['src'];
  c=await f.advance('alice',c,'accept');c=await f.advance('bob',c,'accept');
  assert.equal(c.status,'proposed'); // An offline consumer's silence never accepts.
  c=await f.advance('carol',c,'accept');assert.equal(c.status,'agreed');
  assert.equal(c.versions[0].responses.length,3);
  assert.ok(c.versions[0].responses.every(r=>r.agreementIds.length===6));
});

test('missing local policy blocks opted-in execution while safe contract responses remain available',async()=>{
  const f=await fixture();await f.agreeAll();const c=await f.acceptAll(await f.propose());const t=await f.create(c);
  f.policies.bob=null;await assert.rejects(f.update('bob',t,'accept'),/policy/i);
  const checked=await f.invoke('bob','check_task',{task_id:t.id});assert.equal(checked.allowed,false);assert.match(checked.reasons.join(),/policy/i);
  assert.equal((await f.invoke('bob','next_actions')).actions.find(a=>a.id==='accept_task:'+t.id).status,'blocked');
  const another=await f.propose({work_id:'safe-response',request_id:'safe-response'});
  f.boxes.bob.readPolicy=async()=>{throw new Error('Unreadable policy');};
  assert.equal((await f.advance('bob',another,'request_changes')).status,'proposed');
  const third=await f.propose({work_id:'decline',request_id:'decline'});
  assert.equal((await f.advance('bob',third,'decline')).status,'declined');
});

test('one owner can explicitly accept with two distinct workers without bilateral agreements',async()=>{
  const f=await fixture();const peer=(await f.boxes.alice.join({label:'Other provider',task:'Consumer'})).id;
  let c=await f.propose({participants:[f.ids.alice,peer]});c=await f.advance('alice',c,'accept');assert.equal(c.status,'proposed');
  c=await f.advance('alice',c,'accept',{agent_id:peer});assert.equal(c.status,'agreed');
  assert.ok(c.versions[0].responses.every(r=>r.agreementIds.length===0));
});

test('task references require exact observed revision and matching contract scope',async()=>{
  const f=await fixture();let t=await f.create(null);const ref={task_id:t.id,revision:t.revision};
  t=await f.update('bob',t,'accept');await assert.rejects(f.propose({task_refs:[ref]}),/revision changed/);
  await assert.rejects(f.propose({task_refs:[{task_id:t.id,revision:t.revision}],paths:['src/other']}),/scope/);
  const c=await f.propose({task_refs:[{task_id:t.id,revision:t.revision}]});assert.equal(c.taskRefs[0].revision,t.revision);
});

test('goal contract repinning is metadata and needs no execution reservation or concurrency slot',async()=>{
  const f=await fixture();await f.agreeAll();
  const goal=await f.invoke('alice','create_goal',{title:'Items',description:'Shared implementation',acceptance:['Schema tests pass'],participants:Object.values(f.ids),allowed_kinds:['implementation'],allowed_paths:['src'],max_tasks:3,max_concurrent:1,max_usage_units:10,deadline:'2026-01-01T00:40:00Z',request_id:'goal'});
  f.policies.alice.allowed_paths.push('outside');
  await assert.rejects(f.propose({goal_id:goal.id,paths:['outside']}),/scope/);
  let c=await f.acceptAll(await f.propose({goal_id:goal.id}));
  let t=await f.create(c,{goal_id:goal.id});const occupied=await f.create(null,{goal_id:goal.id,request_id:'occupied',assignee_id:f.ids.alice});
  await f.invoke('alice','reserve_goal_usage',{goal_id:goal.id,task_id:occupied.id,expected_revision:1,request_id:'reserve',units:1});await f.update('alice',occupied,'accept');
  c=await f.advance('alice',c,'revise',f.terms);c=await f.acceptAll(c);
  t=await f.update('bob',t,'pin_contract',{contract_id:c.id,contract_digest:c.digest});assert.equal(t.contractDigest,c.digest);
  await assert.rejects(f.update('bob',t,'accept'),/concurrency|reservation/);
  await assert.rejects(f.create(c,{request_id:'wrong-goal'}),/goal/);
});

test('implementation contract reviews use reviewer review policy while retaining original contract scope',async()=>{
  const f=await fixture();await f.agreeAll();const c=await f.acceptAll(await f.propose());let t=await f.create(c);t=await f.update('bob',t,'accept');
  await f.invoke('carol','update_agent',{expected_revision:1,provider:'synthetic',capabilities:['review'],paths:['src']});
  f.policies.carol.allowed_kinds=['review'];
  const other=(await f.boxes.carol.join({label:'Unaccepted reviewer',task:'Review'})).id;
  const args={task_id:t.id,expected_task_revision:t.revision,reviewer_id:other,request_id:'review',summary:'Ready',artifacts:['Fixture passed']};
  await assert.rejects(f.invoke('bob','start_review_cycle',args),/participant/);
  const cycle=await f.invoke('bob','start_review_cycle',{...args,reviewer_id:f.ids.carol});
  assert.equal((await f.invoke('carol','next_actions')).actions.find(a=>a.kind==='review_submission').status,'actionable');
  const approved=await f.invoke('carol','advance_review_cycle',{cycle_id:cycle.id,expected_revision:cycle.revision,expected_task_revision:t.revision,request_id:'approve',action:'approve',summary:'Schema checked',artifacts:['Fixture passed']});assert.equal(approved.phase,'approved');
});

test('contract durable outbox replays exact uncertain writes and optional collection rejects malformed storage',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'relay-contract-outbox-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const args={agent_id:'alice/worker',contract_id:'contract',expected_revision:1,digest:'a'.repeat(64),request_id:'accept',action:'accept',summary:'Checked'};
  assert.equal(supportsDurable('propose_contract',args),true);assert.equal(supportsDurable('advance_contract',args),true);
  await assert.rejects(runDurable({directory,tool:'advance_contract',args,invoke:async()=>{throw new Error('Uncertain delivery');}}));
  const seen=[];await replayOutbox({directory,agentId:args.agent_id,invoke:async(tool,input)=>{seen.push({tool,input});}});
  assert.deepEqual(seen,[{tool:'advance_contract',input:args}]);assert.deepEqual((await replayOutbox({directory,agentId:args.agent_id,invoke:async()=>assert.fail('duplicate')})).operations,[]);
  const store=new GitHubStore('example/private');store.api=async path=>path==='repos/example/private'?{private:true}:{sha:'sha',encoding:'base64',content:Buffer.from(JSON.stringify({...emptyState(),contracts:{}})).toString('base64')};
  await assert.rejects(store.read(),/schema/);
});

test('immutable successor resets responses; stale revisions and digests cannot accept',async()=>{
  const f=await fixture();await f.agreeAll();const first=await f.propose();
  let c=await f.advance('alice',first,'accept');
  await assert.rejects(f.advance('bob',first,'accept'),/revision or digest changed/);
  c=await f.advance('bob',c,'request_changes');
  await assert.rejects(f.advance('bob',c,'revise',f.terms),/Only proposer/);
  const previous=structuredClone(c.versions[0]);
  c=await f.advance('alice',c,'revise',{...f.terms,examples:['Errors include {error: {code: string}}']});
  assert.equal(c.version,2);assert.notEqual(c.digest,first.digest);assert.deepEqual(c.versions[1].responses,[]);
  assert.deepEqual(c.versions[0],{...previous,status:'superseded'});
  await assert.rejects(f.advance('carol',c,'accept',{digest:first.digest}),/revision or digest changed/);
  c=await f.acceptAll(c);assert.equal(c.status,'agreed');
});

test('concurrent responses require reread and retries never mutate immutable records',async()=>{
  const f=await fixture();await f.agreeAll();const c=await f.propose();
  assert.equal((await f.propose()).id,c.id);
  await assert.rejects(f.propose({compatibility:'different'}),/different content/);
  const results=await Promise.allSettled([f.advance('alice',c,'accept'),f.advance('bob',c,'accept')]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.match(results.find(r=>r.status==='rejected').reason.message,/revision or digest changed/);
  const winner=results[0].status==='fulfilled'?'alice':'bob';
  const revision=f.store.revision;await f.advance(winner,c,'accept');assert.equal(f.store.revision,revision);
  await assert.rejects(f.advance(winner,c,'accept',{summary:'Changed payload'}),/different content/);
});

test('version budgets, deadlines, declines and input limits bound contract work',async()=>{
  const f=await fixture();let c=await f.propose({max_versions:1});c=await f.advance('bob',c,'request_changes');
  assert.equal(c.exhausted,true);
  await assert.rejects(f.advance('alice',c,'revise',f.terms),/budget exhausted/);
  await assert.rejects(f.propose({request_id:'budget-reset'}),/reset its budget/);
  await assert.rejects(f.propose({work_id:'bad',request_id:'bad',max_versions:101}),/1-100/);
  await assert.rejects(f.propose({work_id:'bad',request_id:'bad',paths:['../outside']}),/relative/);
  await assert.rejects(f.propose({work_id:'bad',request_id:'bad',examples:[]}),/examples/);
  f.tick(30*60000);assert.equal((await f.invoke('bob','get_contract',{contract_id:c.id})).status,'expired');
  await assert.rejects(f.advance('alice',c,'revise',f.terms),/terminal/);
  const g=await fixture();let declined=await g.propose();declined=await g.advance('carol',declined,'decline');
  assert.equal(declined.status,'declined');await assert.rejects(g.advance('alice',declined,'revise',g.terms),/terminal/);
});

test('revoking an acceptance agreement cannot be repaired by silently replacing its identity',async()=>{
  const f=await fixture();await f.agreeAll();let c=await f.propose();c=await f.advance('alice',c,'accept');
  const a=f.store.state.collaborationAgreements.find(a=>a.owner==='alice'&&a.peerOwner==='bob');
  await f.invoke('alice','revoke_collaboration_agreement',{agreement_id:a.id,expected_revision:1,request_id:'revoke',summary:'Owner revoked scope'});
  await f.agreement('alice','bob',{request_id:'replacement'});
  await assert.rejects(f.advance('bob',c,'accept'),/expired or revoked/);
});

test('contract tasks require exact current agreement and completion evidence; unrelated work remains independent',async()=>{
  const f=await fixture();await f.agreeAll();let c=await f.propose();
  await assert.rejects(f.create(c),/agreed/);c=await f.acceptAll(c);
  await assert.rejects(f.create(c,{paths:['outside']}),/scope/);
  let t=await f.create(c);t=await f.update('bob',t,'accept');
  await assert.rejects(f.update('bob',t,'complete'),/evidence/i);
  await assert.rejects(f.update('bob',t,'complete',{contract_evidence:['']}),/evidence/i);
  t=await f.update('bob',t,'complete',{contract_evidence:['Fixture response conforms to accepted items schema']});
  assert.equal(t.status,'completed');assert.equal(t.history.at(-1).contractId,c.id);assert.equal(t.history.at(-1).contractDigest,c.digest);
  assert.deepEqual(t.history.at(-1).contractEvidence,['Fixture response conforms to accepted items schema']);
  let ordinary=await f.create(null,{request_id:'independent'});ordinary=await f.update('bob',ordinary,'accept');
  assert.equal((await f.update('bob',ordinary,'complete')).status,'completed');
});

test('superseded task pins gate execution until explicit assignee repin after renewed consensus',async()=>{
  const f=await fixture();await f.agreeAll();let c=await f.acceptAll(await f.propose());let t=await f.create(c);
  c=await f.advance('alice',c,'revise',{...f.terms,compatibility:'Add optional next cursor'});
  await assert.rejects(f.update('bob',t,'accept'),/superseded/);
  assert.equal((await f.invoke('bob','check_task',{task_id:t.id})).allowed,false);
  const actions=await f.invoke('bob','next_actions');assert.equal(actions.actions.find(a=>a.id==='accept_task:'+t.id).status,'blocked');
  await assert.rejects(f.update('bob',t,'pin_contract',{contract_id:c.id,contract_digest:c.digest}),/agreed/);
  c=await f.acceptAll(c);
  await assert.rejects(f.update('alice',t,'pin_contract',{contract_id:c.id,contract_digest:c.digest}),/assignee|assigned/i);
  t=await f.update('bob',t,'pin_contract',{contract_id:c.id,contract_digest:c.digest});assert.equal(t.contractDigest,c.digest);
  t=await f.update('bob',t,'accept');
  await assert.rejects(f.update('bob',t,'pin_contract',{contract_id:c.id,contract_digest:c.digest}),/ready|blocked|transition/i);
  const revised=await f.advance('alice',c,'revise',f.terms);
  for(const action of ['progress','complete','handoff'])await assert.rejects(f.update('bob',t,action,{next_steps:['Continue'],...(action==='handoff'?{assignee_id:f.ids.carol}:{}),...(action==='complete'?{contract_evidence:['fixture']}:{})}),/superseded/);
  t=await f.update('bob',t,'block');await assert.rejects(f.update('bob',t,'resume'),/superseded/);
  assert.equal(revised.status,'proposed');
});

test('unaccepted replacement workers cannot inherit contracts and ready tasks cannot swap contracts',async()=>{
  const f=await fixture();await f.agreeAll();const c=await f.acceptAll(await f.propose());const t=await f.create(c);
  const replacement=(await f.boxes.bob.join({label:'Replacement',task:'Same owner, different worker'})).id;
  await assert.rejects(f.invoke('bob','get_contract',{agent_id:replacement,contract_id:c.id}),/participant/);
  await assert.rejects(f.create(c,{request_id:'replacement-task',assignee_id:replacement}),/participant/);
  await assert.rejects(f.update('alice',t,'assign',{assignee_id:replacement}),/participant/);
  const other=await f.acceptAll(await f.propose({work_id:'different',request_id:'different'}));
  await assert.rejects(f.update('bob',t,'pin_contract',{contract_id:other.id,contract_digest:other.digest}),/same|replace|switch|different/i);
});

test('revoked agreements and expired contracts stop pinned work, including after accepted execution',async()=>{
  const f=await fixture();await f.agreeAll();const c=await f.acceptAll(await f.propose());let t=await f.create(c);t=await f.update('bob',t,'accept');
  const a=f.store.state.collaborationAgreements.find(a=>a.owner==='carol'&&a.peerOwner==='alice');
  await f.invoke('carol','revoke_collaboration_agreement',{agreement_id:a.id,expected_revision:1,request_id:'revoke',summary:'Contributor withdrew'});
  await assert.rejects(f.update('bob',t,'progress'),/expired or revoked/);
  assert.equal((await f.invoke('bob','check_task',{task_id:t.id})).allowed,false);
  t=await f.update('bob',t,'block');f.tick(31*60000);
  await assert.rejects(f.update('bob',t,'resume'),/agreed and unexpired/);
});

test('unreadable configured policies fail closed without recording contract acceptance',async()=>{
  const f=await fixture();await f.agreeAll();const c=await f.propose();
  f.boxes.bob.readPolicy=async()=>{throw new Error('Cannot read autonomy policy');};
  const before=JSON.stringify(f.store.state);await assert.rejects(f.advance('bob',c,'accept'),/Cannot read/);
  assert.equal(JSON.stringify(f.store.state),before);
  f.boxes.bob.readPolicy=async()=>({...f.policies.bob,owner:'alice'});
  await assert.rejects(f.advance('bob',c,'accept'),/owner mismatch/i);
});

test('pagination and continuation expose contracts without sending messages or acknowledging notifications',async()=>{
  const f=await fixture();const one=await f.propose({max_versions:1});const two=await f.propose({work_id:'other',request_id:'other'});
  const page=await f.invoke('bob','list_contracts',{limit:1});assert.equal(page.hasMore,true);assert.equal(page.contracts[0].id,one.id);
  assert.equal((await f.invoke('bob','list_contracts',{after:page.nextAfter})).contracts[0].id,two.id);
  await f.advance('bob',one,'request_changes');
  const before=JSON.stringify(f.store.state);
  const recovery=await f.invoke('alice','get_recovery');assert.ok(recovery.contracts.some(c=>c.id===one.id));
  const actions=await f.invoke('alice','next_actions');assert.ok(actions.actions.some(a=>a.inspect?.tool==='get_contract'));
  const notifications=await f.invoke('alice','list_notifications');assert.ok(notifications.notifications.some(n=>n.contractId===one.id));
  assert.equal(JSON.stringify(f.store.state),before);assert.deepEqual(f.store.state.messages,[]);
});

async function recoveryFixture(maxVersions=3,maxRecoveryVersions=2) {
  const f=await fixture();f.store.repo='example/mailbox';
  let c=await f.propose({max_versions:maxVersions,max_recovery_versions:maxRecoveryVersions});
  for(let i=1;i<maxVersions;i++)c=await f.advance('alice',c,'revise',f.terms);
  c=await f.advance('bob',c,'request_changes');
  const task=await f.create();
  let d=await f.invoke('alice','request_decision',{issue_key:'budget',required_responders:Object.values(f.ids),question:'Two more versions?',options:[{id:'bounded',label:'Two',tradeoffs:'Same scope'},{id:'defer',label:'Defer',tradeoffs:'Wait'}],evidence:['fixture:approval'],task_refs:[{task_id:task.id,revision:task.revision}],category:'budget',deadline:'2026-01-01T00:20:00Z',request_id:'decision'});
  for(const owner of Object.keys(f.ids))d=await f.invoke(owner,'resolve_decision',{decision_id:d.id,expected_revision:d.revision,request_id:'resolve',option_id:'bounded',rationale:'Fixture owner approval',authority:'human_report',authorization_evidence:['fixture:human']});
  const args={contract_id:c.id,expected_revision:c.revision,digest:c.digest,decision_id:d.id,expected_decision_revision:d.revision,decision_digest:d.digest,option_id:'bounded',additional_versions:2,authorization_id:'fixture-grant',request_id:'recover-once',summary:'Two authorized additional versions'};
  const {request_id,summary,...binding}=args;
  const grant={...binding,repo:f.store.repo,owner:'alice',agent_id:f.ids.alice,expires_at:'2026-01-01T00:15:00Z',owner_approvals:Object.keys(f.ids).map(owner=>({owner,evidence:'fixture:verified-owner-approval'}))};
  f.boxes.alice.readRecoveryAuthorizations=async()=>[grant];
  return {...f,c,d,args,grant,recover:(extra={})=>f.invoke('alice','recover_contract',{...args,...extra})};
}

test('contract recovery retains history and rejected digest, permits exactly two proposer revisions once',async()=>{
  const f=await recoveryFixture(),before=structuredClone(f.c);
  let c=await f.recover();
  assert.equal(c.maxVersions,3);assert.equal(c.effectiveMaxVersions,5);assert.equal(c.revision,before.revision+1);
  assert.deepEqual(c.versions,before.versions);assert.equal(c.digest,before.digest);assert.equal(c.status,'proposed');
  for(const key of ['participants','paths','deadline','workId','taskRefs','repository'])assert.deepEqual(c[key],before[key]);
  assert.deepEqual(c.history.slice(0,-1),before.history);
  await assert.rejects(f.advance('bob',c,'revise',f.terms),/Only proposer/);
  c=await f.advance('alice',c,'revise',f.terms);c=await f.advance('alice',c,'revise',f.terms);
  await assert.rejects(f.advance('alice',c,'revise',f.terms),/budget exhausted/);
  await assert.rejects(f.recover({expected_revision:c.revision,digest:c.digest,request_id:'new-key'}),/already used/);
  f.boxes.alice.readRecoveryAuthorizations=async()=>{throw new Error('approval removed');};
  assert.equal((await f.recover()).version,5);
  await assert.rejects(f.recover({summary:'changed'}),/different content/);
});

test('contract recovery rejects absent/local mismatched authorization and stale/excessive requests without writes',async()=>{
  const changes=[
    f=>{f.boxes.alice.readRecoveryAuthorizations=async()=>[];},
    f=>{f.grant.repo='other/mailbox';},f=>{f.grant.agent_id=f.ids.bob;},
    f=>{f.grant.additional_versions=1;},f=>{f.grant.owner_approvals.pop();},
    f=>{f.grant.expires_at='2025-01-01';},f=>{f.args.additional_versions=3;},
    f=>{f.args.expected_revision++;},f=>{f.args.digest='0'.repeat(64);},
    f=>{f.args.expected_decision_revision++;},f=>{f.args.decision_digest='0'.repeat(64);},
    f=>{f.args.option_id='defer';},f=>{f.policies.alice=null;},
    f=>{f.store.state.decisions[0].category='implementation';},
    f=>{f.store.state.decisions[0].deadline='2025-01-01';},
    f=>{f.store.state.decisions[0].requiredResponders.pop();},
    f=>{f.store.state.tasks[0].revision++;},
    f=>{f.store.state.contracts[0].deadline='2025-01-01';},
    f=>{f.store.state.contracts[0].versions.at(-1).responses=[];},
    f=>{f.store.state.contracts[0].status='declined';}
  ];
  for(const change of changes){const f=await recoveryFixture();change(f);const before=structuredClone(f.store.state);await assert.rejects(f.recover());assert.deepEqual(f.store.state,before);}
  const f=await recoveryFixture();await assert.rejects(f.invoke('bob','recover_contract',f.args),/Only proposer/);
});

test('concurrent exact recovery retries converge and durable replay does not add another allowance',async t=>{
  const f=await recoveryFixture();const results=await Promise.all([f.recover(),f.recover()]);
  assert.equal(results[0].revision,results[1].revision);assert.equal(f.store.state.contracts[0].history.filter(h=>h.action==='recover').length,1);
  const directory=await mkdtemp(join(tmpdir(),'dead-drop-recovery-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const args={agent_id:f.ids.alice,...f.args};assert.equal(supportsDurable('recover_contract',args),true);
  await assert.rejects(runDurable({directory,tool:'recover_contract',args,invoke:async()=>{await f.recover();throw new Error('lost response');}}));
  const result=await replayOutbox({directory,agentId:f.ids.alice,invoke:(name,input)=>call(f.boxes.alice,name,input)});
  assert.equal(result.operations[0].status,'delivered');assert.equal(f.store.state.contracts[0].budgetRecovery.additionalVersions,2);
});

test('recovery covers one-version allowance and default recovery ceiling',async()=>{
  for(const [base,extra] of [[3,1],[5,2]]) {
    const f=await recoveryFixture(base);f.grant.additional_versions=extra;f.args.additional_versions=extra;
    let c=await f.recover();assert.equal(c.effectiveMaxVersions,base+extra);
    for(let i=0;i<extra;i++)c=await f.advance('alice',c,'revise',f.terms);
    await assert.rejects(f.advance('alice',c,'revise',f.terms),/budget exhausted/);
    f.tick(3600000);assert.equal((await f.recover()).version,base+extra);
  }
});

test('configurable budgets support longer reviews without expanding exact owner grants',async()=>{
  const f=await recoveryFixture(6,10);
  assert.equal(f.c.maxRecoveryVersions,10);
  await assert.rejects(f.recover({additional_versions:3}),/authorization/);
  f.grant.additional_versions=8;
  let c=await f.recover({additional_versions:8});
  assert.equal(c.effectiveMaxVersions,14);
  for(let i=0;i<8;i++)c=await f.advance('alice',c,'revise',f.terms);
  await assert.rejects(f.advance('alice',c,'revise',f.terms),/budget exhausted/);
  const disabled=await recoveryFixture(1,0);
  await assert.rejects(disabled.recover(),/ceiling/);
  const legacy=await recoveryFixture();
  delete legacy.store.state.contracts[0].maxRecoveryVersions;
  legacy.grant.additional_versions=3;
  await assert.rejects(legacy.recover({additional_versions:3}),/ceiling/);
});

test('budget ceilings validate finite integers and cannot be changed by transitions',async()=>{
  for(const value of [-1,101,1.5,Infinity]) {
    const f=await fixture();await assert.rejects(f.propose({max_recovery_versions:value}),/ceiling|Invalid max_recovery_versions/);
  }
  const f=await fixture();const c=await f.propose({max_versions:100,max_recovery_versions:100});
  assert.equal(c.maxVersions,100);assert.equal(c.maxRecoveryVersions,100);
  await assert.rejects(f.advance('alice',c,'revise',{...f.terms,max_recovery_versions:101}),/Unknown argument/);
});

test('recovery rejects duplicate grants and non-exhausted or agreed contracts',async()=>{
  for(const mutate of [f=>{f.boxes.alice.readRecoveryAuthorizations=async()=>[f.grant,f.grant];},f=>{f.store.state.contracts[0].status='agreed';},f=>{f.store.state.contracts[0].maxVersions=4;}]){
    const f=await recoveryFixture();mutate(f);const before=structuredClone(f.store.state);await assert.rejects(f.recover());assert.deepEqual(f.store.state,before);
  }
});
