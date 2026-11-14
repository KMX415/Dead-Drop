import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { GitHubStore, emptyState } from '../github.mjs';
import { Mailbox } from '../mailbox.mjs';
import { call } from '../tools.mjs';
import { encodeSnapshot, decodeSnapshot, SEGMENT_BYTES, SNAPSHOT_BYTES, segmentPath } from '../segmented-storage.mjs';
import { parseStorageArgs } from '../storage.mjs';

const sha=text=>createHash('sha1').update(text).digest('hex');
const conflict=()=>Object.assign(new Error('Conflict'),{status:409});
class GitFixture {
  constructor(state=emptyState()) {
    this.blobs=new Map();this.trees=new Map();this.commits=new Map();this.calls=[];this.private=true;
    const blob=this.blob(JSON.stringify(state)),tree=this.tree(new Map([['mailbox.json',blob]]));
    this.head=this.commit(tree,[]);this.failBefore=false;this.failAfter=false;
  }
  blob(text){const id=sha(text);this.blobs.set(id,text);return id;}
  tree(files){const id=sha(JSON.stringify([...files]));this.trees.set(id,files);return id;}
  commit(tree,parents){const id=sha(JSON.stringify({tree,parents}));this.commits.set(id,{tree:{sha:tree},parents});return id;}
  files(head=this.head){return this.trees.get(this.commits.get(head).tree.sha);}
  store(){const store=new GitHubStore('fixture/mailbox');store.api=this.api.bind(this);return store;}
  async api(path,method='GET',body) {
    this.calls.push({path,method,body});
    if(path==='user')return {login:'alice'};
    path=path.replace('repos/fixture/mailbox','');
    if(path==='')return {private:this.private,permissions:{push:true}};
    if(path==='/git/ref/heads/dev-agent-mailbox')return {object:{sha:this.head}};
    if(path.startsWith('/contents/')&&method==='GET') {
      const [file,ref]=path.slice(10).split('?ref=');const head=ref==='dev-agent-mailbox'?this.head:ref;
      const id=this.files(head)?.get(file);if(!id)throw Object.assign(new Error('Not found'),{status:404});
      const text=this.blobs.get(id);return {sha:id,size:Buffer.byteLength(text),encoding:'base64',content:Buffer.from(text).toString('base64')};
    }
    if(path==='/contents/mailbox.json'&&method==='PUT') {
      if(body.sha!==this.files().get('mailbox.json'))throw conflict();
      const files=new Map(this.files());files.set('mailbox.json',this.blob(Buffer.from(body.content,'base64').toString()));
      this.head=this.commit(this.tree(files),[this.head]);return {};
    }
    if(path.startsWith('/git/commits/')&&method==='GET')return this.commits.get(path.split('/').at(-1));
    if(path==='/git/blobs'&&method==='POST')return {sha:this.blob(body.content)};
    if(path==='/git/trees'&&method==='POST') {
      const files=new Map(this.trees.get(body.base_tree));
      for(const entry of body.tree)files.set(entry.path,entry.sha??this.blob(entry.content));
      return {sha:this.tree(files)};
    }
    if(path==='/git/commits'&&method==='POST')return {sha:this.commit(body.tree,body.parents)};
    if(path==='/git/refs/heads/dev-agent-mailbox'&&method==='PATCH') {
      assert.equal(body.force,false);
      if(this.failBefore){this.failBefore=false;throw new Error('Connection lost before publication');}
      if(this.commits.get(body.sha).parents[0]!==this.head)throw conflict();
      this.head=body.sha;
      if(this.failAfter){this.failAfter=false;throw new Error('Connection lost after publication');}
      return {};
    }
    throw new Error(`Unexpected ${method} ${path}`);
  }
  async migrate(store=this.store()) {return store.migrateStorage({apply:true,expected_head:this.head,all_clients_upgraded:true});}
}

test('large Unicode records round-trip through bounded hashed segments without discarding history',async()=>{
  const state={...emptyState(),version:2,tasks:[{id:'same-id',revision:800,history:Array.from({length:800},(_,i)=>({revision:i,requestId:'retry-'+i,body:'🔧'.repeat(500)}))}],budget:{max_messages:20,used:19}};
  const {manifest,nodes}=encodeSnapshot(state);
  assert.ok(manifest.bytes>750000);
  for(const text of nodes.values())assert.ok(Buffer.byteLength(text)<=SEGMENT_BYTES);
  assert.deepEqual(await decodeSnapshot(manifest,async id=>nodes.get(id)),state);
  await assert.rejects(decodeSnapshot(manifest,async id=>nodes.get(id)+' '),/integrity/);
  await assert.rejects(decodeSnapshot({...manifest,bytes:manifest.bytes-1},async id=>nodes.get(id)),/size mismatch/);
  assert.throws(()=>encodeSnapshot({x:'x'.repeat(SNAPSHOT_BYTES+1)}),/32 MB/);
});

test('migration is explicit, plan is read-only, and preserves every original record',async()=>{
  const original={...emptyState(),tasks:[{id:'photo',revision:96,history:Array.from({length:96},(_,i)=>({revision:i,summary:'evidence'}))}],contracts:[{id:'c',round:3,maxRounds:3}],archivedWorkerRuns:[{id:'old',requestId:'do-not-repeat'}]};
  const git=new GitFixture(original),store=git.store(),before=git.head;
  const plan=await store.migrateStorage();assert.equal(plan.head,before);assert.equal(git.head,before);
  assert.ok(git.calls.every(c=>c.method==='GET'));
  await assert.rejects(store.migrateStorage({apply:true}),/confirmation/);
  await assert.rejects(store.migrateStorage({apply:true,expected_head:'0'.repeat(40),all_clients_upgraded:true}),/head changed/);
  await git.migrate(store);
  assert.deepEqual((await store.read()).state,{...original,version:2});
  assert.deepEqual(JSON.parse(git.blobs.get(git.files(before).get('mailbox.json'))),original);
  assert.equal((await store.migrateStorage()).alreadyMigrated,true);
});

test('old clients fail closed and stale v1 writes cannot overwrite migration',async()=>{
  const git=new GitFixture(),old=git.store();const stale=await old.read();
  await git.migrate();
  const manifest=JSON.parse(git.blobs.get(git.files().get('mailbox.json')));
  // Exact old transport gate: version must be 1 and arrays must exist.
  assert.notEqual(manifest.version,1);assert.equal(manifest.messages,undefined);
  await assert.rejects(old.write(stale.state,stale.sha),{status:409});
  assert.equal((await git.store().read()).state.version,2);
});

test('atomic publication retains old snapshot on failure and rejects competing writers',async()=>{
  const git=new GitFixture();await git.migrate();
  const a=git.store(),b=git.store(),s1=await a.read(),s2=await b.read(),before=git.head;
  s1.state.messages.push({id:'a'});git.failBefore=true;
  await assert.rejects(a.write(s1.state,s1.sha),/before publication/);
  assert.equal(git.head,before);assert.deepEqual((await b.read()).state.messages,[]);
  await a.write(s1.state,s1.sha);
  s2.state.messages.push({id:'b'});await assert.rejects(b.write(s2.state,s2.sha),{status:409});
  assert.deepEqual((await b.read()).state.messages,[{id:'a'}]);
  assert.deepEqual((await a.segmented.read(before)).state.messages,[]);
});

test('lost publication response followed by identical retry sends exactly once',async()=>{
  const git=new GitFixture(),store=git.store(),box=new Mailbox(store,'alice');
  const agent=(await box.join({label:'a',task:'test'})).id;await git.migrate(store);
  const payload={agent_id:agent,to:agent,body:'hello',kind:'question',request_id:'stable'};
  git.failAfter=true;await assert.rejects(box.send(payload),/after publication/);
  const head=git.head;const sent=await box.send(payload);
  assert.equal(git.head,head);assert.equal((await store.read()).state.messages.length,1);
  assert.equal(sent.requestId,'stable');
  await assert.rejects(box.send({...payload,body:'different'}),/different content/);
});

test('bounded segments grow past legacy cap, reuse unchanged blobs, and cache verified reads',async()=>{
  const git=new GitFixture();await git.migrate();const store=git.store();
  let snapshot=await store.read();snapshot.state.tasks=Array.from({length:120},(_,i)=>({id:'task-'+i,history:[{body:'x'.repeat(8000)}]}));
  await store.write(snapshot.state,snapshot.sha);
  const fresh=git.store();snapshot=await fresh.read();assert.ok(Buffer.byteLength(JSON.stringify(snapshot.state))>750000);
  git.calls=[];await fresh.read();assert.equal(git.calls.filter(c=>c.path.includes('/contents/segments/')).length,0);
  snapshot.state.tasks[0].history.push({body:'new'});git.calls=[];await fresh.write(snapshot.state,snapshot.sha);
  const uploads=git.calls.filter(c=>c.path.endsWith('/git/blobs')).length;
  assert.ok(uploads<encodeSnapshot(snapshot.state).nodes.size);
  assert.ok([...git.files().keys()].some(p=>p.startsWith('segments/')));
  assert.deepEqual((await git.store().read()).state,snapshot.state);
});

test('public repositories and corrupt or missing segments fail closed',async()=>{
  const git=new GitFixture();await git.migrate();const store=git.store();
  git.private=false;await assert.rejects(store.read(),/no longer private/);
  git.private=true;
  const manifest=JSON.parse(git.blobs.get(git.files().get('mailbox.json')));
  const blob=git.files().get(segmentPath(manifest.root));git.blobs.set(blob,'{}');
  await assert.rejects(store.read(),/integrity/);
  git.files().delete(segmentPath(manifest.root));await assert.rejects(store.read(),/Not found/);
});

test('migration CLI never guesses a repository or upgrades restricted connections',()=>{
  assert.throws(()=>parseStorageArgs([]),/explicit --repo/);
  assert.throws(()=>parseStorageArgs(['--repo','a/b','--apply']),/requires/);
  assert.throws(()=>parseStorageArgs(['--repo','a/b','--force']),/Usage/);
  assert.deepEqual(parseStorageArgs(['--repo','a/b']),{repo:'a/b'});
  const result=spawnSync(process.execPath,['storage.mjs','--repo','fixture/mailbox'],{cwd:new URL('..',import.meta.url),env:{...process.env,DEAD_DROP_TOOLS:'check_inbox'},encoding:'utf8'});
  assert.equal(result.status,1);assert.match(result.stderr,/restricted agent connection/);
});

test('simultaneous publications retry against the winning head without losing messages',async()=>{
  const git=new GitFixture(),setup=git.store(),box=new Mailbox(setup,'alice');
  const agent=(await box.join({label:'a',task:'test'})).id;await git.migrate(setup);
  // Hold the first ref update until both writers have built sibling commits.
  const original=git.api.bind(git);let count=0,release;
  const barrier=new Promise(resolve=>{release=resolve;});
  git.api=async(path,method,body)=>{
    if(method==='PATCH' && ++count<=2){if(count===2)release();await barrier;}
    return original(path,method,body);
  };
  const a=new Mailbox(git.store(),'alice'),b=new Mailbox(git.store(),'alice');
  await Promise.all([
    a.send({agent_id:agent,to:agent,body:'first',kind:'question',request_id:'a'}),
    b.send({agent_id:agent,to:agent,body:'second',kind:'question',request_id:'b'}),
  ]);
  const messages=(await git.store().read()).state.messages;
  assert.equal(messages.length,2);assert.deepEqual(messages.map(m=>m.sequence),[1,2]);
  assert.deepEqual(new Set(messages.map(m=>m.requestId)),new Set(['a','b']));
  assert.ok(count>=3);
});

test('interrupted migration can be inspected safely and legacy size bounds remain enforced',async()=>{
  const git=new GitFixture(),store=git.store(),before=git.head;
  const snapshot=await store.read();snapshot.state.padding='x'.repeat(750000);
  await assert.rejects(store.write(snapshot.state,snapshot.sha),/Mailbox full/);
  git.failBefore=true;await assert.rejects(git.migrate(store),/before publication/);
  assert.equal(git.head,before);assert.equal((await store.read()).state.version,1);
  git.failAfter=true;await assert.rejects(git.migrate(store),/after publication/);
  assert.equal((await store.migrateStorage()).alreadyMigrated,true);
  assert.equal((await store.read()).state.version,2);
});

test('task history exceeds 100 only in migrated storage, remains pageable and retry-safe',async()=>{
  const git=new GitFixture(),store=git.store(),box=new Mailbox(store,'alice');
  const agent=(await box.join({label:'a',task:'test'})).id;
  let task=await box.createTask({agent_id:agent,title:'Long task',description:'Synthetic',acceptance:['Evidence'],request_id:'create',assignee_id:agent});
  task=await box.updateTask({agent_id:agent,task_id:task.id,expected_revision:task.revision,request_id:'accept',action:'accept',summary:'Start'});
  const snapshot=await store.read();snapshot.state.tasks[0].history.push(...Array.from({length:99},(_,i)=>({revision:i+3,actorId:agent,requestId:'old-'+i,action:'evidence',summary:'keep'})));snapshot.state.tasks[0].revision=101;
  await store.write(snapshot.state,snapshot.sha);
  const payload={agent_id:agent,task_id:task.id,expected_revision:101,request_id:'beyond-100',action:'evidence',summary:'More evidence'};
  await assert.rejects(box.updateTask(payload),/history full/);
  await git.migrate(store);
  const result=await call(box,'update_task',payload);assert.equal(result.revision,102);assert.equal(result.history.length,30);assert.equal(result.historyPagination.total,101);
  assert.equal((await call(box,'update_task',payload)).revision,102);
  await assert.rejects(call(box,'update_task',{...payload,summary:'Changed'}),/different content/);
  const all=[];let after=0;
  do {const page=await call(box,'get_task',{agent_id:agent,task_id:task.id,history_after:after,history_limit:25});all.push(...page.history);after=page.historyPagination.hasMore?page.historyPagination.nextAfter:null;}while(after!==null);
  assert.equal(all.length,101);assert.equal(all[0].requestId,'accept');assert.equal(all.at(-1).requestId,'beyond-100');
});
