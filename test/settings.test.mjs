import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectSettings } from '../settings.mjs';

test('offline settings distinguish absence, override, expiry and invalid policy', async t => {
  const path = await mkdtemp(join(tmpdir(),'settings-'));
  t.after(() => rm(path,{force:true,recursive:true}));
  const dir = pathToFileURL(path + sep);
  const save = (name,value) => writeFile(new URL(name,dir),JSON.stringify(value));
  const empty = await inspectSettings(dir,{});
  assert.equal(empty.policy.status,'absent');
  assert.equal(empty.repo,null);
  assert.deepEqual(await readdir(path),[]);
  assert.ok(empty.workflows.every(w => w.minimum <= w.defaultValue && w.defaultValue <= w.maximum));
  const repo='team/mail';
  await assert.rejects(inspectSettings(dir,{AGENT_MAILBOX_REPO:'team/..'}),/Repository/);
  await save('config.json',{repo});
  await save('mailbox-worker.json',{repo,login:'user',agentId:'user/broken'});
  await assert.rejects(inspectSettings(dir,{}),/Malformed saved worker identity/);
  await save('mailbox-worker.json',{repo,login:'user',agentId:'user/12345678-1234-4321-8123-123456789abc'});
  const policy={version:1,repo,owner:'user',allowed_kinds:['review'],allowed_paths:['SRC'],allow_unassigned:false,
    max_handoffs:2,max_active_tasks:1,max_chain_depth:0,max_task_minutes:35,expires_at:'2026-01-02T00:00:00Z'};
  await save('autonomy.json',policy);
  const scoped=await inspectSettings(dir,{DEAD_DROP_TOOLS:'team_status'},Date.parse('2026-01-01'));
  assert.equal(scoped.policy.status,'configured');
  assert.deepEqual(scoped.policy.allowed_paths,['src']);
  assert.deepEqual(scoped.tools,['team_status']);
  assert.equal((await inspectSettings(dir,{},Date.parse('2026-01-03'))).policy.status,'expired');
  await assert.rejects(inspectSettings(dir,{AGENT_MAILBOX_REPO:'team/elsewhere'}),/identity/);
  await save('autonomy.json',{...policy,max_task_minutes:1441});
  await assert.rejects(inspectSettings(dir,{}),/max_task_minutes/);
});
