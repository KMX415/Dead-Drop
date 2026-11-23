import { workflowDefaults } from './workflow-defaults.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { skillDigest } from './skills.mjs';

const note = 'Outcomes are self-reported observations, not a trust score or execution permission. Proposals never edit, retire, install, or execute a skill. The creator must draft a successor, obtain independent review, and publish it.';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function text(value, name, max = 150) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\x00/.test(value)) throw new Error(`Invalid ${name}`);
  return value.trim();
}
function threshold(value) {
  if (!Number.isInteger(value) || value < 2 || value > 20) throw new Error('Invalid failure_threshold');
  return value;
}
function find(state,id) {
  const skill = (state.skills ?? []).find(s => s.id === id);
  if (!skill) throw new Error('Skill not found');
  if (skillDigest(skill) !== skill.digest) throw new Error('Skill content digest mismatch');
  return skill;
}
export function skillObservations(skill) {
  // Repeated reports by one worker for the same task are one observation.
  // Without a task, the stable request key identifies an observation.
  const seen = new Set();
  return skill.uses.filter(use => {
    if (!['success','failure'].includes(use.outcome)) return false;
    const key = JSON.stringify([use.actorId,use.taskId ? 'task' : 'request',use.taskId ?? use.requestId]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
function view(proposal) {
  const {requestId,fingerprint,history,...publicFields} = proposal;
  return {...publicFields,history:history.map(({requestId,fingerprint,...entry}) => entry),note};
}
function descendant(state,skill,original) {
  const seen = new Set(); let cursor = skill;
  while (cursor.supersedesId) {
    if (seen.has(cursor.id)) throw new Error('Skill ancestry cycle');
    seen.add(cursor.id);
    cursor = find(state,cursor.supersedesId);
    if (cursor.createdBy !== original.createdBy || cursor.name !== original.name) return false;
    if (cursor.id === original.id) return true;
  }
  return false;
}

export async function assessSkills({agent_id,skill_id,failure_threshold = workflowDefaults.assess_skills.failure_threshold,after = 0,limit = 30}) {
  threshold(failure_threshold);
  if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid pagination');
  const {state} = await this.store.read(); this.actor(state,agent_id);
  const skills = skill_id === undefined ? (state.skills ?? []).filter(s => s.status === 'published') : [find(state,text(skill_id,'skill_id'))];
  const page = skills.slice(after,after + limit).map(item => {
    const skill = find(state,item.id), outcomes = skillObservations(skill);
    const failures = outcomes.filter(u => u.outcome === 'failure').length;
    const successors = (state.skills ?? []).filter(s => s.status === 'published' && s.createdBy === skill.createdBy && s.name === skill.name && s.version > skill.version)
      .filter(s => descendant(state,find(state,s.id),skill)).sort((a,b) => b.version - a.version);
    const proposal = (state.skillImprovements ?? []).find(p => p.skillId === skill.id);
    return {skillId:skill.id,name:skill.name,version:skill.version,digest:skill.digest,status:skill.status,
      successes:outcomes.filter(u => u.outcome === 'success').length,failures,
      improvementNeeded:skill.status === 'published' && failures >= failure_threshold,
      latestPublishedSuccessor:successors.length ? {skillId:successors[0].id,version:successors[0].version,digest:successors[0].digest} : null,
      proposal:proposal ? view(proposal) : null,warnings:failures >= failure_threshold ? ['Repeated reported failures; inspect evidence and applicability before reuse.'] : []};
  });
  return {skills:page,nextAfter:after + page.length,hasMore:after + page.length < skills.length,note};
}

export async function proposeSkillImprovement({agent_id,skill_id,request_id,failure_threshold = workflowDefaults.assess_skills.failure_threshold}) {
  skill_id = text(skill_id,'skill_id'); request_id = text(request_id,'request_id',120); threshold(failure_threshold);
  const fingerprint = hash({skill_id,failure_threshold}), id = randomUUID();
  return this.change(state => {
    const actor = this.actor(state,agent_id), skill = find(state,skill_id), proposals = state.skillImprovements ?? [];
    const replay = proposals.find(p => p.createdBy === agent_id && p.requestId === request_id);
    if (replay && replay.fingerprint !== fingerprint) throw new Error('request_id already used for different content');
    if (replay) return view(replay);
    // A single proposal per immutable version makes different workers/wakes converge.
    const existing = proposals.find(p => p.skillId === skill_id);
    if (existing) return view(existing);
    if (skill.status !== 'published') throw new Error('Only published skills can receive improvement proposals');
    const failures = skillObservations(skill).filter(u => u.outcome === 'failure');
    if (failures.length < failure_threshold) throw new Error('Insufficient distinct failure reports');
    if (proposals.length >= 100) throw new Error('Skill improvement registry full; archive deliberately');
    const now = this.now();
    const proposal = {id,skillId:skill_id,digest:skill.digest,createdBy:agent_id,status:'proposed',revision:1,
      failureCount:failures.length,failureThreshold:failure_threshold,
      evidence:failures.map(u => ({actorId:u.actorId,taskId:u.taskId,summary:u.summary,evidence:u.evidence,createdAt:u.createdAt})),
      createdAt:now,updatedAt:now,successorId:null,history:[],requestId:request_id,fingerprint};
    (state.skillImprovements ??= []).push(proposal); actor.seenAt = now;
    return view(proposal);
  });
}

export async function resolveSkillImprovement({agent_id,improvement_id,expected_revision,request_id,action,summary,successor_id}) {
  improvement_id = text(improvement_id,'improvement_id'); request_id = text(request_id,'request_id',120); summary = text(summary,'summary',2000);
  if (!Number.isInteger(expected_revision) || expected_revision < 1) throw new Error('Invalid expected_revision');
  if (!['resolve','dismiss'].includes(action)) throw new Error('Invalid improvement action');
  if (action === 'resolve') successor_id = text(successor_id,'successor_id');
  else if (successor_id !== undefined) throw new Error('Dismiss does not accept successor_id');
  const fingerprint = hash({expected_revision,action,summary,successor_id});
  return this.change(state => {
    const actor = this.actor(state,agent_id), proposal = (state.skillImprovements ?? []).find(p => p.id === improvement_id);
    if (!proposal) throw new Error('Skill improvement not found');
    const skill = find(state,proposal.skillId);
    if (skill.createdBy !== agent_id) throw new Error('Only skill creator can resolve or dismiss improvements');
    const replay = proposal.history.find(h => h.actorId === agent_id && h.requestId === request_id);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw new Error('request_id already used for different content');
      return view(proposal);
    }
    if (proposal.revision !== expected_revision) throw new Error('Improvement revision changed; read assessment first');
    if (proposal.status !== 'proposed') throw new Error('Improvement is already closed');
    if (action === 'resolve') {
      const successor = find(state,successor_id);
      if (successor.status !== 'published' || successor.createdBy !== skill.createdBy || successor.name !== skill.name || successor.version <= skill.version || !descendant(state,successor,skill)) throw new Error('Resolution requires a published descendant of this exact skill version');
    }
    const now = this.now();
    proposal.status = action === 'resolve' ? 'resolved' : 'dismissed'; proposal.successorId = successor_id ?? null;
    proposal.revision++; proposal.updatedAt = now; actor.seenAt = now;
    proposal.history.push({actorId:agent_id,action,summary,createdAt:now,requestId:request_id,fingerprint});
    return view(proposal);
  });
}

const string = {type:'string',minLength:1,maxLength:150};
const agent = {agent_id:string};
const failureThreshold = {type:'integer',minimum:2,maximum:20,default:2};
const tool = (name,description,properties,required,readOnlyHint = false) => ({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint,destructiveHint:false,openWorldHint:true}});
export const improvementTools = [
  tool('assess_skills','Inspect distinct self-reported outcomes, durable improvement proposals, and published descendants. This is not a trust ranking. No state changes.',{...agent,skill_id:string,failure_threshold:failureThreshold,after:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100}},['agent_id'],true),
  tool('propose_skill_improvement','Record one durable proposal per published skill version after repeated distinct failures. Does not create corrected instructions or retire the original; creator must draft, independently review, and publish a successor.',{...agent,skill_id:string,request_id:{...string,maxLength:120},failure_threshold:failureThreshold},['agent_id','skill_id','request_id']),
  tool('resolve_skill_improvement','Skill creator closes a proposal with a published descendant version, or dismisses it with a reason. Never retires the original automatically.',{...agent,improvement_id:string,expected_revision:{type:'integer',minimum:1},request_id:{...string,maxLength:120},action:{type:'string',enum:['resolve','dismiss']},summary:{...string,maxLength:2000},successor_id:string},['agent_id','improvement_id','expected_revision','request_id','action','summary']),
];
export const improvementMethods = {assess_skills:'assessSkills',propose_skill_improvement:'proposeSkillImprovement',resolve_skill_improvement:'resolveSkillImprovement'};
