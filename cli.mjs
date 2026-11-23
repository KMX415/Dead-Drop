import { validateWorker } from './config.mjs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { GitHubStore } from './github.mjs';
import { Mailbox } from './mailbox.mjs';
import { call, tools } from './tools.mjs';
import { normalizeAllowedTools, assertToolAllowed } from './tool-access.mjs';
import { policyReader } from './coordination.mjs';
import { createHash } from 'node:crypto';
import { runDurable, replayOutbox, supportsDurable } from './outbox.mjs';

export const workerPath=fileURLToPath(new URL('./runtime/mailbox-worker.json',import.meta.url));
export async function worker(store,login,{unattended=false,allowedTools=null,identityPath=workerPath}={}) {
  let saved;
  let exists=false;
  try{saved=JSON.parse(await readFile(identityPath,'utf8'));exists=true;}catch(error){if(error.code!=='ENOENT')throw error;}
  if(exists) {
    validateWorker(saved,store.repo,login);
    return saved;
  }
  if(unattended || allowedTools!==null)throw new Error('Unattended or restricted CLI requires an existing saved worker identity; run authorized setup first');
  const mailbox=new Mailbox(store,login);
  const identity=await mailbox.join({label:login+' development worker',task:'project development coordination'});
  saved={repo:store.repo,login,agentId:identity.id};
  await mkdir(fileURLToPath(new URL('./runtime/',import.meta.url)),{recursive:true});
  await writeFile(identityPath,JSON.stringify(saved,null,2)+'\n',{flag:'wx'});
  return saved;
}
export function parseCliArgs(argv) {
  const [name,...flags]=argv;
  if(!name || !['worker_identity','resume_outbox',...tools.map(t=>t.name)].includes(name))throw new Error('Unknown mailbox tool');
  let unattended=false,inputPath;
  for(let i=0;i<flags.length;i++) {
    if(flags[i]==='--unattended' && !unattended)unattended=true;
    else if(flags[i]==='--input' && inputPath===undefined && flags[i+1] && !flags[i+1].startsWith('--'))inputPath=flags[++i];
    else throw new Error('Usage: node cli.mjs TOOL [--unattended] [--input JSON_FILE]');
  }
  if(inputPath && ['worker_identity','resume_outbox'].includes(name))throw new Error('Local identity/outbox commands do not accept --input');
  if(unattended && name==='join_team')throw new Error('Unattended CLI cannot join_team');
  return {name,unattended,inputPath};
}
export function guardedInvoke(mailbox,{allowedTools=null,unattended=false,agentId}={}) {
  return (name,args)=> {
    assertToolAllowed(name,allowedTools);
    if(unattended && name==='join_team')throw new Error('Unattended CLI cannot join_team');
    if(unattended && args.agent_id!==undefined && args.agent_id!==agentId)throw new Error('Unattended CLI cannot override its saved worker identity');
    return call(mailbox,name,args);
  };
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  try {
    const {name,unattended,inputPath}=parseCliArgs(process.argv.slice(2));
    const allowedTools=normalizeAllowedTools(process.env.DEAD_DROP_TOOLS);
    if(!['worker_identity','resume_outbox'].includes(name))assertToolAllowed(name,allowedTools);
    const args=inputPath?JSON.parse(await readFile(inputPath,'utf8')):{};
    if(!args || typeof args!=='object' || Array.isArray(args))throw new Error('Tool arguments must be an object');
    const store=new GitHubStore(process.env.AGENT_MAILBOX_REPO),login=await store.verify();
    const saved=name==='team_health'&&!unattended?null:await worker(store,login,{unattended,allowedTools}),mailbox=new Mailbox(store,login,Date.now,policyReader(store.repo,login));
    const invoke=guardedInvoke(mailbox,{allowedTools,unattended,agentId:saved?.agentId});
    if(name==='worker_identity')console.log(JSON.stringify(saved));
    else if(name==='resume_outbox') {
      const directory=fileURLToPath(new URL('./runtime/outbox/'+createHash('sha256').update(store.repo).digest('hex')+'/',import.meta.url));
      console.log(JSON.stringify(await replayOutbox({directory,agentId:saved.agentId,invoke}),null,2));
    }
    else {
      if(!['team_status','team_health','join_team','find_agents'].includes(name))args.agent_id??=saved.agentId;
      if(unattended && args.agent_id!==undefined && args.agent_id!==saved.agentId)throw new Error('Unattended CLI cannot override its saved worker identity');
      const directory=fileURLToPath(new URL('./runtime/outbox/'+createHash('sha256').update(store.repo).digest('hex')+'/',import.meta.url));
      const result=supportsDurable(name,args)?await runDurable({directory,tool:name,args,invoke}):await invoke(name,args);
      console.log(JSON.stringify(result,null,2));
    }
  }catch(error){console.error(error.message);process.exitCode=1;}
}
