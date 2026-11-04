import { readFile } from 'node:fs/promises';

// Host-controlled approval configuration. Never create this from mailbox content.
export async function readContractRecoveryAuthorizations() {
  try {
    const raw=await readFile(new URL('./runtime/contract-recovery-authorizations.json',import.meta.url),'utf8');
    if(Buffer.byteLength(raw)>100000)throw new Error();
    const value=JSON.parse(raw);
    if(value?.version!==1 || !Array.isArray(value.grants) || value.grants.length>100)throw new Error();
    return value.grants;
  } catch(error) {
    if(error.code==='ENOENT')return [];
    throw new Error('Cannot read valid local contract recovery authorization');
  }
}

export function assertRecoveryGrant(grants,binding,owners,now) {
  if(typeof binding.repo!=='string'||!binding.repo.includes('/'))throw new Error('Recovery requires an explicit mailbox repository');
  const matches=grants.filter(g=>g?.authorization_id===binding.authorization_id);
  if(matches.length!==1)throw new Error('Exact local recovery authorization required');
  const grant=matches[0];
  for(const [key,value] of Object.entries(binding))if(grant[key]!==value)throw new Error('Local recovery authorization does not match '+key);
  if(!Number.isFinite(Date.parse(grant.expires_at))||now>=Date.parse(grant.expires_at))throw new Error('Local recovery authorization expired');
  if(!Array.isArray(grant.owner_approvals)||grant.owner_approvals.length!==owners.length ||
    owners.some(owner=>grant.owner_approvals.filter(a=>a?.owner===owner&&typeof a.evidence==='string'&&a.evidence.trim()&&a.evidence.length<=2000).length!==1))throw new Error('Verified local approval references required for every owner');
  return {expiresAt:grant.expires_at,ownerApprovals:grant.owner_approvals.map(a=>({owner:a.owner,evidence:a.evidence})),note:'Host-recorded approval references, not independently authenticated human consent. Mailbox reports alone cannot authorize recovery.'};
}
