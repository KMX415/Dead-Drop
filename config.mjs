import { readFileSync } from 'node:fs';
export const configPath = new URL('./runtime/config.json', import.meta.url);
export function configuredRepo(env = process.env, read = () => readFileSync(configPath, 'utf8')) {
  if (env.AGENT_MAILBOX_REPO) return env.AGENT_MAILBOX_REPO;
  try {
    const config = JSON.parse(read());
    if (typeof config.repo !== 'string' || !config.repo) throw new Error('Missing repo in runtime/config.json');
    return config.repo;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('Choose a private mailbox repository: node setup.mjs --repo OWNER/REPO --initialize');
  }
}

export function validateRepo(repo) {
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split('/').some(part => part === '.' || part === '..')) throw new Error('Repository must be owner/name');
}

export function validateWorker(saved,repo,login) {
  if(!saved || typeof saved!=='object' || Array.isArray(saved) || typeof saved.repo!=='string' || typeof saved.login!=='string' || !saved.login || typeof saved.agentId!=='string' || !saved.agentId.startsWith(login+'/') || !/^[^/]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(saved.agentId))throw new Error('Malformed saved worker identity; inspect setup before continuing');
  if(saved.repo!==repo || saved.login!==login)throw new Error('Worker identity belongs to another repository/account; use a separate checkout');
}
