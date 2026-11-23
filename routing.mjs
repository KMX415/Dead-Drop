import { workflowDefaults } from './workflow-defaults.mjs';
import { assertGoalTask, goalReasons } from './goals.mjs';
import { contractTaskReasons } from './contracts.mjs';
import { eligibility, profileView, within } from './coordination.mjs';
import { assertTaskReviewAction } from './review-cycles.mjs';

const text=(v,n,max=4000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw new Error('Invalid '+n);return v.trim();};
export async function routeTask({agent_id,task_id,expected_revision,request_id,summary,next_steps,timeout_minutes=workflowDefaults.route_task.timeout_minutes,max_attempts=workflowDefaults.route_task.max_attempts}) {
  request_id=text(request_id,'request_id',120);summary=text(summary,'summary');
  if(!Array.isArray(next_steps)||!next_steps.length||next_steps.length>30)throw new Error('Routing requires next_steps');
  next_steps=next_steps.map(s=>text(s,'next_steps',500));
  if(!Number.isInteger(expected_revision)||expected_revision<1)throw new Error('Invalid expected_revision');
  if(!Number.isInteger(timeout_minutes)||timeout_minutes<1||timeout_minutes>1440||!Number.isInteger(max_attempts)||max_attempts<1||max_attempts>10)throw new Error('Invalid routing limits');
  const fingerprint=JSON.stringify({action:'route',expected_revision,summary,next_steps,timeout_minutes,max_attempts});
  const policy=await this.readPolicy();
  return this.change(state=>{
    const actor=this.actor(state,agent_id),task=(state.tasks??[]).find(t=>t.id===task_id),now=this.now();
    if(!task)throw new Error('Task not found');
    const old=task.history.find(h=>h.actorId===agent_id&&h.requestId===request_id);
    if(old){if(old.fingerprint!==fingerprint)throw new Error('request_id already used for different content');return {routed:true,task,note:'Previously recorded route; inspect current status before acting.'};}
    if(task.revision!==expected_revision)throw new Error('Task revision changed; read task before routing');
    if(task.negotiationId)throw new Error('Negotiated work is bound to its agreed worker; routing cannot replace that agreement');
    const previous=task.routing;
    if(previous) {
      if(previous.requestedBy!==agent_id)throw new Error('Only routing initiator can retry delivery');
      if(task.status!=='ready'||task.assigneeId!==previous.assigneeId)throw new Error('Cannot reroute accepted or reassigned work');
      if(previous.maxAttempts!==max_attempts||previous.timeoutMinutes!==timeout_minutes)throw new Error('Routing limits cannot change during delivery');
      if(now<previous.acceptBy)return {routed:false,reason:'Waiting for acceptance',retryAt:previous.acceptBy,task};
      if(previous.attempted.length>=max_attempts)return {routed:false,reason:'Routing attempt limit reached; human decision needed',task};
    } else if(!((task.status==='ready'&&task.createdBy===agent_id)||(['in_progress','blocked'].includes(task.status)&&task.assigneeId===agent_id)))throw new Error('Only creator of ready work or assigned active worker can route');
    if(!task.paths?.length)throw new Error('Routing requires declared task paths');
    const decision=eligibility(state,actor,{...task,assigneeId:agent_id,requiredCapabilities:[]},policy,now,{goalExecution:false});
    if(!decision.allowed)throw new Error(decision.reasons.join('; '));
    if(policy&&(task.handoffCount??0)+1>policy.max_handoffs)throw new Error('Handoff count exceeds policy');
    if(state.version!==2 && task.history.length>=100)throw new Error('Task history full');
    // Active review ownership cannot be moved by the delivery mechanism.
    assertTaskReviewAction(state,task,'handoff');
    const attempted=previous?.attempted??[];
    const load=id=>(state.tasks??[]).filter(t=>t.id!==task.id&&t.assigneeId===id&&['ready','in_progress','blocked'].includes(t.status)).length;
    const candidates=Object.values(state.agents).filter(a=>{
      const p=profileView(a,now);
      return contractTaskReasons(state,{...task,assigneeId:a.id},a,now).length===0 && goalReasons(state,{...task,assigneeId:a.id},a,now,{execution:false}).length===0 && a.id!==agent_id&&!attempted.includes(a.id)&&p.availability==='available'&&
        (task.requiredCapabilities??[]).every(c=>p.capabilities.includes(c))&&task.paths.every(path=>p.paths.some(root=>within(path,root)));
    }).sort((a,b)=>load(a.id)-load(b.id)||a.id.localeCompare(b.id));
    if(!candidates.length)return {routed:false,reason:'No available matching worker; retry on a later wake',task};
    const selected=candidates[0];
    assertGoalTask(state,{...task,assigneeId:selected.id},actor,now,'route');
    task.routing={requestedBy:agent_id,assigneeId:selected.id,attempted:[...attempted,selected.id],maxAttempts:max_attempts,timeoutMinutes:timeout_minutes,acceptBy:now+timeout_minutes*60000};
    task.assigneeId=selected.id;task.status='ready';task.handoffCount=(task.handoffCount??0)+1;task.revision++;task.updatedAt=now;actor.seenAt=now;
    task.history.push({revision:task.revision,actorId:agent_id,requestId:request_id,fingerprint,action:'route',summary,artifacts:[],nextSteps:next_steps,assigneeId:selected.id,status:'ready',createdAt:now});
    return {routed:true,task,note:'Recipient must explicitly accept under its own local policy. Availability is self-reported; no model was launched.'};
  });
}
export const routingTools=[{name:'route_task',description:'Select an available worker by task capabilities and path coverage. Route or retry only unaccepted delivery after its deadline, with fixed attempt limits. Never takes over accepted work or launches a worker.',inputSchema:{type:'object',additionalProperties:false,properties:{agent_id:{type:'string'},task_id:{type:'string'},expected_revision:{type:'integer',minimum:1},request_id:{type:'string',maxLength:120},summary:{type:'string',maxLength:4000},next_steps:{type:'array',minItems:1,maxItems:30,items:{type:'string',maxLength:500}},timeout_minutes:{type:'integer',minimum:1,maximum:1440},max_attempts:{type:'integer',minimum:1,maximum:10}},required:['agent_id','task_id','expected_revision','request_id','summary','next_steps']},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}}];
export const routingMethods={route_task:'routeTask'};
