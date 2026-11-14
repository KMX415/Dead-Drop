import { fileURLToPath } from 'node:url';
import { GitHubStore } from './github.mjs';

export function parseStorageArgs(argv) {
  const options={};
  for(let i=0;i<argv.length;i++) {
    const key=argv[i];
    if(key==='--repo' && !options.repo && /^[\w.-]+\/[\w.-]+$/.test(argv[i+1]??''))options.repo=argv[++i];
    else if(key==='--expected-head' && !options.expected_head && /^[a-f0-9]{40}$/.test(argv[i+1]??''))options.expected_head=argv[++i];
    else if(key==='--apply' && !options.apply)options.apply=true;
    else if(key==='--all-clients-upgraded' && !options.all_clients_upgraded)options.all_clients_upgraded=true;
    else throw new Error('Usage: node storage.mjs --repo OWNER/MAILBOX [--apply --expected-head SHA --all-clients-upgraded]');
  }
  if(!options.repo)throw new Error('An explicit --repo is required; migration never uses an implicit mailbox');
  if(options.apply && (!options.expected_head || !options.all_clients_upgraded))throw new Error('Apply requires --expected-head and --all-clients-upgraded');
  return options;
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  try {
    const options=parseStorageArgs(process.argv.slice(2));
    if(process.env.DEAD_DROP_TOOLS!==undefined)throw new Error('Storage migration is not available through a restricted agent connection');
    console.log(JSON.stringify(await new GitHubStore(options.repo).migrateStorage(options),null,2));
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
