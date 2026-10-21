import { publishWorkflowJobStateReadbackLocked } from './workflowReceiptPublication.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { JobExecutionRecordSchema, type JobExecutionRecord, type PreparedJobSpecRecord } from '@foreman-code/contracts/job-verification'
import {
  AcceptedWorkflowRunV3Schema,
  AcceptedCurrentNodeResultSchema,
  GraphDigestSchema,
  GraphIdSchema,
  GraphExecutionIdentitySchema,
  NodeResolutionSchema,
  RepeatOccurrenceIdentityV1Schema,
  RepeatExecutionIdentityV1Schema,
  RepeatGraphExecutionIdentityV3Schema,
  RepeatOccurrenceV1Schema,
  RepeatDecisionV1Schema,
  RepeatDecisionMetadataV1Schema,
  WorkflowVersionV3Schema,
  canonicalGraphJson,
  qualifyRepeatGraphExecution,
  validateRepeatGraphFactsV3,
  validateRepeatSuccessorV1,
  type RepeatGraphFactV3,
  type WorkflowVersionV3,
  type RepeatDecisionV1,
} from '@foreman-code/contracts/wave25'
import type { RunOwnership } from '../runs/ownership.js'
import { beforeGraphCommit,type GraphTransactionSql } from '../run-graph/connection.js'
import { currentRunGraphPublication } from '../run-graph/publication.js'
import { canonicalRepeatEffect,canonicalRepeatEffectReceipt } from '../run-graph/repeatPublication.js'
import { requireRepeatCanonicalReceiptBeforeCommit } from '../run-graph/repeatReceipts.js'
import {
  readRepeatAcceptedResultLocked,
  readRepeatExecutionLocked,
  type RepeatEffect,
  type RepeatRepositoryHost,
  type RepeatLockedHooks,
} from '../runs/repeatPostgres.js'
import { inactiveRepeatResolution } from '../runs/repeatNode.js'
import {
  assertRepeatRef,
  assertRepeatBodyComplete,
  blockForNode,
  decideRepeatAdmission,
  finalRepeatExport,
  makeRepeatOccurrence,
  repeatBlock,
  repeatConflict,
  repeatDigest,
  repeatId,
  repeatSlotId,
  repeatSuccessorInput,
  sameRepeatValue,
  type RepeatScope,
  type RepeatNodeRef,
  type RepeatResolution,
  type RepeatEntryInput,
  type RepeatSource,
  type RepeatInputBinding,
  type RepeatNodeInput,
} from '../runs/repeatResolution.js'
import { readAcceptedRepeatRunLocked } from '../runs/repeatStartRead.js'
import { hasWorkflowExecutionCapacityLocked } from '../runs/workflowExecutionBudget.js'
import { visitRepeatNativeAttemptsLocked } from '../runs/repeatNativeAttempts.js'
import { settleRepeatNativeExecutionLocked } from '../interactions/repeatNativeSettlement.js'
import { readRepeatRunStateLocked } from '../run-graph/repeatProjectionRows.js'
import { graphSourceDigest } from '../run-graph/publication.js'
import { readPublicNodeProjection,publicNodeProjectionFacts } from '../run-graph/publicProjection.js'
import { WorkflowJobPreparationSchema,type WorkflowJobPreparation } from './workflowPreparation.js'
import type { WorkflowJobNodeStore } from './workflowNode.js'
import type { WorkflowJobAdmission,WorkflowJobLockedPort } from './workflowRuntimePorts.js'
import { workflowJobIdentity,workflowJobResult,workflowJobRepeatDecision } from './workflowResult.js'
import { readWorkflowJobSourceLocked } from './workflowSource.js'

const Source=z.object({relationshipId:GraphIdSchema,execution:GraphExecutionIdentitySchema,occurrence:RepeatOccurrenceIdentityV1Schema.nullable(),acceptedResultDigest:GraphDigestSchema,acceptedResult:AcceptedCurrentNodeResultSchema}).strict()
const Entry=z.object({runInput:z.unknown(),external:z.array(Source).max(8000),carry:z.object({decisionId:GraphIdSchema,execution:RepeatExecutionIdentityV1Schema,acceptedResultDigest:GraphDigestSchema,acceptedResult:AcceptedCurrentNodeResultSchema}).strict().nullable()}).strict()
const Resolution=z.object({ref:z.object({nodeId:GraphIdSchema,occurrence:RepeatOccurrenceIdentityV1Schema.nullable()}).strict(),value:NodeResolutionSchema,deferredRelationshipIds:z.array(GraphIdSchema).max(8000)}).strict()
type Occurrence={occurrence:z.infer<typeof RepeatOccurrenceV1Schema>;input:RepeatEntryInput}
type Context={sql:GraphTransactionSql;scope:RepeatScope;version:WorkflowVersionV3;hooks:RepeatLockedHooks;now:string;fence:{ownerId:string;fence:string}}
export interface WorkflowJobStorePublication {
  effect(sql:GraphTransactionSql,owner:RunOwnership,scope:RepeatScope,version:WorkflowVersionV3,effect:RepeatEffect,mutate:()=>Promise<void>,facts:()=>Promise<readonly RepeatGraphFactV3[]>):Promise<void>
  assertReceipt(sql:GraphTransactionSql,scope:RepeatScope,effect:RepeatEffect):Promise<void>
  observe(sql:GraphTransactionSql,scope:RepeatScope,execution:JobExecutionRecord):Promise<void>
}
/** Effects reuse the existing Run head, canonical receipts and repeat ledger. */
export function workflowJobStorePublication():WorkflowJobStorePublication {
  return {
    async effect(sql,owner,scope,version,effect,mutate,facts){
      const publication=currentRunGraphPublication(sql,scope)
      const receipt=canonicalRepeatEffectReceipt(scope,effect)
      const result=await publication.repeatChange({evidence:receipt.evidence,sourceDigest:receipt.sourceDigest,effect:canonicalRepeatEffect(scope,effect)},owner,mutate,async()=>{
        const values=[...await facts()];if(!values.length)values.push({type:'repeat.run.state',state:await readRepeatRunStateLocked(sql,scope)});validateRepeatGraphFactsV3(version,scope,values);return values
      })
      const nodeFacts=publicNodeProjectionFacts(await readPublicNodeProjection(sql,scope,version.definition.nodes.filter(node=>node.kind==='job').map(node=>node.id)))
      if(nodeFacts.length)await publication.source({evidence:{sourceKind:'input_binding',sourceId:repeatId('job-public-effect',effect.kind,effect.entityId,effect.digest),sourceRevision:'1'},sourceDigest:graphSourceDigest(nodeFacts),facts:nodeFacts},async()=>undefined)
      requireRepeatCanonicalReceiptBeforeCommit(sql,canonicalRepeatEffectReceipt(scope,effect,result.semanticDigest))
    },
    async assertReceipt(sql,scope,effect){requireRepeatCanonicalReceiptBeforeCommit(sql,canonicalRepeatEffectReceipt(scope,effect))},
    observe:publishWorkflowJobStateReadbackLocked,
  }
}
/** One adapter per existing Run owner; preparation performs no native/source I/O. */
export class PostgresWorkflowJobNodeStore implements WorkflowJobNodeStore {
  private readonly version:WorkflowVersionV3
  constructor(private readonly owner:RunOwnership,version:WorkflowVersionV3,private readonly host:RepeatRepositoryHost,private readonly jobs:WorkflowJobLockedPort,private readonly publication:WorkflowJobStorePublication){this.version=WorkflowVersionV3Schema.parse(version)}
  private async transaction<T>(work:(context:Context)=>Promise<T>):Promise<T>{
    return this.owner.oneShotConnection().transaction(async sql=>{
      this.owner.assertOwned()
      const row=(await sql.query<{run:unknown;version:unknown;stopped:boolean;cleanup:boolean;state:string;now:string}>(`select r.record as run,v.record as version,r.stop_requested_at is not null as stopped,r.execution_state as state,exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) as cleanup,transaction_timestamp()::text as now from runs r join workflow_versions v on v.id=r.workflow_version_id where r.id=$1 for update of r`,[this.owner.runId])).rows[0]
      if(!row)repeatConflict('RUN_NOT_FOUND')
      const version=WorkflowVersionV3Schema.parse(row.version),run=AcceptedWorkflowRunV3Schema.parse(row.run)
      if(!sameRepeatValue(version,this.version)||run.workflowVersionId!==version.id||run.workspaceId!==version.workspaceId||run.workflowId!==version.workflowId||run.id!==this.owner.runId||row.state!==run.executionState||!sameRepeatValue(run.agentConfigurationVersionIds,version.agentConfigurationVersionIds))repeatConflict('RUN_PIN_CONFLICT')
      if(row.stopped||row.cleanup)repeatConflict('GRAPH_STOP_CONFLICT')
      if(['completed','interrupted'].includes(row.state))repeatConflict('GRAPH_TERMINAL_CONFLICT')
      const scope:RepeatScope={runId:run.id,workspaceId:run.workspaceId,workflowId:run.workflowId,workflowVersionId:version.id,executionSemanticsVersion:3}
      const hooks=await this.host.openLocked(sql,scope,row.run,version),fence=await this.owner.readOneShotFence(sql)
      await hooks.assertAuthorityLocked(sql)
      beforeGraphCommit(sql,async()=>{this.owner.assertOwned();await hooks.assertAuthorityLocked(sql);if(!sameRepeatValue(fence,await this.owner.readOneShotFence(sql)))repeatConflict('RUN_OWNERSHIP_LOST')})
      return work({sql,scope,version,hooks,now:new Date(row.now).toISOString(),fence})
    })
  }
  private node(context:Context,ref:RepeatNodeRef){assertRepeatRef(context.version,context.scope,ref);const node=context.version.definition.nodes.find(node=>node.id===ref.nodeId);if(node?.kind!=='job')return repeatConflict('JOB_WORKFLOW_PIN_CONFLICT');if(context.version.definition.handoffs)repeatConflict('JOB_HANDOFF_POLICY_UNSUPPORTED');return node}
  private async effect(context:Context,kind:RepeatEffect['kind'],entityId:string,value:unknown,mutate:()=>Promise<void>,facts:()=>Promise<readonly RepeatGraphFactV3[]>){
    const effect={kind,entityId,digest:repeatDigest(value)},prior=(await context.sql.query<{payload_digest:string}>('select payload_digest from run_repeat_effects where run_id=$1 and effect_kind=$2 and entity_id=$3',[context.scope.runId,kind,entityId])).rows[0]
    if(prior){if(prior.payload_digest!==effect.digest)repeatConflict('REPEAT_EFFECT_CONFLICT');await this.publication.assertReceipt(context.sql,context.scope,effect);return}
    let count=0
    await this.publication.effect(context.sql,this.owner,context.scope,context.version,effect,async()=>{if(++count!==1)repeatConflict('REPEAT_PUBLICATION_CONFLICT');await mutate();await context.sql.query('insert into run_repeat_effects(run_id,effect_kind,entity_id,payload_digest,owner_id,owner_fence) values($1,$2,$3,$4,$5,$6)',[context.scope.runId,kind,entityId,effect.digest,context.fence.ownerId,context.fence.fence])},facts)
    if(count!==1)repeatConflict('REPEAT_PUBLICATION_CONFLICT')
    await this.publication.assertReceipt(context.sql,context.scope,effect)
  }
  private async recorded(context:Context,kind:RepeatEffect['kind'],id:string){const row=(await context.sql.query<{payload_digest:string}>('select payload_digest from run_repeat_effects where run_id=$1 and effect_kind=$2 and entity_id=$3',[context.scope.runId,kind,id])).rows[0];if(!row)repeatConflict('REPEAT_EFFECT_MISSING');await this.publication.assertReceipt(context.sql,context.scope,{kind,entityId:id,digest:GraphDigestSchema.parse(row.payload_digest)})}
  private async resolutions(context:Context,occurrenceId:string|null){const rows=await context.sql.query<{record:unknown}>('select record from run_repeat_resolutions where run_id=$1 and occurrence_key=$2 order by workflow_node_id limit 1001',[context.scope.runId,occurrenceId??'']);if(rows.rows.length>1000)repeatConflict('REPEAT_RESOLUTION_BOUND_EXCEEDED');const result=new Map<string,RepeatResolution>();for(const row of rows.rows){const value=Resolution.parse(row.record);assertRepeatRef(context.version,context.scope,value.ref);if(value.ref.nodeId!==value.value.workflowNodeId||result.has(value.ref.nodeId)||occurrenceId&&value.ref.occurrence?.occurrenceId!==occurrenceId)repeatConflict('REPEAT_RESOLUTION_CONFLICT');result.set(value.ref.nodeId,value)}return result}
  private async putResolution(context:Context,value:RepeatResolution,outside=false){await context.sql.query('insert into run_repeat_resolutions(run_id,occurrence_key,workflow_node_id,source_occurrence_id,execution_id,record) values($1,$2,$3,$4,$5,$6::jsonb)',[context.scope.runId,outside?'':value.ref.occurrence?.occurrenceId??'',value.ref.nodeId,value.ref.occurrence?.occurrenceId??null,value.value.execution?.executionId??null,JSON.stringify(value)])}
  private async occurrence(context:Context,ref:RepeatNodeRef):Promise<Occurrence|null>{
    if(!ref.occurrence)return null
    const row=(await context.sql.query<{record:unknown;input_json:string;input_digest:string}>('select record,input_json,input_digest from run_repeat_occurrences where occurrence_id=$1 and run_id=$2',[ref.occurrence.occurrenceId,context.scope.runId])).rows[0]
    if(!row)repeatConflict('REPEAT_OCCURRENCE_NOT_FOUND')
    const occurrence=RepeatOccurrenceV1Schema.parse(row.record),input=Entry.parse(JSON.parse(row.input_json)) as RepeatEntryInput
    if(!sameRepeatValue(occurrence.identity,ref.occurrence)||!sameRepeatValue(occurrence.identity.scope,context.scope)||row.input_digest!==repeatDigest(input,4*1024*1024)||occurrence.input.inputDigest!==row.input_digest)repeatConflict('REPEAT_INPUT_DIGEST_CONFLICT')
    if(!occurrence.input.previous)await this.recorded(context,'occurrence.create',occurrence.identity.occurrenceId)
    else{const previous=(await context.sql.query<{record:unknown}>('select record from run_repeat_decisions where occurrence_id=$1',[occurrence.input.previous.occurrenceId])).rows[0];if(!previous)repeatConflict('REPEAT_DECISION_MISSING');const decision=RepeatDecisionV1Schema.parse(previous.record);if(decision.reason!=='repeat'||decision.decisionId!==occurrence.input.previous.decisionId||decision.acceptedResultDigest!==occurrence.input.previous.acceptedResultDigest)repeatConflict('REPEAT_ANCESTRY_CONFLICT');await this.recorded(context,'terminal.accept',decision.exitExecution.executionId)}
    return {occurrence,input}
  }
  private async acceptedSource(context:Context,resolution:RepeatResolution,relationshipId:string):Promise<RepeatSource>{
    const identity=resolution.value.execution
    if(!identity||resolution.value.resolution!=='succeeded'||!resolution.value.acceptedResultDigest)repeatConflict('REPEAT_INPUT_NOT_ACCEPTED')
    if(identity.kind==='job'){
      const job=await this.jobs.read(context.sql,identity.executionId);this.assertExecution(context,resolution.ref,job)
      await this.jobs.verifyResult(context.sql,job)
      return readWorkflowJobSourceLocked(context.sql, context.scope, context.version, resolution, relationshipId)
    }
    const result=await readRepeatAcceptedResultLocked(context.sql,await readAcceptedRepeatRunLocked(context.sql,context.scope.runId),identity.executionId)
    const acceptedResult=AcceptedCurrentNodeResultSchema.parse(result)
    if(acceptedResult.outcome!=='succeeded'||repeatDigest(acceptedResult,64*1024)!==resolution.value.acceptedResultDigest)repeatConflict('REPEAT_INPUT_NOT_ACCEPTED')
    await this.recorded(context,'terminal.accept',identity.executionId)
    return {relationshipId,execution:identity,occurrence:resolution.ref.occurrence,acceptedResultDigest:resolution.value.acceptedResultDigest,acceptedResult}
  }
  private bind(context:Context,ref:RepeatNodeRef,occurrence:Occurrence|null,executionId:string,sources:RepeatSource[]){
    const node=this.node(context,ref),identity={kind:'job' as const,workflowNodeId:node.id,executionId,jobDefinitionId:node.jobDefinitionId,jobDefinitionVersionId:node.jobDefinitionVersionId,attempt:1}
    const predecessors=[...sources].sort((a,b)=>a.relationshipId<b.relationshipId?-1:a.relationshipId>b.relationshipId?1:0)
    if(new Set(predecessors.map(value=>value.relationshipId)).size!==predecessors.length)repeatConflict('REPEAT_INPUT_DUPLICATE')
    for(const source of predecessors){const edge=context.version.definition.edges.find(edge=>edge.id===source.relationshipId);if(!edge||edge.kind!=='execution'||edge.source!==source.execution.workflowNodeId||edge.target!==ref.nodeId||ref.occurrence&&!sameRepeatValue(source.occurrence,ref.occurrence))repeatConflict('REPEAT_BINDING_CONFLICT')}
    const entry=occurrence&&repeatBlock(context.version,occurrence.occurrence.identity.blockId).entryNodeId===ref.nodeId?occurrence.input:null
    const input=JSON.parse(canonicalGraphJson({executionSemanticsVersion:3,runInput:occurrence?.input.runInput??context.hooks.run.input,occurrence:occurrence?.occurrence??null,entry,predecessors},4*1024*1024)) as RepeatNodeInput
    const digest=repeatDigest(input,4*1024*1024),values:Array<{source:RepeatInputBinding['source'];kind:RepeatInputBinding['kind']}>=predecessors.map(source=>({source,kind:'predecessor'}))
    if(entry){values.push(...entry.external.map(source=>({source,kind:'external' as const})));if(entry.carry)values.push({source:entry.carry,kind:'carry'})}
    const bindings:RepeatInputBinding[]=values.map(({source,kind},ordinal)=>({bindingId:repeatId('repeat-binding',executionId,kind,ordinal),recipient:identity,recipientOccurrence:ref.occurrence,inputDigest:digest,source,kind,ordinal}))
    return {input,digest,bindings}
  }
  private assertExecution(context:Context,ref:RepeatNodeRef,execution:JobExecutionRecord,preparation?:WorkflowJobPreparation){
    const node=this.node(context,ref)
    if(execution.workspaceId!==context.scope.workspaceId||execution.workflow?.runId!==context.scope.runId||execution.workflow.workflowId!==context.scope.workflowId||execution.workflow.nodeId!==ref.nodeId||execution.acceptedSpec.definitionId!==node.jobDefinitionId||execution.acceptedSpec.definitionRevision!==node.jobDefinitionRevision||execution.acceptedSpec.definitionVersionId!==node.jobDefinitionVersionId)repeatConflict('JOB_WORKFLOW_PIN_CONFLICT')
    if(preparation&&(execution.id!==preparation.executionId||execution.attemptId!==preparation.attemptId||execution.operationId!==preparation.operationId||!sameRepeatValue(execution.acceptedSpec.workflowInput,preparation.input)))repeatConflict('JOB_PREPARATION_PIN_CONFLICT')
  }
  private async slot(context:Context,ref:RepeatNodeRef,executionId:string){const row=(await context.sql.query<{execution_id:string;identity:unknown;input_digest:string;input_json:string}>(`select x.execution_id,x.identity,s.input_digest,s.input_json from run_repeat_executions x join run_repeat_slots s on s.slot_id=x.slot_id where x.run_id=$1 and x.slot_id=$2 order by x.technical_attempt desc limit 1`,[context.scope.runId,repeatSlotId(context.scope.runId,ref)])).rows[0];if(!row||row.execution_id!==executionId||row.input_digest!==repeatDigest(JSON.parse(row.input_json),4*1024*1024))repeatConflict('JOB_WORKFLOW_PIN_CONFLICT');const identity=ref.occurrence?RepeatGraphExecutionIdentityV3Schema.parse(row.identity):GraphExecutionIdentitySchema.parse(row.identity);if(ref.occurrence&&(!('occurrence' in identity)||!sameRepeatValue(identity.occurrence,ref.occurrence)))repeatConflict('REPEAT_OCCURRENCE_CONFLICT');if(identity.kind!=='job'||identity.workflowNodeId!==ref.nodeId||identity.executionId!==executionId)repeatConflict('JOB_WORKFLOW_PIN_CONFLICT');return row}
  async prepareJob(ref:RepeatNodeRef):Promise<WorkflowJobAdmission>{return this.transaction(async context=>{
    const node=this.node(context,ref);const occurrence=await this.occurrence(context,ref),resolutions=await this.resolutions(context,ref.occurrence?.occurrenceId??null),admission=decideRepeatAdmission(context.version,ref,resolutions)
    if(admission.kind==='resolved'){const resolution=resolutions.get(ref.nodeId)!;await this.recorded(context,resolution.value.execution?'terminal.accept':'node.inactive',resolution.value.execution?.executionId??repeatSlotId(context.scope.runId,ref));return {kind:'resolved',resolution}}
    if(admission.kind==='waiting')return {kind:'waiting'}
    if(admission.kind==='skipped'||admission.kind==='excluded'){const resolution=inactiveRepeatResolution(context.version,ref,admission.kind,context.now);await this.effect(context,'node.inactive',repeatSlotId(context.scope.runId,ref),resolution,()=>this.putResolution(context,resolution),async()=>[{type:'repeat.node.resolved',resolution:{...resolution,outside:ref.occurrence===null}}]);return {kind:'resolved',resolution}}
    if(admission.kind!=='run')repeatConflict('REPEAT_ENTRY_UNRESOLVED')
    const slotId=repeatSlotId(context.scope.runId,ref),existing=(await context.sql.query<{preparation:unknown;bindings:unknown}>('select preparation,bindings from workflow_job_preparations where slot_id=$1 and run_id=$2',[slotId,context.scope.runId])).rows[0]
    if(existing){const preparation=WorkflowJobPreparationSchema.parse(existing.preparation);if(preparation.nodeId!==ref.nodeId||preparation.runId!==context.scope.runId||preparation.workflowVersionId!==context.version.id||preparation.inputDigest!==repeatDigest(preparation.input,4*1024*1024))repeatConflict('JOB_PREPARATION_PIN_CONFLICT');await this.recorded(context,'input.bind',repeatId('job-preparation',preparation.executionId));const row=(await context.sql.query<{execution_id:string}>('select execution_id from run_repeat_executions where slot_id=$1 order by technical_attempt desc limit 1',[slotId])).rows[0];if(row){await this.slot(context,ref,row.execution_id);const execution=await this.jobs.read(context.sql,row.execution_id);this.assertExecution(context,ref,execution,preparation);await this.recorded(context,'input.bind',execution.id);return {kind:'admitted',execution}}return {kind:'preparation',preparation,ref}}
    if(occurrence&&(await context.sql.query('select 1 from run_repeat_decisions where occurrence_id=$1',[occurrence.occurrence.identity.occurrenceId])).rows.length)repeatConflict('REPEAT_OCCURRENCE_CLOSED')
    if (!await hasWorkflowExecutionCapacityLocked(context.sql, context.scope.runId, context.version)) {
      repeatConflict('WORKFLOW_EXECUTION_BUDGET_EXHAUSTED')
    }
    const id=randomUUID(),sources:RepeatSource[]=[];for(const edge of admission.selected)sources.push(await this.acceptedSource(context,resolutions.get(edge.source)!,edge.id))
    const bound=this.bind(context,ref,occurrence,id,sources),preparation=WorkflowJobPreparationSchema.parse({executionId:id,attemptId:randomUUID(),operationId:randomUUID(),workspaceId:context.scope.workspaceId,workflowId:context.scope.workflowId,workflowVersionId:context.scope.workflowVersionId,runId:context.scope.runId,nodeId:ref.nodeId,input:bound.input,inputDigest:bound.digest})
    await this.effect(context,'input.bind',repeatId('job-preparation',id),{preparation,bindings:bound.bindings},async()=>{
      await context.sql.query('insert into run_repeat_slots(slot_id,run_id,occurrence_id,workflow_node_id,input_json,input_digest) values($1,$2,$3,$4,$5,$6)',[slotId,context.scope.runId,ref.occurrence?.occurrenceId??null,ref.nodeId,canonicalGraphJson(bound.input,4*1024*1024),bound.digest])
      await context.sql.query('insert into workflow_job_preparations(slot_id,run_id,preparation,bindings) values($1,$2,$3::jsonb,$4::jsonb)',[slotId,context.scope.runId,JSON.stringify(preparation),JSON.stringify(bound.bindings)])
    },async()=>[{type:'repeat.execution',execution:{
      identity:qualifyRepeatGraphExecution({kind:'job',workflowNodeId:node.id,executionId:id,
        jobDefinitionId:node.jobDefinitionId,jobDefinitionVersionId:node.jobDefinitionVersionId,attempt:1},ref.occurrence),
      inputDigest:bound.digest,previousExecutionId:null,state:'starting',resultOutcome:null,
    }}])
    return {kind:'preparation',preparation,ref}
  })}
  async admitPreparedJob(ref:RepeatNodeRef,preparation:WorkflowJobPreparation,spec:PreparedJobSpecRecord):Promise<JobExecutionRecord>{return this.transaction(async context=>{
    const node=this.node(context,ref);await this.occurrence(context,ref);const slotId=repeatSlotId(context.scope.runId,ref)
    const stored=(await context.sql.query<{preparation:unknown;bindings:unknown}>('select preparation,bindings from workflow_job_preparations where slot_id=$1 and run_id=$2',[slotId,context.scope.runId])).rows[0]
    if(!stored||!sameRepeatValue(stored.preparation,preparation)||preparation.inputDigest!==repeatDigest(preparation.input,4*1024*1024))repeatConflict('JOB_PREPARATION_PIN_CONFLICT')
    await this.recorded(context,'input.bind',repeatId('job-preparation',preparation.executionId))
    const prior=(await context.sql.query<{execution_id:string}>('select execution_id from run_repeat_executions where slot_id=$1 order by technical_attempt desc limit 1',[slotId])).rows[0]
    if(prior){await this.slot(context,ref,prior.execution_id);const value=await this.jobs.read(context.sql,prior.execution_id);this.assertExecution(context,ref,value,preparation);await this.recorded(context,'input.bind',value.id);return value}
    let execution:JobExecutionRecord|undefined
    const bare={kind:'job' as const,workflowNodeId:node.id,executionId:preparation.executionId,jobDefinitionId:node.jobDefinitionId,jobDefinitionVersionId:node.jobDefinitionVersionId,attempt:1}
    const bindings=z.array(z.object({bindingId:GraphIdSchema,recipient:GraphExecutionIdentitySchema,recipientOccurrence:RepeatOccurrenceIdentityV1Schema.nullable(),inputDigest:GraphDigestSchema,source:z.union([Source,Entry.shape.carry.unwrap()]),kind:z.enum(['predecessor','external','carry']),ordinal:z.number().int().nonnegative()}).strict()).parse(stored.bindings)
    await this.effect(context,'input.bind',preparation.executionId,{ref,identity:bare,inputDigest:preparation.inputDigest,spec},async()=>{
      execution=JobExecutionRecordSchema.parse(await this.jobs.admitPrepared(context.sql,ref,preparation,spec));this.assertExecution(context,ref,execution,preparation)
      await context.sql.query('insert into run_repeat_executions(execution_id,run_id,slot_id,occurrence_id,technical_attempt,previous_execution_id,identity) values($1,$2,$3,$4,1,null,$5::jsonb)',[execution.id,context.scope.runId,slotId,ref.occurrence?.occurrenceId??null,JSON.stringify(ref.occurrence?workflowJobIdentity(execution,node,ref.occurrence):bare)])
      for(const binding of bindings){if(!sameRepeatValue(binding.recipient,bare)||binding.inputDigest!==preparation.inputDigest||!sameRepeatValue(binding.recipientOccurrence,ref.occurrence))repeatConflict('JOB_PREPARATION_PIN_CONFLICT');await context.sql.query('insert into run_repeat_bindings(binding_id,run_id,recipient_execution_id,source_execution_id,source_result_digest,input_digest,slot_id,ordinal,record) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',[binding.bindingId,context.scope.runId,execution.id,binding.source.execution.executionId,binding.source.acceptedResultDigest,binding.inputDigest,slotId,binding.ordinal,JSON.stringify(binding)])}
    },async()=>[{type:'repeat.execution',execution:{identity:qualifyRepeatGraphExecution(bare,ref.occurrence),inputDigest:preparation.inputDigest,previousExecutionId:null,state:'queued',resultOutcome:null}},...bindings.map(binding=>({type:'repeat.input.bound' as const,binding:{bindingId:binding.bindingId,recipient:qualifyRepeatGraphExecution(bare,ref.occurrence),sender:qualifyRepeatGraphExecution(binding.source.execution,'decisionId' in binding.source?binding.source.execution.occurrence:binding.source.occurrence),acceptedResultDigest:binding.source.acceptedResultDigest,inputDigest:binding.inputDigest,ordinal:binding.ordinal,kind:binding.kind,relationshipId:'relationshipId' in binding.source?binding.source.relationshipId:null,decisionId:'decisionId' in binding.source?binding.source.decisionId:null}}))])
    if(!execution)repeatConflict('JOB_PREPARATION_PIN_CONFLICT');return execution
  })}
  async observeJobState(ref:RepeatNodeRef,executionId:string):Promise<JobExecutionRecord>{return this.transaction(async context=>{this.node(context,ref);await this.slot(context,ref,executionId);const execution=await this.jobs.read(context.sql,executionId);this.assertExecution(context,ref,execution);await this.publication.observe(context.sql,context.scope,execution);return execution})}
  async acceptJobTerminal(ref:RepeatNodeRef,executionId:string):Promise<RepeatResolution>{return this.transaction(async context=>{
    this.node(context,ref);await this.slot(context,ref,executionId)
    const prior=(await this.resolutions(context,ref.occurrence?.occurrenceId??null)).get(ref.nodeId)
    if(prior){if(prior.value.execution?.executionId!==executionId)repeatConflict('JOB_WORKFLOW_PIN_CONFLICT');await this.recorded(context,'terminal.accept',executionId);return prior}
    const execution=await this.jobs.read(context.sql,executionId);this.assertExecution(context,ref,execution);await this.jobs.verifyResult(context.sql,execution)
    const {result,resolution}=workflowJobResult(context.version,ref,execution,(await this.jobs.artifacts(context.sql,execution)).filter(value=>value.state==='available'))
    let decision:RepeatDecisionV1|undefined,successor:ReturnType<typeof makeRepeatOccurrence>|undefined,exported:RepeatResolution|undefined
    const block=blockForNode(context.version,ref.nodeId)
    if(block?.exitNodeId===ref.nodeId&&resolution.value.resolution==='succeeded'){
      const resolutions=await this.resolutions(context,ref.occurrence!.occurrenceId);resolutions.set(ref.nodeId,resolution);assertRepeatBodyComplete(context.version,ref.occurrence!,resolutions)
      await visitRepeatNativeAttemptsLocked(context.sql,context.scope.runId,{kind:'occurrence',id:ref.occurrence!.occurrenceId},async ids=>{
        const snapshot=await readAcceptedRepeatRunLocked(context.sql,context.scope.runId)
        for(const id of ids){const stored=await readRepeatExecutionLocked(context.sql,snapshot,id);await settleRepeatNativeExecutionLocked(context.sql,context.scope.runId,stored.execution)}
        await context.hooks.assertSettlementLocked(context.sql,ids)
      })
      const body=(await context.sql.query<{execution_id:string}>(`select execution_id from run_repeat_executions where run_id=$1 and occurrence_id=$2 and identity->>'kind'='job'`,[context.scope.runId,ref.occurrence!.occurrenceId])).rows
      for(const row of body)await this.jobs.verifyResult(context.sql,await this.jobs.read(context.sql,row.execution_id))
      const current=await this.occurrence(context,ref);if(!current)repeatConflict('REPEAT_OCCURRENCE_NOT_FOUND')
      decision=workflowJobRepeatDecision(context.version,current.occurrence,execution,result,context.now)
      if(decision.reason==='repeat'){successor=makeRepeatOccurrence(context.scope,block,repeatSuccessorInput(current.input,decision,result),decision);validateRepeatSuccessorV1(context.version,decision,successor.occurrence,result)}else exported=finalRepeatExport(context.version,resolution,decision)
    }
    const facts:RepeatGraphFactV3[]=[{type:'repeat.node.resolved',resolution:{...resolution,outside:ref.occurrence===null}}]
    if(resolution.value.acceptedResultDigest)facts.unshift({type:'repeat.result.accepted',result:{execution:qualifyRepeatGraphExecution(resolution.value.execution!,ref.occurrence),resultDigest:resolution.value.acceptedResultDigest}})
    if(decision){const {resultData:_data,...metadata}=decision;void _data;facts.push({type:'repeat.decision',decision:RepeatDecisionMetadataV1Schema.parse(metadata)})}
    if(successor)facts.push({type:'repeat.occurrence',occurrence:successor.occurrence})
    if(exported)facts.push({type:'repeat.node.resolved',resolution:{...exported,outside:true}})
    await this.effect(context,'terminal.accept',executionId,{result,resolution,decision:decision??null,successor:successor??null,exported:exported??null},async()=>{
      if(resolution.value.acceptedResultDigest)await context.sql.query('insert into run_repeat_results(execution_id,run_id,occurrence_id,result_json,result_digest,accepted_at) values($1,$2,$3,$4,$5,$6)',[executionId,context.scope.runId,ref.occurrence?.occurrenceId??null,canonicalGraphJson(result,64*1024),resolution.value.acceptedResultDigest,context.now])
      await context.sql.query('update workflow_job_executions set accepted=true where run_id=$1 and job_execution_id=$2',[context.scope.runId,executionId]);await this.putResolution(context,resolution)
      if(decision)await context.sql.query('insert into run_repeat_decisions(decision_id,occurrence_id,exit_execution_id,result_digest,record) values($1,$2,$3,$4,$5::jsonb)',[decision.decisionId,decision.occurrence.identity.occurrenceId,executionId,decision.acceptedResultDigest,JSON.stringify(decision)])
      if(successor){const item=successor.occurrence,previous=item.input.previous;await context.sql.query(`insert into run_repeat_occurrences (occurrence_id,run_id,workspace_id,workflow_id,workflow_version_id,block_id,occurrence_index,binding_id,input_json,input_digest,previous_occurrence_id,previous_occurrence_index,previous_decision_id,previous_result_digest,record) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,[item.identity.occurrenceId,context.scope.runId,context.scope.workspaceId,context.scope.workflowId,context.scope.workflowVersionId,item.identity.blockId,item.identity.occurrenceIndex,item.input.bindingId,canonicalGraphJson(successor.input,4*1024*1024),item.input.inputDigest,previous?.occurrenceId??null,previous?.occurrenceIndex??null,previous?.decisionId??null,previous?.acceptedResultDigest??null,JSON.stringify(item)])}
      if(exported)await this.putResolution(context,exported,true)
    },async()=>facts)
    return resolution
  })}
}
