import { skillDigest } from './skills.mjs';

export const lessonIdsSchema = {type:'array', maxItems:8, uniqueItems:true, items:{type:'string',minLength:1,maxLength:150}};

export function lessonIds(value) {
  if (!Array.isArray(value) || value.length > 8 || new Set(value).size !== value.length ||
      value.some(id => typeof id !== 'string' || !id.trim() || id.length > 150)) throw new Error('Invalid lesson_ids');
  return value;
}

function inspected(state, id) {
  const skill = state.skills?.find(s => s.id === id);
  if (!skill || skill.digest !== skillDigest(skill)) throw new Error('Missing or modified lesson');
  return skill;
}

export function pinLessons(state, ids) {
  return ids.map(id => {
    const skill = inspected(state,id);
    if (skill.status !== 'published') throw new Error('Lessons must be published before handoff');
    return {id, version:skill.version, digest:skill.digest};
  });
}

function taskContext(state, task, agentId) {
  return (task.lessons ?? []).map(pin => {
    const skill = inspected(state,pin.id);
    if (skill.digest !== pin.digest || skill.version !== pin.version) throw new Error('Lesson pin changed');
    const decision = task.lessonDecisions?.findLast(d => d.actorId === agentId && d.id === pin.id);
    return {...pin, name:skill.name, title:skill.title, status:skill.status, decision:decision?.action ?? 'pending',
      reason:decision?.reason ?? null, applicable:task.assigneeId === agentId && task.status === 'in_progress' && skill.status === 'published' && decision?.action === 'adopt'};
  });
}

function getTask(state,id) {
  const task = state.tasks?.find(t => t.id === id);
  if (!task) throw new Error('Task not found');
  return task;
}

export async function getTaskLessons({agent_id,task_id}) {
  const {state} = await this.store.read();
  this.actor(state,agent_id);
  const task = getTask(state,task_id);
  return {taskId:task.id,revision:task.revision,lessons:taskContext(state,task,agent_id)};
}

export async function decideTaskLesson({agent_id,task_id,skill_id,digest,action,reason,expected_revision,request_id}) {
  if (!['adopt','decline'].includes(action) || typeof reason !== 'string' || !reason.trim() || reason.length > 1000 ||
      typeof request_id !== 'string' || !request_id.trim() || request_id.length > 120) throw new Error('Invalid lesson decision');
  const fingerprint = JSON.stringify([skill_id,digest,action,reason,expected_revision]);
  return this.change(state => {
    this.actor(state,agent_id);
    const task = getTask(state,task_id);
    const decisions = task.lessonDecisions ??= [];
    const matchesRequest = d => d.actorId === agent_id && d.requestId === request_id;
    const previous = decisions.find(matchesRequest) ?? task.lessonRetryReceipts?.find(matchesRequest);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('request_id already used for different content');
      return {taskId:task.id,revision:task.revision,lessons:taskContext(state,task,agent_id)};
    }
    if (task.revision !== expected_revision) throw new Error('Task revision changed');
    if (task.assigneeId !== agent_id || task.status !== 'in_progress') throw new Error('Only the active assignee can decide');
    const context = taskContext(state,task,agent_id);
    const lesson = context.find(l => l.id === skill_id && l.digest === digest);
    if (!lesson) throw new Error('Lesson does not match task pin');
    if (action === 'adopt') {
      if (lesson.status !== 'published') throw new Error('Lesson retired');
      if (context.some(l => l.id !== skill_id && l.name === lesson.name && l.applicable)) throw new Error('Conflicting lesson already adopted');
    }
    if (lesson.decision === action) {
      const receipts = task.lessonRetryReceipts ??= [];
      if (receipts.length >= 100) throw new Error('Task lesson retry receipts full');
      receipts.push({actorId:agent_id,requestId:request_id,fingerprint});
      return {taskId:task.id,revision:task.revision,lessons:context};
    }
    if (decisions.length >= 100) throw new Error('Task lesson history full');
    const now = this.now();
    decisions.push({id:skill_id,actorId:agent_id,action,reason,requestId:request_id,fingerprint,createdAt:now});
    task.revision++;
    task.updatedAt = now;
    return {taskId:task.id,revision:task.revision,lessons:taskContext(state,task,agent_id)};
  });
}
