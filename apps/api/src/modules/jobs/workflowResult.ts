import { ExecutionResultSchema, type ExecutionResult } from '@foreman-code/contracts'
import {
  NodeResolutionSchema,
  parseRepeatExitResultV1,
  validateRepeatDecisionV1,
  type RepeatOccurrenceIdentityV1,
  type WorkflowVersionV3,
} from '@foreman-code/contracts/wave25'
import type { JobArtifact } from '@foreman-code/contracts/jobs'
import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { JobWorkflowNodeSchema } from '@foreman-code/contracts/job-workflow'
import { blockForNode, repeatConflict, repeatDigest, repeatId, type RepeatNodeRef, type RepeatResolution } from '../runs/repeatResolution.js'

/** Generated from actual job truth, never a fabricated provider turn or HarnessExecution. */
export function workflowJobResult(version:WorkflowVersionV3,ref:RepeatNodeRef,execution:JobExecutionRecord,artifacts:readonly JobArtifact[]):{result:ExecutionResult;resolution:RepeatResolution} {
  const node=JobWorkflowNodeSchema.parse(version.definition.nodes.find(node=>node.id===ref.nodeId))
  if(execution.workflow?.runId!==ref.occurrence?.scope.runId&&ref.occurrence!==null)repeatConflict('JOB_WORKFLOW_PIN_CONFLICT')
  if(execution.workflow?.workflowId!==version.workflowId||execution.workflow.nodeId!==node.id||execution.acceptedSpec.definitionId!==node.jobDefinitionId||execution.acceptedSpec.definitionVersionId!==node.jobDefinitionVersionId)repeatConflict('JOB_WORKFLOW_PIN_CONFLICT')
  if(execution.process.phase!=='terminal'||!execution.process.processStopped||!execution.process.outcome||!execution.finishedAt||['pending','collecting'].includes(execution.publication))repeatConflict('JOB_RESULT_PENDING')
  const ready=execution.publication==='complete'&&!execution.resultIssue
  const outcome=execution.process.outcome!=='succeeded'?execution.process.outcome:ready?'succeeded':execution.resultIssue==='log_overflow'||execution.resultIssue==='log_delivery_unknown'?'logs_incomplete':'output_failed'
  const data={latestDeliverable:{jobExecutionId:execution.id,process:{outcome:execution.process.outcome,exitCode:execution.process.exitCode,signal:execution.process.signal},
    publication:execution.publication,resultIssue:execution.resultIssue,artifacts:artifacts.map(({fileId,revisionId,sha256,byteSize,path})=>({fileId,revisionId,sha256,byteSize,path}))},
    remainingFindings:outcome==='succeeded'?[]:[{outcome,exitCode:execution.process.exitCode,publication:execution.publication}]}
  const routed=node.choice?.outcomes.find(item=>item.outcome===outcome)
  const accepted=!!routed||(outcome==='succeeded'&&!node.choice)
  const result=ExecutionResultSchema.parse(accepted?{outcome:'succeeded',output:node.choice?{routing:{outcome},data}:data}:{outcome:outcome==='cancelled'?'canceled':'failed',error:{code:`JOB_${outcome.toUpperCase()}`,message:'The job did not produce its required accepted workflow result.',retryable:false}})
  const outgoing=version.definition.edges.filter(edge=>edge.kind==='execution'&&edge.source===node.id).map(edge=>edge.id).sort()
  const exit=blockForNode(version,node.id)?.exitNodeId===node.id
  const selected=accepted&&!exit?(routed?routed.target.kind==='edge'?[routed.target.relationshipId]:[]:outgoing):[]
  const identity={kind:'job' as const,workflowNodeId:node.id,executionId:execution.id,jobDefinitionId:node.jobDefinitionId,jobDefinitionVersionId:node.jobDefinitionVersionId,attempt:1}
  return {result,resolution:{ref,deferredRelationshipIds:accepted&&exit?outgoing:[],value:NodeResolutionSchema.parse({workflowNodeId:node.id,execution:identity,resolution:result.outcome,
    ...(accepted?{acceptedResultDigest:repeatDigest(result,64*1024)}:{}),...(routed?{outcome}:{}),branchEnded:!exit&&routed?.target.kind==='branch_end',selectedRelationshipIds:selected,
    unselectedRelationshipIds:outgoing.filter(id=>!selected.includes(id)&&!(accepted&&exit)),resolvedAt:execution.finishedAt})}}
}
export function workflowJobIdentity(execution:JobExecutionRecord,node:{id:string;jobDefinitionId:string;jobDefinitionVersionId:string},occurrence:RepeatOccurrenceIdentityV1|null) {
  return {kind:'job' as const,workflowNodeId:node.id,executionId:execution.id,jobDefinitionId:node.jobDefinitionId,jobDefinitionVersionId:node.jobDefinitionVersionId,attempt:1,occurrence}
}
export function workflowJobRepeatDecision(version:WorkflowVersionV3,occurrence:import('@foreman-code/contracts/wave25').RepeatOccurrenceV1,execution:JobExecutionRecord,result:ExecutionResult,decidedAt:string) {
  const block=version.definition.repeat!.blocks.find(block=>block.id===occurrence.identity.blockId)!
  const node=JobWorkflowNodeSchema.parse(version.definition.nodes.find(node=>node.id===block.exitNodeId))
  const envelope=parseRepeatExitResultV1(result,node.choice!)
  const early=envelope.routing.outcome===block.earlyExitOutcome
  if(!early&&envelope.routing.outcome!==block.repeatOutcome)repeatConflict('REPEAT_OUTCOME_UNDECLARED')
  const reason=early?'early_exit' as const:occurrence.identity.occurrenceIndex===block.maxOccurrences?'limit_exit' as const:'repeat' as const
  const target=early?node.choice!.outcomes.find(item=>item.outcome===envelope.routing.outcome)!.target:reason==='limit_exit'?block.limitExit:{kind:'next_occurrence' as const,entryNodeId:block.entryNodeId,occurrenceIndex:occurrence.identity.occurrenceIndex+1}
  const acceptedResultDigest=repeatDigest(result,64*1024)
  return validateRepeatDecisionV1(version,{contractVersion:1,decisionId:repeatId('repeat-decision',occurrence.identity.occurrenceId,execution.id,acceptedResultDigest),occurrence,
    exitExecution:workflowJobIdentity(execution,node,occurrence.identity),acceptedResultDigest,outcome:envelope.routing.outcome,reason,target,decidedAt,resultData:envelope.data},result)
}
