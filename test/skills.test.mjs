import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Mailbox } from '../mailbox.mjs';
import { emptyState } from '../github.mjs';
import { call } from '../tools.mjs';

class Store {
  state=emptyState(); revision=0;
  async read(){return {state:structuredClone(this.state),sha:this.revision};}
  async write(state,sha){
    if(sha!==this.revision)throw Object.assign(new Error('Conflict'),{status:409});
    this.state=structuredClone(state);this.revision++;
  }
}
async function setup(){
  const store=new Store(),alice=new Mailbox(store,'alice'),bob=new Mailbox(store,'bob');
  const a=(await alice.join({label:'Author',task:'Learn'})).id;
  const b=(await bob.join({label:'Reviewer',task:'Verify'})).id;
  const c=(await bob.join({label:'Second reviewer',task:'Verify'})).id;
  const create=(extra={})=>call(alice,'create_skill',{agent_id:a,name:'review-a-handoff',title:'Review a handoff',
    description:'Check: "evidence"\n---\nunsafe: true',when_to_use:'Before a review handoff',
    steps:['Read the diff','Run relevant tests'],validation:['Confirm criteria'],limitations:['No merge permission'],
    tags:['Review','testing'],evidence:['Passing fixture'],request_id:'create',...extra});
  const review=(s,extra={})=>call(bob,'review_skill',{agent_id:b,skill_id:s.id,expected_revision:s.revision,
    request_id:'review-'+s.revision,verdict:'approve',summary:'Verified procedure',evidence:['Independent fixture'],...extra});
  const update=(s,action='publish',extra={})=>call(alice,'update_skill',{agent_id:a,skill_id:s.id,
    expected_revision:s.revision,request_id:action+'-'+s.revision,action,summary:'Recorded decision',...extra});
  const use=(s,extra={})=>call(bob,'record_skill_use',{agent_id:b,skill_id:s.id,request_id:'use',outcome:'success',
    summary:'Applied procedure',evidence:['Result verified'],...extra});
  const get=s=>call(alice,'get_skill',{agent_id:a,skill_id:s.id});
  const published=async()=>update(await review(await create()));
  return {store,alice,bob,a,b,c,create,review,update,use,get,published};
}

test('skills carry independent review, export provenance and outcomes without changing capabilities',async()=>{
  const {store,alice,bob,a,b,create,review,update,use}=await setup();
  await call(bob,'update_agent',{agent_id:b,expected_revision:0,provider:'claude',capabilities:['review']});
  const profile=structuredClone(store.state.agents[b].profile);
  let task=await call(alice,'create_task',{agent_id:a,title:'Learn procedure',description:'Validate fixture',acceptance:['Pass'],request_id:'task'});
  for(const action of ['accept','complete'])task=await call(alice,'update_task',{agent_id:a,task_id:task.id,
    expected_revision:task.revision,request_id:action,action,summary:'Fixture passes'});
  let s=await create({source_task_id:task.id});
  assert.equal(s.status,'draft');assert.deepEqual(s.tags,['review','testing']);
  await assert.rejects(call(alice,'export_skill',{agent_id:a,skill_id:s.id}),/published/);
  s=await update(await review(s));
  const exported=await call(bob,'export_skill',{agent_id:b,skill_id:s.id});
  assert.equal(exported.filename,'SKILL.md');
  assert.equal(exported.sha256,createHash('sha256').update(exported.content).digest('hex'));
  assert.equal(exported.content.split('\n')[2],'description: '+JSON.stringify(s.description));
  assert.equal(exported.skill.sourceTaskId,task.id);assert.ok(exported.content.includes(s.digest));
  s=await use(s,{task_id:task.id});
  assert.equal(s.uses[0].actorId,b);assert.equal(s.uses[0].taskId,task.id);
  assert.deepEqual(store.state.agents[b].profile,profile);
  s=await update(s,'retire');assert.equal(s.status,'retired');
  await assert.rejects(use(s,{request_id:'later'}),/published/);
  await assert.rejects(call(bob,'export_skill',{agent_id:b,skill_id:s.id}),/published/);
  assert.doesNotMatch(JSON.stringify(s),/requestId|fingerprint/);
});

test('skill retries survive later changes while altered payloads and cross-action keys fail',async()=>{
  const {store,create,review,update,use}=await setup();
  const draft=await create(),reviewed=await review(draft),pub=await update(reviewed);
  await use(pub);await update(await use(pub),'retire');
  const before=store.revision;
  for(const result of [await create(),await review(draft),await update(reviewed),await use(pub)])assert.equal(result.status,'retired');
  assert.equal(store.revision,before);
  await assert.rejects(create({title:'Changed'}),/different content/);
  await assert.rejects(review(draft,{summary:'Changed'}),/different content/);
  await assert.rejects(update(reviewed,'publish',{summary:'Changed'}),/different content/);
  await assert.rejects(use(pub,{outcome:'failure'}),/different content/);
  await assert.rejects(use(pub,{request_id:'review-1'}),/different content/);
});

test('CAS preserves concurrent skill writes and rejects stale review and publication revisions',async()=>{
  const {store,b,c,create,review,update,use,get}=await setup();
  const draft=await create();
  const reviews=await Promise.allSettled([review(draft),review(draft,{agent_id:c})]);
  assert.equal(reviews.filter(r=>r.status==='fulfilled').length,1);
  assert.match(reviews.find(r=>r.status==='rejected').reason.message,/revision changed/);
  const reviewed=await get(draft);
  const publishes=await Promise.allSettled([update(reviewed),update(reviewed,'publish',{request_id:'other-publication'})]);
  assert.equal(publishes.filter(r=>r.status==='fulfilled').length,1);
  assert.match(publishes.find(r=>r.status==='rejected').reason.message,/revision changed/);
  const pub=await get(draft);
  await Promise.all([use(pub),use(pub,{agent_id:c,request_id:'other-use',outcome:'failure'})]);
  assert.deepEqual(new Set((await get(pub)).uses.map(u=>u.actorId)),new Set([b,c]));
  await Promise.all([create({name:'second-skill',request_id:'second'}),create({name:'third-skill',request_id:'third'})]);
  assert.equal(store.state.skills.length,3);
});

test('successors preserve immutable originals and start with fresh review and use history',async()=>{
  const {a,bob,b,create,published,update,get}=await setup();
  const original=await published();
  const next=await create({supersedes_id:original.id,steps:['Improved procedure'],request_id:'v2'});
  assert.equal(next.version,2);assert.equal(next.supersedesId,original.id);assert.equal(next.createdBy,a);
  assert.notEqual(next.digest,original.digest);assert.deepEqual(next.reviews,[]);assert.deepEqual(next.uses,[]);
  assert.deepEqual(await get(original),original);
  await assert.rejects(update(next),/independent approval/);
  await assert.rejects(create({request_id:'without-parent'}),/latest skill/);
  await assert.rejects(create({supersedes_id:original.id,request_id:'fork-old'}),/latest skill/);
  await assert.rejects(call(bob,'create_skill',{agent_id:b,name:original.name,title:'Hijack',description:'Bad',
    when_to_use:'Never',steps:['Bad'],validation:['Bad'],evidence:['Bad'],supersedes_id:next.id,request_id:'hijack'}),/creator/);
});

test('ownership, requested changes and lifecycle checks deny unsafe publication',async()=>{
  const {alice,bob,a,b,c,create,review,update,use}=await setup();
  let s=await create();
  await assert.rejects(call(bob,'get_skill',{agent_id:a,skill_id:s.id}),/identity/);
  await assert.rejects(call(alice,'review_skill',{agent_id:a,skill_id:s.id,expected_revision:1,request_id:'self',
    verdict:'approve',summary:'Self',evidence:['Self']}),/another worker/);
  await assert.rejects(call(bob,'update_skill',{agent_id:b,skill_id:s.id,expected_revision:1,request_id:'steal',action:'publish',summary:'Bad'}),/creator/);
  await assert.rejects(use(s),/published/);
  s=await review(s,{verdict:'request_changes'});
  await assert.rejects(review(s),/already reviewed/);
  s=await review(s,{agent_id:c,request_id:'another-review'});
  await assert.rejects(update(s),/requested changes/);
  await assert.rejects(update(s,'retire',{expected_revision:1}),/revision changed/);
  s=await update(s,'retire');
  await assert.rejects(update(s,'publish'),/transition/);
});

test('legacy skill lists, status, tags, search and pagination work without implicit publication',async()=>{
  const {store,alice,a,create,published}=await setup();
  const list=extra=>call(alice,'list_skills',{agent_id:a,...extra});
  assert.equal(store.state.skills,undefined);assert.deepEqual((await list()).skills,[]);
  await published();
  await create({name:'second-skill',request_id:'second'});await create({name:'third-skill',request_id:'third',tags:['other']});
  assert.equal((await list()).skills.length,1);
  const first=await list({status:'draft',limit:1});assert.equal(first.hasMore,true);
  const last=await list({status:'draft',after:first.nextAfter,limit:1});assert.equal(last.hasMore,false);
  assert.notEqual(first.skills[0].id,last.skills[0].id);
  assert.equal((await list({status:'draft',tags:['REVIEW','testing']})).skills.length,1);
  assert.equal((await list({status:'draft',query:'THIRD'})).skills[0].name,'third-skill');
  for(const args of [{limit:0},{after:-1},{limit:101},{status:'unknown'},{query:''}])await assert.rejects(list(args));
});

test('malformed skill inputs, uncompleted evidence tasks and capacity limits fail without pruning',async()=>{
  const {store,alice,a,c,create,review,update,use}=await setup();
  for(const args of [{name:'../escape'},{title:'x'.repeat(201)},{steps:[]},{validation:[]},{evidence:[]},
    {steps:Array(31).fill('step')},{steps:['x'.repeat(1001)]},{description:'\0'},{tags:['bad tag']},
    {request_id:'x'.repeat(121)},{source_task_id:'missing'},{unknown:true}])await assert.rejects(create(args));
  const task=await call(alice,'create_task',{agent_id:a,title:'Incomplete',description:'No evidence yet',acceptance:['Pass'],request_id:'task'});
  await assert.rejects(create({source_task_id:task.id}),/completed task/);
  let s=await create();
  store.state.skills[0].reviews=Array.from({length:30},(_,i)=>({actorId:'old-'+i,verdict:'approve'}));
  await assert.rejects(review(s,{agent_id:c}),/reviews full/);assert.equal(store.state.skills[0].reviews.length,30);
  store.state.skills[0].reviews=[];
  s=await update(await review(s));
  await assert.rejects(use(s,{task_id:task.id}),/completed task/);
  store.state.skills[0].uses=Array.from({length:100},(_,i)=>({actorId:'old-'+i}));
  await assert.rejects(use(s),/history full/);assert.equal(store.state.skills[0].uses.length,100);
  store.state.skills[0].history=Array.from({length:10},(_,i)=>({actorId:'old-'+i}));
  await assert.rejects(update(s,'retire'),/history full/);
  store.state.skills=Array.from({length:100},(_,i)=>({...store.state.skills[0],id:'old-'+i,requestId:'old-'+i}));
  await assert.rejects(create({name:'overflow',request_id:'overflow'}),/registry full/);
  assert.equal(store.state.skills.length,100);
});

test('tampering with reviewed content blocks reads, exports and further mutations',async()=>{
  const {store,alice,a,published,get,use}=await setup();
  const s=await published();store.state.skills[0].steps.push('Unreviewed instruction');
  await assert.rejects(get(s),/digest mismatch/);
  await assert.rejects(call(alice,'list_skills',{agent_id:a}),/digest mismatch/);
  await assert.rejects(call(alice,'export_skill',{agent_id:a,skill_id:s.id}),/digest mismatch/);
  await assert.rejects(use(s),/digest mismatch/);
});

test('headless addressed review exchange leads to reusable skill without reply loops',async()=>{
  const {store,alice,a,create}=await setup();
  // Two distinct workers owned by the same account model one human with multiple agents.
  const reviewer=(await call(alice,'join_team',{label:'Same-account reviewer',task:'Review skill'})).id;
  assert.notEqual(a,reviewer);assert.equal(store.state.agents[a].owner,store.state.agents[reviewer].owner);
  const draft=await create();
  const request=await call(alice,'send_message',{agent_id:a,to:reviewer,kind:'review_request',
    body:JSON.stringify({skill_id:draft.id}),request_id:'skill-review-request'});
  const inbox=await call(alice,'check_inbox',{agent_id:reviewer});
  assert.equal(inbox.messages.length,1);assert.equal(inbox.messages[0].id,request.id);
  const key=JSON.parse(inbox.messages[0].body).skill_id;
  const inspected=await call(alice,'get_skill',{agent_id:reviewer,skill_id:key});
  await call(alice,'review_skill',{agent_id:reviewer,skill_id:key,expected_revision:inspected.revision,
    request_id:'review-exchange',verdict:'approve',summary:'Checked each instruction against fixture',evidence:['Fixture passes']});
  const answer=await call(alice,'send_message',{agent_id:reviewer,to:a,kind:'answer',reply_to:request.id,
    body:JSON.stringify({skill_id:key,result:'Review recorded; read current skill before publication'}),request_id:'skill-review-answer'});
  await call(alice,'acknowledge_message',{agent_id:reviewer,message_id:request.id});
  const authorInbox=await call(alice,'check_inbox',{agent_id:a});
  assert.deepEqual(authorInbox.messages.map(m=>m.id),[answer.id]);
  const current=await call(alice,'get_skill',{agent_id:a,skill_id:key});
  assert.equal(current.reviews[0].actorId,reviewer);
  await call(alice,'update_skill',{agent_id:a,skill_id:key,expected_revision:current.revision,
    request_id:'publish-exchange',action:'publish',summary:'Independent worker approved'});
  await call(alice,'acknowledge_message',{agent_id:a,message_id:answer.id});
  const found=await call(alice,'list_skills',{agent_id:reviewer,tags:['review']});
  assert.equal(found.skills[0].id,key);
  const exported=await call(alice,'export_skill',{agent_id:reviewer,skill_id:found.skills[0].id});
  assert.equal(exported.skill.digest,draft.digest);
  await call(alice,'record_skill_use',{agent_id:reviewer,skill_id:key,request_id:'exchange-use',outcome:'success',
    summary:'Procedure successfully applied to fixture',evidence:['Observed expected fixture result']});
  const final=await call(alice,'get_skill',{agent_id:a,skill_id:key});
  assert.equal(final.status,'published');assert.equal(final.uses.length,1);assert.equal(final.digest,draft.digest);
  assert.deepEqual(store.state.messages.map(m=>m.kind),['review_request','answer']);
  for(const worker of [a,reviewer])assert.deepEqual((await call(alice,'check_inbox',{agent_id:worker})).messages,[]);
});

test('task lessons travel across handoffs and require each worker to adopt before reporting use',async()=>{
  const {alice,bob,a,b,c,create,review,update,use}=await setup();
  const draft=await create();
  const request={agent_id:a,title:'Fresh workspace',description:'Implement endpoint',acceptance:['Contract holds'],
    assignee_id:b,lesson_ids:[draft.id],request_id:'handoff-task'};
  await assert.rejects(call(alice,'create_task',request),/published/);
  const skill=await update(await review(draft));
  let task=await call(alice,'create_task',request);
  const mutate=async(action,extra={})=>{
    task=await call(bob,'update_task',{agent_id:b,task_id:task.id,expected_revision:task.revision,
      action,summary:'Recorded progress',request_id:action+task.revision,...extra});
  };
  await mutate('accept');
  const decision={agent_id:b,task_id:task.id,skill_id:skill.id,digest:skill.digest,expected_revision:task.revision,
    action:'adopt',reason:'Applies to this endpoint',request_id:'choose'};
  await assert.rejects(call(alice,'decide_task_lesson',{...decision,agent_id:a}),/assignee/);
  await assert.rejects(call(bob,'decide_task_lesson',{...decision,digest:'wrong'}),/pin/);
  const adopted=await call(bob,'decide_task_lesson',decision);
  assert.equal(adopted.lessons[0].applicable,true);
  assert.deepEqual(await call(bob,'decide_task_lesson',decision),adopted);
  await assert.rejects(call(bob,'decide_task_lesson',{...decision,reason:'changed'}),/different content/);
  task.revision=adopted.revision;
  await mutate('handoff',{assignee_id:c,next_steps:['Verify in peer workspace']});
  const context=await call(bob,'get_task_lessons',{agent_id:c,task_id:task.id});
  assert.equal(context.lessons[0].decision,'pending');
  const prior=await call(bob,'get_task_lessons',{agent_id:b,task_id:task.id});
  assert.equal(prior.lessons[0].decision,'adopt');
  assert.equal(prior.lessons[0].applicable,false);
  await mutate('accept',{agent_id:c});
  await mutate('complete',{agent_id:c});
  await assert.rejects(use(skill,{agent_id:c,task_id:task.id}),/adoption/);
  const report=await use(skill,{task_id:task.id});
  assert.equal(report.uses[0].taskId,task.id);
  await update(report,'retire');
  assert.equal((await call(bob,'get_task_lessons',{agent_id:b,task_id:task.id})).lessons[0].applicable,false);
  assert.equal((await call(alice,'create_task',request)).id,task.id);
});

test('competing versions need an explicit choice and concurrent decisions cannot overwrite one another',async()=>{
  const {alice,bob,a,b,create,review,update,published}=await setup();
  const first=await published();
  const second=await update(await review(await create({supersedes_id:first.id,request_id:'next-version'})));
  const req={agent_id:a,title:'Check handoff',description:'Inspect both versions',acceptance:['One selected'],assignee_id:b,request_id:'work'};
  await assert.rejects(call(alice,'create_task',{...req,lesson_ids:[first.id,first.id]}),/lesson_ids/);
  let t=await call(alice,'create_task',{...req,lesson_ids:[first.id,second.id]});
  t=await call(bob,'update_task',{agent_id:b,task_id:t.id,action:'accept',expected_revision:t.revision,request_id:'accept',summary:'Ready'});
  const choose=(s,rev,key,action='adopt')=>call(bob,'decide_task_lesson',{agent_id:b,task_id:t.id,
    skill_id:s.id,digest:s.digest,expected_revision:rev,action,reason:'Check compatibility',request_id:key});
  const attempts=await Promise.allSettled([choose(first,t.revision,'first'),choose(second,t.revision,'second')]);
  assert.equal(attempts.filter(v=>v.status==='fulfilled').length,1);
  const current=await call(bob,'get_task_lessons',{agent_id:b,task_id:t.id});
  const selected=current.lessons[0].applicable?first:second, other=selected===first?second:first;
  await assert.rejects(choose(other,current.revision,'conflict'),/Conflicting/);
  const declined=await choose(selected,current.revision,'decline','decline');
  assert.equal((await choose(other,declined.revision,'switch')).lessons.filter(l=>l.applicable).length,1);
});

test('reaffirming a lesson after final approval preserves completion and retry evidence',async()=>{
  const {alice,bob,a,b,published}=await setup(), skill=await published();
  const task=await call(bob,'create_task',{agent_id:b,title:'Final review',description:'Verify result',acceptance:['Reviewed'],assignee_id:b,lesson_ids:[skill.id],request_id:'create'});
  const args={agent_id:b,task_id:task.id};
  const active=await call(bob,'update_task',{...args,action:'accept',expected_revision:1,summary:'Started',request_id:'start'});
  const choice={...args,skill_id:skill.id,digest:skill.digest,action:'adopt',reason:'Matches the work',expected_revision:active.revision,request_id:'first'};
  const adopted=await call(bob,'decide_task_lesson',choice);
  await call(alice,'update_agent',{agent_id:a,expected_revision:0,provider:'test',capabilities:['review']});
  const cycle=await call(bob,'start_review_cycle',{...args,reviewer_id:a,max_rounds:1,expected_task_revision:adopted.revision,request_id:'review',summary:'Ready',artifacts:['tests passed']});
  await call(alice,'advance_review_cycle',{agent_id:a,cycle_id:cycle.id,expected_revision:cycle.revision,expected_task_revision:adopted.revision,action:'approve',summary:'Checked',artifacts:['reviewed diff'],request_id:'approve'});
  const repeat={...choice,expected_revision:adopted.revision,reason:'Rechecked',request_id:'repeat'};
  assert.deepEqual(await call(bob,'decide_task_lesson',repeat),adopted);
  await call(bob,'update_task',{...args,action:'complete',expected_revision:adopted.revision,summary:'Finished',request_id:'finish'});
  assert.equal((await call(bob,'decide_task_lesson',repeat)).lessons[0].applicable,false);
  await assert.rejects(call(bob,'decide_task_lesson',{...repeat,action:'decline'}),/different content/);
});
