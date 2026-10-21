import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { SessionPreferencesSchema, sessionTaskContent, type AgentConfigurationVersion } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { WorkerConversationBindingSchema, type WorkerConversationBinding } from '@foreman-code/contracts/remote-execution-rpc'
import type { SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { agentChatCorrelation, type AgentConversationRow } from './agentChatRepository.js'
import { agentConfigurationTransition, agentConfigurationDirectory, agentConfigurationHandoff } from './agentConfigurationTransition.js'
import { agentMessagePrompt } from './agentMessagePrompt.js'
import { assertWorkerChatRequestSize } from './chatInputSize.js'
import { legacyProviderAccountBinding } from '../provider-accounts/acceptedBindings.js'

export async function assertAgentWorkerRequests(sql: Pick<pg.PoolClient, 'query'>, input: {
  row: AgentConversationRow; configuration: AgentConfigurationVersion; nextConfiguration?: AgentConfigurationVersion
  request: SendAgentChatMessageRequest; preferences: unknown
  sourceExecution?: WorkerConversationBinding['sourceExecution']
}): Promise<void> {
  const { row, configuration, nextConfiguration, request } = input
  const selected = nextConfiguration ?? configuration
  const previousBinding = row.worker_conversation_binding
    ? WorkerConversationBindingSchema.parse(row.worker_conversation_binding) : undefined
  const originalSession = row.native_session_id && row.provider_version
    ? { harness: row.harness, nativeSessionId: row.native_session_id, providerVersion: row.provider_version } : undefined
  const admissionId = randomUUID()
  const transition = nextConfiguration ? agentConfigurationTransition(row, configuration, nextConfiguration) : undefined
  if (transition?.replaceSession && previousBinding && originalSession) {
    assertWorkerChatRequestSize({ method: 'conversation.close', binding: previousBinding, admissionId, session: originalSession })
  }
  const profile = nextConfiguration ? selected.harnessProfileSelection
    : previousBinding?.profile ?? selected.harnessProfileSelection
  if (profile?.target.hostRef.kind !== 'device') return

  const record = { ...row.record }
  if (nextConfiguration) {
    const directoryBinding = await agentConfigurationDirectory(sql, row, selected)
    if (directoryBinding) record.directoryBinding = directoryBinding
    if (row.origin_run_id) record.sourceConfigurationVersionId ??= row.agent_configuration_version_id
  }
  if (transition?.replaceSession) {
    if (row.native_session_id) record.workerGeneration = randomUUID()
    record.handoffContext = await agentConfigurationHandoff(sql, row.id)
    record.startupDelivered = false
  }
  const binding = WorkerConversationBindingSchema.parse({ ...previousBinding,
    owner: { kind: 'agent', workspaceId: row.workspace_id, agentId: row.agent_id,
      workflowId: row.workflow_id, workflowNodeId: row.workflow_node_id, conversationId: row.id,
      configurationVersionId: selected.id, configurationHash: commandInputHash(selected) },
    harness: selected.harness.harness, profile, workingDirectory: record.workingDirectory, appMcpAccess: 'none',
    generation: record.workerGeneration, sessionGeneration: record.workerGeneration ? undefined : previousBinding?.sessionGeneration,
    systemPrompt: record.systemPrompt, directoryBinding: record.directoryBinding,
    sourceExecution: previousBinding?.sourceExecution ?? input.sourceExecution,
    sourceConfigurationVersionId: record.sourceConfigurationVersionId,
    accountBinding: transition?.replaceSession ? legacyProviderAccountBinding(selected.harness, profile)
      : previousBinding?.accountBinding ?? row.providerAccountBinding ?? legacyProviderAccountBinding(selected.harness, profile),
  })
  const session = transition?.replaceSession ? undefined : originalSession
  const correlationId = agentChatCorrelation(row.id, request.requestId)
  const prompt = request.intent === 'steer' ? request.content
    : agentMessagePrompt(record, selected, sessionTaskContent(request.content, request.sessionMode)).text
  if (request.intent === 'steer' && session) {
    assertWorkerChatRequestSize({ method: 'conversation.steer', binding, admissionId, session, prompt,
      correlationId, expectedTurnId: request.expectedNativeTurnId! })
    return
  }
  const preferences = input.preferences === undefined ? undefined : SessionPreferencesSchema.parse(input.preferences)
  const settings = preferences ? { preferences } : {}
  const retainedTransition = nextConfiguration && previousBinding && !transition?.replaceSession
    ? { previousBinding, previousConfiguration: configuration } : {}
  const opening = { binding, admissionId, operationId: correlationId, configuration: selected,
    ...retainedTransition, ...settings }
  const turn = { binding, admissionId, prompt, correlationId,
    ...(request.sessionMode ? { sessionMode: request.sessionMode } : {}), ...settings }
  if (!session && binding.harness === 'claude') {
    assertWorkerChatRequestSize({ method: 'conversation.initial-turn', ...opening, ...turn })
    return
  }
  assertWorkerChatRequestSize({ method: 'conversation.open', ...opening,
    mode: session ? 'attach' : 'create', ...(session ? { source: session } : {}) })
  assertWorkerChatRequestSize({ method: 'conversation.start-turn', ...turn,
    ...(session ? { session } : {}), ...(binding.harness === 'codex' ? { fileInputs: true } : {}) })
}
