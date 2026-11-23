import { configuredRepo, validateRepo } from './config.mjs';
import { spawn } from 'node:child_process';
import { SegmentedStorage, FORMAT, encodeSnapshot } from './segmented-storage.mjs';

export const STORAGE_BRANCH = 'dev-agent-mailbox';
export const STORAGE_FILE = 'mailbox.json';
export const emptyState = () => ({ version: 1, agents: {}, messages: [], claims: [] });

const accessDetails = Object.freeze({
  RELAY_PRIVATE_REQUIRED: 'Development mailbox requires a PRIVATE repository',
  RELAY_USER_REQUIRED: 'Dead Drop requires an authenticated GitHub user identity. This credential cannot access the user endpoint; integration-only cloud credentials are not supported. Use an authorized user session on this host.',
  RELAY_IDENTITY_INVALID: 'GitHub did not return a valid user login. Dead Drop cannot establish worker ownership; check the authenticated user session on this host.',
  RELAY_WRITE_REQUIRED: 'GitHub account needs write access to this private repository. Repository metadata did not confirm write access; check the invitation and credential permissions on this host.',
});
export function accessDiagnostic(error) {
  return Object.hasOwn(accessDetails, error?.code) ? accessDetails[error.code] : null;
}
function accessError(code) {
  return Object.assign(new Error(accessDetails[code]), {code});
}

export function run(command, args, input) {
  return new Promise((resolve, reject) => {
    // No shell interpolation, no token copied out of the user's gh credential store.
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    let out = '', err = '', size = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Command timed out; check connectivity before retrying')); }, 30000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', data => { size += data.length; if (size > 3000000) child.kill(); else out += data; });
    child.stderr.on('data', data => { if (err.length < 4000) err += data; });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && size <= 3000000) resolve(out);
      else {
        const error = new Error(err.trim() || `Command failed (${code})`);
        error.status = Number(err.match(/HTTP (\d{3})/)?.[1]) || 0;
        reject(error);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export class GitHubStore {
  constructor(repo = configuredRepo()) {
    validateRepo(repo);
    this.repo = repo;
    this.segmented = new SegmentedStorage(this, STORAGE_BRANCH, STORAGE_FILE);
  }
  async api(path, method = 'GET', body) {
    const args = ['api', '--hostname', 'github.com', '--method', method, '-H', 'Accept: application/vnd.github+json', path];
    if (body !== undefined) args.push('--input', '-');
    return JSON.parse(await run('gh', args, body === undefined ? undefined : JSON.stringify(body)));
  }
  async verify() {
    const repo = await this.api(`repos/${this.repo}`);
    if (!repo.private) throw accessError('RELAY_PRIVATE_REQUIRED');
    let user;
    try { user = await this.api('user'); }
    catch (error) {
      if (error.status === 403 && /Resource not accessible by integration/i.test(error.message)) {
        throw accessError('RELAY_USER_REQUIRED');
      }
      throw error;
    }
    if (typeof user?.login !== 'string' || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(user.login)) throw accessError('RELAY_IDENTITY_INVALID');
    if (repo.permissions?.push !== true) throw accessError('RELAY_WRITE_REQUIRED');
    return user.login;
  }
  async read() {
    // Check visibility on every read, including writes' read-before-CAS. Never silently
    // continue using the mailbox after someone makes the repository public.
    const repo = await this.api(`repos/${this.repo}`);
    if (!repo.private) throw new Error('Mailbox disabled: repository is no longer private');
    const file = await this.api(`repos/${this.repo}/contents/${STORAGE_FILE}?ref=${STORAGE_BRANCH}`);
    if (file.encoding !== 'base64' || file.size > 750000) throw new Error('Unsupported or oversized mailbox state');
    const state = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    if (state.version === 2) {
      const snapshot = await this.segmented.read();
      validateState(snapshot.state, 2);
      return snapshot;
    }
    if (['decisions','integrationChecks','contracts','reviewCycles','checkpoints','skillImprovements','notificationReceipts','collaborationAgreements','negotiations','handoffs'].some(key => state[key] !== undefined && !Array.isArray(state[key]))) throw new Error('Unsupported mailbox schema');
    if (state.version !== 1 || !state.agents || !Array.isArray(state.messages) || !Array.isArray(state.claims) || (state.tasks !== undefined && !Array.isArray(state.tasks)) || (state.skills !== undefined && !Array.isArray(state.skills))) throw new Error('Unsupported mailbox schema');
    return { state, sha: file.sha };
  }
  async write(state, sha) {
    if (sha?.format === FORMAT || state.version === 2) {
      validateState(state, 2);
      return this.segmented.publish(state, sha);
    }
    const json = JSON.stringify(state);
    if (Buffer.byteLength(json) > 750000) throw new Error('Mailbox full; archive it before adding more data');
    await this.api(`repos/${this.repo}/contents/${STORAGE_FILE}`, 'PUT', {
      message: 'Update development mailbox [skip ci]', branch: STORAGE_BRANCH, sha,
      content: Buffer.from(json).toString('base64'),
    });
  }
  async migrateStorage({expected_head, apply=false, all_clients_upgraded=false}={}) {
    await this.verify();
    const head=await this.segmented.head();
    if(expected_head!==undefined && expected_head!==head)throw new Error('Mailbox head changed; inspect a fresh migration plan');
    const {text}=await this.segmented.readFile(STORAGE_FILE,head);
    const state=JSON.parse(text);
    if(state.version===2) {
      const snapshot=await this.segmented.read(head);validateState(snapshot.state,2);
      return {alreadyMigrated:true,head,format:FORMAT};
    }
    validateState(state,1);
    state.version=2;
    const encoded=encodeSnapshot(state);
    const plan={repo:this.repo,head,from:1,to:2,bytes:encoded.manifest.bytes,segments:encoded.nodes.size,
      warning:'Old clients, including the frozen Hermes plugin, cannot use this mailbox after migration. Preserve this head as the recovery snapshot. No histories or budgets are reset.'};
    if(!apply)return plan;
    if(!all_clients_upgraded || !expected_head)throw new Error('Migration requires expected_head and explicit all_clients_upgraded confirmation');
    return {...plan,...await this.segmented.publish(state,{format:FORMAT,head,reachable:new Set()},{migration:true}),migrated:true,previousHead:head};
  }
  async initialize() {
    await this.verify();
    try { await this.read(); return { created: false }; }
    catch (error) {
      if (error.status !== 404 && error.status !== 409) throw error;
      // GitHub's Git database API cannot create the first reference in an empty
      // repository. Only explicit initialization may seed it through Contents.
      // A 409 alone is not evidence of an empty repository.
      if (error.status === 409) await this.seedEmptyRepository(error);
    }
    const treeInput = {
      tree: [{ path: STORAGE_FILE, mode: '100644', type: 'blob', content: JSON.stringify(emptyState()) }],
    };
    let tree;
    try {tree=await this.api(`repos/${this.repo}/git/trees`,'POST',treeInput);}
    catch(error) {
      // Contents may report a missing ref as 404 even for an empty repository;
      // the first Git database write then reports 409. Use the same guarded
      // bootstrap, retrying this object creation only once.
      if(error.status!==409)throw error;
      await this.seedEmptyRepository(error);
      tree=await this.api(`repos/${this.repo}/git/trees`,'POST',treeInput);
    }
    const commit = await this.api(`repos/${this.repo}/git/commits`, 'POST', {
      message: 'Initialize private development mailbox [skip ci]', tree: tree.sha, parents: [],
    });
    try {
      await this.api(`repos/${this.repo}/git/refs`, 'POST', { ref: `refs/heads/${STORAGE_BRANCH}`, sha: commit.sha });
    } catch (error) {
      // Another setup may have created it. Never overwrite an existing branch.
      if (error.status !== 422) throw error;
      await this.read();
      return { created: false };
    }
    return { created: true };
  }
  async seedEmptyRepository(originalError) {
    const base=`repos/${this.repo}`,repo=await this.api(base);
    if(!repo.private || !repo.permissions?.push || repo.size!==0 ||
       typeof repo.default_branch!=='string' || !repo.default_branch || repo.default_branch===STORAGE_BRANCH) throw originalError;
    const branches=await this.api(base+'/branches?per_page=1');
    const tags=await this.api(base+'/tags?per_page=1');
    if(!Array.isArray(branches)||branches.length||!Array.isArray(tags)||tags.length)throw originalError;
    let empty=false;
    try {await this.api(base+'/commits?per_page=1');}
    catch(error){if(error.status!==409)throw error;empty=true;}
    if(!empty)throw originalError;
    try {
      // No sha means create-only: a concurrent initializer's README is never
      // replaced. Mailbox data remains exclusively on the separate orphan ref.
      await this.api(base+'/contents/README.md','PUT',{
        message:'Initialize private coordination repository [skip ci]',branch:repo.default_branch,
        content:Buffer.from('# Private Dead Drop mailbox\n\nCoordination data lives on the separate dev-agent-mailbox branch. Keep this repository private. Never merge that branch into a code branch.\n').toString('base64')
      });
    }catch(error){
      if(![409,422].includes(error.status))throw error;
      // A raced create is acceptable only if a branch now actually exists.
      const current=await this.api(base+'/branches?per_page=1');
      if(!Array.isArray(current)||current.length===0)throw error;
    }
    // Recheck privacy/access before constructing mailbox objects after a race.
    await this.verify();
  }
}

function validateState(state,version) {
  if(!state || state.version!==version || !state.agents || typeof state.agents!=='object' || Array.isArray(state.agents) ||
     !Array.isArray(state.messages)||!Array.isArray(state.claims) ||
     ['tasks','skills','decisions','integrationChecks','contracts','reviewCycles','checkpoints','skillImprovements','notificationReceipts','collaborationAgreements','negotiations','handoffs']
       .some(key=>state[key]!==undefined&&!Array.isArray(state[key])))throw new Error('Unsupported mailbox schema');
}
