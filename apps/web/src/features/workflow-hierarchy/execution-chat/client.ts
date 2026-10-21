import { z } from 'zod'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { ChatControlReceiptSchema, ChatDeliveryReceiptSchema, ChatQueueCancelRequestSchema,
  ChatSendRequestSchema, ChatStopRequestSchema, EngineChatReadbackSchema, sameAgentNode,
  WorkflowExecutionChatReadRequestSchema, WorkflowExecutionChatResolutionSchema,
  WorkflowExecutionChatSelectionSchema, WorkflowExecutionChatTargetSchema,
  type ChatQueueCancelRequest, type ChatSendRequest, type ChatStopRequest,
  type WorkflowExecutionChatResolution, type WorkflowExecutionChatSelection, type WorkflowExecutionChatTarget,
} from '@foreman-code/contracts'
import { apiClient, ApiError, type RequestOptions } from '../../../shared/api/client'
import { sessionGeneration } from '../../../shared/api/sessionBoundary'

export type ExecutionChatSelectionInput = z.input<typeof WorkflowExecutionChatSelectionSchema>
export type ExecutionChatReadInput = z.input<typeof WorkflowExecutionChatReadRequestSchema>
export const executionChatScopeKey = (scope: { workspaceId:string; workflowId:string }) =>
  ['workflow-execution-chat',sessionGeneration(),scope.workspaceId,scope.workflowId] as const
export const executionChatSelectionKey = (input: ExecutionChatSelectionInput) =>
  [...executionChatScopeKey(input),'selection',WorkflowExecutionChatSelectionSchema.parse(input)] as const
export const executionChatReadKey = (target: WorkflowExecutionChatTarget) =>
  [...executionChatScopeKey(target.agent),'read',target] as const

function path(scope: { workspaceId:string; workflowId:string }) {
  return `/api/workspaces/${encodeURIComponent(scope.workspaceId)}/workflows/${encodeURIComponent(scope.workflowId)}/execution-chat`
}
function invalidResponse(): never {
  throw new ApiError({ code:'INVALID_RESPONSE',message:'The chat response belongs to another saved selection. Your selection has been kept.' })
}
function assertTarget(expected: WorkflowExecutionChatTarget, actual: unknown) {
  if(canonicalJson(expected)!==canonicalJson(actual)) invalidResponse()
}
function assertChoice(input: WorkflowExecutionChatSelection,
  choice: Omit<Extract<WorkflowExecutionChatResolution,{kind:'selected'}>,'kind'>) {
  const target=choice.target, agent=target.agent
  const runId=target.kind==='workflow_execution'?target.execution.runId:target.runId
  if(agent.workspaceId!==input.workspaceId||agent.workflowId!==input.workflowId||agent.workflowNodeId!==input.workflowNodeId
    ||!sameAgentNode(agent,choice.agent)||input.runId&&input.runId!==runId
    ||input.workflowVersionId&&input.workflowVersionId!==choice.workflowVersionId
    ||target.kind==='workflow_execution'&&target.execution.workflowVersionId!==choice.workflowVersionId
    ||input.executionId&&(target.kind!=='workflow_execution'||target.execution.executionId!==input.executionId)
    ||input.waitingActivationId&&(target.kind!=='workflow_coordinator'||target.waitingActivationId!==input.waitingActivationId)) invalidResponse()
}

export async function resolveExecutionChat(input: ExecutionChatSelectionInput, options?: RequestOptions) {
  const parsed=WorkflowExecutionChatSelectionSchema.parse(input), query=new URLSearchParams({workflowNodeId:parsed.workflowNodeId,limit:String(parsed.limit)})
  for(const key of ['runId','workflowVersionId','executionId','waitingActivationId','cursor'] as const) {
    if(parsed[key]) query.set(key,parsed[key])
  }
  const result=await apiClient.request(`${path(parsed)}/target?${query}`,WorkflowExecutionChatResolutionSchema,options)
  if(result.kind==='selected') assertChoice(parsed,result)
  if(result.kind==='selection_required') for(const choice of result.items) assertChoice(parsed,choice)
  if(result.kind==='run_selection_required'&&(parsed.runId||result.items.some(item=>
    parsed.workflowVersionId&&parsed.workflowVersionId!==item.workflowVersionId))) invalidResponse()
  if(result.kind==='outside_run'&&(parsed.runId||result.agent.workspaceId!==parsed.workspaceId
    ||result.agent.workflowId!==parsed.workflowId||result.agent.workflowNodeId!==parsed.workflowNodeId
    ||parsed.workflowVersionId&&parsed.workflowVersionId!==result.workflowVersionId)) invalidResponse()
  return result
}

export async function readExecutionChat(input: ExecutionChatReadInput, options?: RequestOptions) {
  const request=WorkflowExecutionChatReadRequestSchema.parse(input)
  const result=await apiClient.request(`${path(request.target.agent)}/read`,EngineChatReadbackSchema,
    {...options,method:'POST',body:request})
  assertTarget(request.target,result.target)
  return result
}
/** The visible F3 composer creates and retains commandId before calling these
 * functions. A transport failure never generates a second command or retries it. */
export async function deliverExecutionChat(input: ChatSendRequest & {commandId:string}, options?: RequestOptions) {
  const request=ChatSendRequestSchema.parse(input), target=WorkflowExecutionChatTargetSchema.parse(request.target)
  if(!request.commandId) throw new ApiError({code:'COMMAND_ID_REQUIRED',message:'Keep the pending message identity when retrying.'})
  const result=await apiClient.request(`${path(target.agent)}/send`,ChatDeliveryReceiptSchema,{...options,method:'POST',body:request})
  assertTarget(target,result.target)
  if(result.commandId!==request.commandId) invalidResponse()
  return result
}
export async function stopExecutionChat(input: ChatStopRequest & {commandId:string}, options?: RequestOptions) {
  const request=ChatStopRequestSchema.parse(input), target=WorkflowExecutionChatTargetSchema.parse(request.target)
  if(!request.commandId) throw new ApiError({code:'COMMAND_ID_REQUIRED',message:'Keep the pending Stop identity when retrying.'})
  const result=await apiClient.request(`${path(target.agent)}/stop`,ChatControlReceiptSchema,{...options,method:'POST',body:request})
  assertTarget(target,result.target)
  if(result.commandId!==request.commandId) invalidResponse()
  return result
}
export async function cancelExecutionChatQueue(input: ChatQueueCancelRequest & {commandId:string}, options?: RequestOptions) {
  const request=ChatQueueCancelRequestSchema.parse(input), target=WorkflowExecutionChatTargetSchema.parse(request.target)
  if(!request.commandId) throw new ApiError({code:'COMMAND_ID_REQUIRED',message:'Keep the pending queue command identity when retrying.'})
  const result=await apiClient.request(`${path(target.agent)}/queue/cancel`,ChatControlReceiptSchema,{...options,method:'POST',body:request})
  assertTarget(target,result.target)
  if(result.commandId!==request.commandId) invalidResponse()
  return result
}
export const workflowExecutionChatClient = {
  read:readExecutionChat, deliver:deliverExecutionChat, stop:stopExecutionChat, cancel:cancelExecutionChatQueue,
}
export type WorkflowExecutionChatClient = typeof workflowExecutionChatClient
