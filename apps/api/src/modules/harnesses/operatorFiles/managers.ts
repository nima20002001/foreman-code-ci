import type { AcceptedProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import { RETIRED_OPENCODE_MESSAGE } from '@foreman-code/contracts'
import { PostgresOperatorConversationRepository } from '../../conversations/operatorChatRepository.js'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import type { ApiConfig } from '../../../config.js'
import type { NativeManagerResolver } from '../../conversations/operatorChat.js'
import { DomainError } from '../../errors.js'
import { defaultFileStorageRoot } from '../../files/storage.js'
import { productionCodexChatFiles } from '../codexFiles/production.js'
import { NativeHarnessFactories } from '../runtimeFactory.js'
import type { NativeHarnessSessionManager } from '../port.js'
import type { NativeProcessRegistry } from '../recovery/processRegistry.js'
import type { RegistryHarnessSelection } from '../installationRegistry.js'
import type { OperatorConfigurationVersion } from '@foreman-code/contracts'
import type { NativeResponseJournal } from '../recovery/responseJournal.js'
import { operatorCodexFileAdmissions } from './codex.js'
import { operatorTurnHasFileInputs, recordOperatorFileSubmission } from './postgres.js'

/** Operator management credentials and accepted-turn file tokens remain separate. */
export function productionOperatorManagers(input: {
  app: () => FastifyInstance
  pool: pg.Pool
  config: ApiConfig
  workingDirectory: string
  processRegistry: Pick<NativeProcessRegistry, 'scope' | 'closeOwner'>
  responseJournal: NativeResponseJournal
  managers: Map<string, NativeHarnessSessionManager>
  accountBinding?: (conversationId: string) => AcceptedProviderAccountBinding | undefined
  nativeFactories?: NativeHarnessFactories
  createSelected?: (configuration: OperatorConfigurationVersion, conversationId: string, fileInputs: boolean, recovery: ReturnType<NativeProcessRegistry['scope']>) => NativeHarnessSessionManager
  createClaude?: (configuration: OperatorConfigurationVersion, conversationId: string, fileInputs: boolean, recovery: ReturnType<NativeProcessRegistry['scope']>) => NativeHarnessSessionManager
  createDevice?: (configuration: OperatorConfigurationVersion, conversationId: string, fileInputs: boolean) => NativeHarnessSessionManager
  selectInstallation?: (configuration: OperatorConfigurationVersion) => RegistryHarnessSelection | undefined
}): NativeManagerResolver {
  const factories = input.nativeFactories ?? new NativeHarnessFactories({ ...input.config.harnesses,
    responseJournal: input.responseJournal })
  const modes = new Map<string, boolean>()
  const resolver: NativeManagerResolver = (configuration, conversationId, fileInputs = false) => {
    if (configuration.harness.harness === 'opencode') throw new DomainError('HARNESS_RETIRED',
      RETIRED_OPENCODE_MESSAGE, 409)
    const existing = input.managers.get(conversationId)
    if (existing) {
      if (modes.get(conversationId) !== fileInputs) throw new DomainError(
        'OPERATOR_RUNTIME_MODE_CONFLICT', 'Dispose the previous Operator process before changing file authority.', 409)
      return existing
    }
    const recovery = input.processRegistry.scope(`conversation:${conversationId}`)
    if (configuration.harnessProfileSelection?.target.hostRef.kind === 'device') {
      if (!input.createDevice) throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE', 'The selected worker chat runtime is not composed.', 503)
      const manager = input.createDevice(configuration, conversationId, fileInputs)
      input.managers.set(conversationId, manager)
      modes.set(conversationId, fileInputs)
      return manager
    }
    if (configuration.harness.harness === 'claude') {
      if (!input.createClaude) throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'Claude Operator profile admission is not composed.', 409)
      const manager = input.createClaude(configuration, conversationId, fileInputs, recovery)
      input.managers.set(conversationId, manager)
      modes.set(conversationId, fileInputs)
      return manager
    }
    if (configuration.harnessProfileSelection) {
      if (!input.createSelected) throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'Selected Operator profile admission is not composed.', 409)
      const manager = input.createSelected(configuration, conversationId, fileInputs, recovery)
      input.managers.set(conversationId, manager); modes.set(conversationId, fileInputs)
      return manager
    }
    const selection = input.selectInstallation?.(configuration)
    const accountBinding = input.accountBinding?.(conversationId)
    const { manager } = factories.allocate({
      ...(accountBinding ? { accountBinding } : {}),
      ...(selection ? { selection } : {}),
      role: 'operator', workingDirectory: input.workingDirectory, ownerAgentId: configuration.operatorId,
      configured: { instanceId: selection?.instance.instanceId ?? configuration.operatorId, instanceRevision: configuration.id, driverId: configuration.harness.harness,
        enabled: true, configuration: configuration.harness },
      processRecovery: recovery, appMcpAccess: 'scoped',
      harness: 'codex',
      ...(fileInputs ? {
        chatFiles: productionCodexChatFiles(input.app, conversationId, operatorCodexFileAdmissions(input.app, input.pool,
          configuration, input.workingDirectory, input.config.fileStorageRoot ?? defaultFileStorageRoot())),
      } : {}),
    })
    input.managers.set(conversationId, manager)
    modes.set(conversationId, fileInputs)
    return manager
  }
  resolver.release = (id) => { input.managers.delete(id); modes.delete(id) }
  resolver.closeRecoveredRuntime = (id, signal) => input.processRegistry.closeOwner(`conversation:${id}`, signal)
  resolver.hasFileInputs = (id, requestId) => operatorTurnHasFileInputs(input.pool, id, requestId)
  const submissions = new PostgresOperatorConversationRepository(input.pool)
  resolver.recordFileMessageSubmission = async (id, requestId, receipt) => {
    // The existing service saved this actual message ACK before invoking the
    // file barrier. Its exact idempotent receipt confirms the same binding;
    // no message UUID is written into a native-turn column.
    if (!await submissions.submittedMessage(id, requestId, receipt)) throw new DomainError('OPERATOR_FILE_SUBMISSION_MISMATCH',
      'The observed native message does not match the accepted Operator file command.', 409)
    const linked = await input.pool.query(`update operator_conversation_turns t set message_id=m.id
      from operator_conversations c,operator_conversation_messages m
      where c.id=$1 and c.kind='operator' and c.harness='claude' and c.deleted_at is null
        and c.active_request_id=$2 and c.native_session_id=$4 and not c.cancel_requested
        and t.conversation_id=c.id and t.request_id=$2 and t.native_turn_id is null
        and t.payload->'nativeSubmission'=$3::jsonb and t.payload->>'attachmentIdentity' is not null
        and m.conversation_id=c.id and m.client_request_id=t.request_id and m.role='user'
        and (t.message_id is null or t.message_id=m.id)`, [id, requestId, JSON.stringify(receipt), receipt.nativeSessionId])
    if (linked.rowCount !== 1) throw new DomainError('OPERATOR_FILE_SUBMISSION_MISMATCH', 'The file acknowledgement has no original Operator message binding.', 409)
  }
  resolver.recordFileSubmission = (id, requestId, nativeTurnId) => recordOperatorFileSubmission(input.pool, id, requestId, nativeTurnId)
  return resolver
}
