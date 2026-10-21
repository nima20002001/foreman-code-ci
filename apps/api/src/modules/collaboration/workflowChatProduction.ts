import type pg from 'pg'
import { workflowChatNativeContext } from '../workflow-chat/nativeContext.js'
import { AgentConfigurationVersionSchema, HarnessExecutionSchema, type ChatSendRequest,
  type HarnessExecution } from '@foreman-code/contracts'
import { WorkActivationInputSchema } from '@foreman-code/contracts/wave25'
import { DEVICE_APPLICATION_JSON_BYTES } from '@foreman-code/contracts/device-application'
import { RemoteExecutionRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { RemoteOperationReceiptSchema, remoteActiveNative } from '@foreman-code/contracts/remote-execution'
import { DomainError } from '../errors.js'
import { buildHarnessPrompt, MAX_HARNESS_PROMPT_BYTES } from '../harnesses/prompt.js'
import type { ApprovalExecutionCoordinator } from '../interactions/execution.js'
import { workflowChatDirectionPrompt, workflowChatInputPrompt } from '../interactions/workflowChatInput.js'
import { nativeOutputSchema } from '../interactions/deliverable.js'
import { readDispatchIntent, readExecutionPlacement } from '../placement/persistence.js'
import { withExclusiveGraphConnection } from '../run-graph/connection.js'
import { workflowExecutionPromptContext } from '../runs/workflowExecutionRequest.js'
import { workflowDeliverableContract, referencesCreatedByExecution } from '../runs/workflowDeliverable.js'
import { readWorkResultContextLocked } from '../runs/workReturnValidation.js'
import { repeatTickIndex } from '../runs/repeatResolution.js'
import { configurationWithNodeSkills } from '../skills/nodeSkills.js'
import { workflowConsultationPromptLocked } from './workflowConsultationPrompt.js'
import { workflowChatAttachmentAuthorization } from './workflowChatFiles.js'
import { readWorkflowCollaborationPromptLocked } from './workflowPreparation.js'
import { controlId } from './workflowControlRecords.js'
import type { WorkflowChatAdmission, WorkflowChatLockedTarget } from './workflowControlTypes.js'
import { WorkflowExecutionChatService } from './workflowChatService.js'
import { workflowRemoteControl } from './workflowRemoteControl.js'

async function prepareWorkflowChatPrompt(context: WorkflowChatLockedTarget, request: ChatSendRequest,
  admission: WorkflowChatAdmission): Promise<{
    source: HarnessExecution; nativePrompt: string; outputSchema?: Record<string, unknown> | undefined
  }> {
  const source = context.execution ?? HarnessExecutionSchema.parse((await context.sql.query<{ record: unknown }>(
    'select record from harness_executions where id=$1 and run_id=$2',
    [context.waiting?.sourceExecution.executionId, context.run.id])).rows[0]?.record)
  const row = (await context.sql.query<{ record: unknown }>(
    'select record from agent_configuration_versions where id=$1 and agent_id=$2',
    [context.agent.configurationVersionId, context.agent.agentId])).rows[0]
  const pinned = AgentConfigurationVersionSchema.parse(row?.record)
  const node = context.version.definition.nodes.find(item => item.id === context.agent.workflowNodeId)
  if (!node || node.kind === 'job') throw new DomainError('CHAT_NODE_UNAVAILABLE', 'The selected Agent is unavailable.', 404)
  const configuration = node.skills || node.browser?.enabled
    ? configurationWithNodeSkills(pinned, node.skills, context.version.nodeSkillSnapshots?.[node.id], node.browser) : pinned
  if (admission.appliedIntent === 'steer') return { source, nativePrompt: workflowChatInputPrompt(request) }
  if (context.target.kind === 'workflow_coordinator') return {
    source, nativePrompt: await workflowConsultationPromptLocked(context, request, configuration),
  }
  const work = context.version.definition.handoffs && repeatTickIndex(source.input) === undefined
    ? WorkActivationInputSchema.parse(source.input) : undefined
  const executionContext = work ? await readWorkResultContextLocked({ sql: context.sql, scope: work.work.activation.scope },
    work.work.activation.activationId, source.input, context.run.resultProtocol) : undefined
  const original = workflowExecutionPromptContext({ execution: source, version: context.version, configuration,
    workspaceId: context.run.workspaceId, executionContext, resultProtocol: context.run.resultProtocol,
    collaborationPrompt: await readWorkflowCollaborationPromptLocked(context.sql, source.id) })
  const directed = { ...original, initialPrompt: workflowChatDirectionPrompt(original, { receiptId: admission.id, request }) }
  const contract = workflowDeliverableContract(context.version, source,
    (kind, values) => referencesCreatedByExecution(context.sql, kind, values, context.run.workspaceId, source.id),
    context.run.resultProtocol)
  return { source, nativePrompt: buildHarnessPrompt(directed), outputSchema: contract && nativeOutputSchema(contract) }
}

/** Admission uses only the owner's SQL snapshot and serializers; dispatch uses the saved prompt. */
export async function validateWorkflowChatAdmission(context: WorkflowChatLockedTarget, request: ChatSendRequest,
  admission: WorkflowChatAdmission): Promise<{ nativePrompt: string }> {
  const prepared = await prepareWorkflowChatPrompt(context, request, admission)
  const channelContext = admission.channelContext ?? await workflowChatNativeContext(context.sql, request)
  const nativePrompt = channelContext ? `${prepared.nativePrompt}\n\n${channelContext}` : prepared.nativePrompt
  const { source } = prepared
  if (Buffer.byteLength(nativePrompt, 'utf8') > MAX_HARNESS_PROMPT_BYTES) throw new DomainError(
    'HARNESS_INPUT_TOO_LARGE', 'The complete native prompt exceeds the input limit.', 413)
  const consultationId = controlId('consultation', context.run.id, admission.id)
  const continuationId = controlId('continuation', context.run.id, admission.id)
  const executionId = admission.appliedIntent === 'interrupt_and_send'
    ? controlId('control-execution', continuationId) : source.id
  const correlationId = context.target.kind === 'workflow_coordinator'
    ? `consultation:${consultationId}` : `execution:${executionId}`
  const turn = { prompt: nativePrompt, correlationId, sessionMode: request.sessionMode ?? 'regular',
    deferSettlement: true as const, ...(prepared.outputSchema ? { outputSchema: prepared.outputSchema } : {}) }
  const placement = await readExecutionPlacement(context.sql, source.id)
  let envelope: unknown = turn
  let maximum = MAX_HARNESS_PROMPT_BYTES
  if (placement?.hostRef.kind === 'device') {
    const intent = await readDispatchIntent(context.sql, source.id)
    if (!intent) throw new DomainError('REMOTE_CONTROL_UNAVAILABLE', 'The original Worker dispatch is unavailable.', 409)
    maximum = DEVICE_APPLICATION_JSON_BYTES
    envelope = RemoteExecutionRpcRequestSchema.parse({ method: 'start-turn', intent, placement, ...turn })
    if (admission.appliedIntent !== 'next_turn') {
      const stored = (await context.sql.query<{ receipt: unknown }>(
        'select receipt from remote_execution_receipts where operation_id=$1', [intent.operationId])).rows[0]
      const native = stored && remoteActiveNative(RemoteOperationReceiptSchema.parse(stored.receipt))
      if (!native || !context.native || native.sessionId !== context.native.nativeSessionId
        || native.turnId !== (context.native.nativeTurnId ?? context.native.inputMessageId)) throw new DomainError(
        'CHAT_NATIVE_TARGET_CHANGED', 'The original Worker native input changed before admission.', 409)
      const command = workflowRemoteControl(intent, native, { commandId: admission.id,
        ownerRequestId: context.native.ownerRequestId, action: admission.appliedIntent === 'steer'
          ? { kind: 'steer', prompt: nativePrompt } : { kind: 'stop' } })
      const controlEnvelope = RemoteExecutionRpcRequestSchema.parse({ method: 'control', intent, placement, command })
      if (Buffer.byteLength(JSON.stringify(controlEnvelope), 'utf8') > maximum) throw new DomainError(
        'HARNESS_INPUT_TOO_LARGE', 'The complete serialized native control exceeds the transport limit.', 413)
      if (admission.appliedIntent === 'steer') envelope = controlEnvelope
    }
  } else if (admission.appliedIntent === 'steer') {
    envelope = { method: 'turn/steer', params: { threadId: context.native!.nativeSessionId,
      expectedTurnId: context.native!.nativeTurnId, clientUserMessageId: admission.id,
      input: [{ type: 'text', text: nativePrompt, text_elements: [] }] } }
  }
  if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > maximum) throw new DomainError(
    'HARNESS_INPUT_TOO_LARGE', 'The complete serialized native command exceeds the transport limit.', 413)
  return { nativePrompt }
}

export function createWorkflowExecutionChatService(pool: pg.Pool, coordinator: ApprovalExecutionCoordinator) {
  const authorizeAttachments = workflowChatAttachmentAuthorization(pool)
  const owner = coordinator.workflowChatOwner(pool, async (context, request, admission) => {
    await authorizeAttachments(context.sql, admission.principalId, request)
    return validateWorkflowChatAdmission(context, request, admission)
  })
  return new WorkflowExecutionChatService(pool, { owner,
    assertAttachments: (principal, request) => {
      if (!request.attachments.length) return Promise.resolve()
      return withExclusiveGraphConnection(pool,
        connection => connection.transaction(sql => authorizeAttachments(sql, principal.id, request)))
    },
  })
}
