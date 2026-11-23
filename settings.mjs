import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validateRepo, validateWorker } from './config.mjs';
import { validatePolicy } from './coordination.mjs';
import { normalizeAllowedTools } from './tool-access.mjs';
import { tools } from './tools.mjs';

import { workflowDefaults } from './workflow-defaults.mjs';

const runtime = new URL('./runtime/', import.meta.url);

async function localFile(dir, name) {
  let content;
  try { content = await readFile(new URL(name, dir), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error('Cannot read runtime/' + name);
  }
  try {
    const record = JSON.parse(content);
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error();
    return record;
  } catch { throw new Error('Invalid JSON object in runtime/' + name); }
}

export async function inspectSettings(dir = runtime, env = process.env, now = Date.now()) {
  const config = env.AGENT_MAILBOX_REPO ? undefined : await localFile(dir,'config.json');
  const repo = env.AGENT_MAILBOX_REPO || config?.repo;
  if (config || repo !== undefined) validateRepo(repo);
  const worker = await localFile(dir,'mailbox-worker.json');
  if (worker) validateWorker(worker,repo,worker.login);
  const input = await localFile(dir,'autonomy.json');
  let policy = {status:'absent'};
  if (input) {
    if (!repo || !worker) throw new Error('Cannot match runtime/autonomy.json without a configured mailbox and saved worker');
    const validated = validatePolicy(input, repo, worker.login);
    const {version,repo:boundRepo,owner,task_time_extensions,...limits} = validated;
    policy = {status:Date.parse(limits.expires_at) <= now ? 'expired' : 'configured', ...limits,
      task_time_extensions:task_time_extensions?.length ?? 0};
  }
  const workflows = Object.entries(workflowDefaults).flatMap(([tool, defaults]) => {
    const schema = tools.find(t => t.name === tool).inputSchema.properties;
    return Object.entries(defaults).map(([field, defaultValue]) => ({
      tool, field, defaultValue, minimum:schema[field].minimum, maximum:schema[field].maximum,
    }));
  });
  return {repo:repo ?? null,repoSource:env.AGENT_MAILBOX_REPO ? 'AGENT_MAILBOX_REPO' : config ? 'runtime/config.json' : 'unset',
    tools:normalizeAllowedTools(env.DEAD_DROP_TOOLS), policy, workflows};
}

function display(report) {
  const lines = [
    'Mailbox: ' + (report.repo ?? 'not configured') + ' (' + report.repoSource + ')',
    'Tools for this process (DEAD_DROP_TOOLS): ' + (report.tools?.join(', ') ?? 'all'),
    'Worker policy (runtime/autonomy.json, checked against saved local identity):',
    ...Object.entries(report.policy).map(([k,v]) => '  ' + k + ': ' + (Array.isArray(v) ? v.join(', ') : v)),
    'Workflow defaults (set on the named tool when starting the work):',
    ...report.workflows.map(w => '  ' + w.tool + '.' + w.field + ': ' + w.defaultValue +
      (w.minimum !== undefined && w.maximum !== undefined ? ' (' + w.minimum + ' to ' + w.maximum + ')' : '')),
    'Wake frequency: inspect the schedule in each agent host.',
    'Choose settings for your use case: docs/OPERATOR-SETTINGS.md',
  ];
  return lines.join('\n');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.some(a => !['--help','--json'].includes(a))) throw new Error('Usage: node settings.mjs [--json | --help]');
    if (args.includes('--help')) console.log('Usage: node settings.mjs [--json]\nInspect local settings and workflow defaults offline.');
    else {
      const report = await inspectSettings();
      console.log(args.includes('--json') ? JSON.stringify(report,null,2) : display(report));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
