import { randomBytes } from 'node:crypto'
import type { AgentChatManagerFactory } from '../conversations/agentChat.js'
import type { NativeManagerResolver } from '../conversations/operatorChat.js'
import { agentChatCorrelation } from '../conversations/agentChatRepository.js'
import { nativeCorrelation } from '../conversations/operatorChatRepository.js'
import { prepareWorkerChatFrame } from '../conversations/nativeChatInput.js'
import { WorkerConversationBindingSchema, type WorkerConversationBinding,
  WorkerConversationRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { legacyProviderAccountBinding, readProviderAccountBinding } from '../provider-accounts/acceptedBindings.js'
import { readExecutionPlacement, readNativePlacement } from '../placement/persistence.js'
import { conversationChatTools } from '../access/conversationCredentials.js'
import { workerOperatorDirectory } from '../conversations/workerOperatorDirectory.js'
import { DomainError } from '../errors.js'
import type { SqlQuery } from '../../infrastructure/transaction.js'
import type { PreparedChatInput, AcceptedChatSettings } from '../conversations/nativeChatInput.js'
import type { NativeSessionReference } from '@foreman-code/contracts'

function credential(kind: 'agent-chat-mcp' | 'operator-chat-mcp') {
  // Proofs retain only this serialized size; the native owner issues the actual credential after admission.
  return { kind, token: `opm_${randomBytes(32).toString('base64url')}` }
}
function prepare(input: { binding: WorkerConversationBinding; configuration: unknown; correlationId: string;
  prompt: string; settings: AcceptedChatSettings; native?: NativeSessionReference; expectedNativeTurnId?: string | undefined;
  intent?: string | undefined; fileInputs: boolean }): PreparedChatInput {
  const { binding, configuration, correlationId, prompt, settings, native, intent } = input
  const common = { binding, correlationId, prompt }
  let frame: unknown
  if (intent === 'steer') {
    if (!native || !input.expectedNativeTurnId) throw new DomainError('CHAT_TARGET_CHANGED',
      'Steering requires the exact current native turn.', 409)
    frame = { method: 'conversation.steer', ...common, session: native, expectedTurnId: input.expectedNativeTurnId }
  } else {
    const preferences = { sessionMode: settings.sessionMode, preferences: settings.sessionPreferences }
    frame = native ? { method: 'conversation.start-turn', ...common, ...preferences, session: native,
      ...(input.fileInputs ? { fileInputs: true } : {}) }
      : { method: 'conversation.initial-turn', ...common, ...preferences, configuration, operationId: correlationId,
        ...(binding.appMcpAccess === 'scoped' ? { applicationAccess: credential(binding.owner.kind === 'agent'
          ? 'agent-chat-mcp' : 'operator-chat-mcp') } : {}) }
  }
  return { prompt, workerFrames: [prepareWorkerChatFrame(WorkerConversationRpcRequestSchema.parse(frame))] }
}

export function prepareAgentChatInput(database: SqlQuery): NonNullable<AgentChatManagerFactory['prepareInput']> {
  return async input => {
    const { configuration, row, featureContext, workingDirectory, request } = input
    const profile = configuration.harnessProfileSelection
    if (profile?.target.hostRef.kind !== 'device') return { prompt: input.prompt }
    if (!row || !input.conversationId) throw new DomainError('CHAT_PREFLIGHT_UNAVAILABLE',
      'The exact reserved conversation is required before Worker input preparation.', 503)
    const sql: SqlQuery = input.sql ?? database
    const retained = row.worker_conversation_binding ? WorkerConversationBindingSchema.parse(row.worker_conversation_binding) : undefined
    const origin = row.record.origin
    let sourceExecution = retained?.sourceExecution
    if (origin.kind === 'run_execution' && !sourceExecution) {
      const placement = await readExecutionPlacement(sql, origin.executionId)
      const native = await readNativePlacement(sql, origin.executionId)
      if (!placement || !native?.workingTree) throw new DomainError('CHAT_PREFLIGHT_UNAVAILABLE',
        'The original Run working tree is unavailable for Worker preparation.', 409)
      sourceExecution = { executionId: origin.executionId, placement, workingTree: native.workingTree }
    }
    const appMcpAccess = conversationChatTools(featureContext).length ? 'scoped' : 'none'
    const accountBinding = await readProviderAccountBinding(sql, 'agent-conversation', row.id)
      ?? legacyProviderAccountBinding(configuration.harness, configuration.harnessProfileSelection)
    const binding = WorkerConversationBindingSchema.parse({
      ...(row.record.workerGeneration ? { generation: row.record.workerGeneration } : {}),
      ...(!row.record.workerGeneration && retained?.sessionGeneration ? { sessionGeneration: retained.sessionGeneration } : {}),
      owner: { kind: 'agent', conversationId: row.id, workspaceId: row.workspace_id, workflowId: row.workflow_id,
        workflowNodeId: row.workflow_node_id, agentId: row.agent_id, configurationVersionId: configuration.id,
        configurationHash: commandInputHash(configuration) },
      harness: configuration.harness.harness, profile, workingDirectory, appMcpAccess,
      ...(accountBinding ? { accountBinding } : {}),
      ...(sourceExecution ? { sourceExecution } : {}),
      ...(row.record.sourceConfigurationVersionId ? { sourceConfigurationVersionId: row.record.sourceConfigurationVersionId } : {}),
      ...(row.record.systemPrompt ? { systemPrompt: row.record.systemPrompt } : {}),
      ...(row.record.directoryBinding ? { directoryBinding: row.record.directoryBinding } : {}),
    })
    return prepare({ binding, configuration, prompt: input.prompt,
      correlationId: agentChatCorrelation(row.id, request.requestId), settings: input.settings, intent: request.intent,
      ...(request.expectedNativeTurnId ? { expectedNativeTurnId: request.expectedNativeTurnId } : {}),
      ...(row.native_session_id && row.provider_version ? { native: { harness: row.harness,
        nativeSessionId: row.native_session_id, providerVersion: row.provider_version } } : {}),
      fileInputs: configuration.harness.harness === 'codex' })
  }
}

export function prepareOperatorChatInput(database: SqlQuery,
  runtimeRoot: (profile: NonNullable<Parameters<NativeManagerResolver>[0]['harnessProfileSelection']>) => Promise<string>
): NonNullable<NativeManagerResolver['prepareInput']> {
  return async input => {
    const { configuration, row, request } = input
    const profile = configuration.harnessProfileSelection
    if (profile?.target.hostRef.kind !== 'device') return { prompt: input.prompt }
    const sql: SqlQuery = input.sql ?? database
    const owner = { kind: 'operator' as const, operatorId: configuration.operatorId, conversationId: row.id,
      configurationVersionId: configuration.id, configurationHash: commandInputHash(configuration) }
    const accountBinding = await readProviderAccountBinding(sql, 'operator-command', `${row.id}:session`)
      ?? legacyProviderAccountBinding(configuration.harness, profile)
    const retained = row.worker_conversation_binding
    const appMcpAccess = request.attachments?.length && configuration.harness.harness === 'claude' ? 'none' : 'scoped'
    const binding = WorkerConversationBindingSchema.parse({ ...(retained ?? { owner,
      harness: configuration.harness.harness, profile,
      workingDirectory: workerOperatorDirectory(await runtimeRoot(profile), owner),
      ...(accountBinding ? { accountBinding } : {}) }), appMcpAccess })
    return prepare({ binding, configuration, prompt: input.prompt,
      correlationId: nativeCorrelation(row.id, request.requestId), settings: input.settings, intent: request.intent,
      expectedNativeTurnId: request.expectedNativeTurnId ?? row.active_native_turn_id ?? undefined,
      ...(row.native_session_id && row.provider_version ? { native: { harness: row.harness,
        nativeSessionId: row.native_session_id, providerVersion: row.provider_version } } : {}),
      fileInputs: configuration.harness.harness === 'codex' && Boolean(request.attachments?.length) })
  }
}
