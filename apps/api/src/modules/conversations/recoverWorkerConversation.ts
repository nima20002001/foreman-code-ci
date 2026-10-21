import { assertWorkerProviderAccountBinding } from '../provider-accounts/workerOperations.js'
import { isDeepStrictEqual } from 'node:util'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { WorkerConversationConfiguration, WorkerConversationReceipt,
  WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import type { WorkerConversationAllocation } from './workerHost.js'
import type { WorkerConversationJournal } from './workerJournal.js'
import { closedWorkerConversationOwner } from './closedWorkerConversation.js'
import { DomainError } from '../errors.js'
import { sameConversationForAppAccess } from './conversationAppAccess.js'
import { readWorkerConversationResults } from './workerConversationResults.js'
import { validWorkerConfigurationTransition } from './workerConfigurationTransition.js'

function unavailable(message: string): never {
  throw new DomainError('WORKER_CONVERSATION_RECOVERY_REQUIRED', message, 409)
}

/** Reopens the persisted session after positive process closure, without sending a model input. */
export async function recoverWorkerConversation(input: {
  record: WorkerConversationReceipt
  configuration: WorkerConversationConfiguration
  connection: Readonly<DeviceSessionBinding>
  request: WorkerConversationRpcRequest
  registry: Pick<NativeProcessRegistry, 'snapshot' | 'closeOwner'>
  journal: WorkerConversationJournal
  allocate(): Promise<WorkerConversationAllocation>
  assertCurrent(): Promise<void>
  signal: AbortSignal
}): Promise<WorkerConversationAllocation> {
  const { record, signal } = input
  signal.throwIfAborted()
  const session = record.session
  const owner = record.nativeOwner
  const request = input.request
  const changingAccess = request.method === 'conversation.open' && request.previousBinding
    && isDeepStrictEqual(request.previousBinding, record.binding)
    && sameConversationForAppAccess(record.binding, request.binding)
    && record.applicationAccessChange?.state === 'reserved'
    && record.applicationAccessChange.operationId === request.operationId
    && record.applicationAccessChange.next === request.binding.appMcpAccess
  const changingSkills = request.method === 'conversation.open' && request.mode === 'attach'
    && request.previousBinding && request.previousConfiguration
    && isDeepStrictEqual(request.previousBinding, record.binding)
    && isDeepStrictEqual(request.source, session)
    && validWorkerConfigurationTransition(record.binding, request.binding, request.previousConfiguration, input.configuration)
  const settlingSkills = request.method === 'conversation.open' && request.mode === 'attach'
    && request.previousBinding && request.previousConfiguration
    && isDeepStrictEqual(request.previousBinding, record.binding)
    && isDeepStrictEqual(request.source, session)
    && isDeepStrictEqual(input.configuration, request.previousConfiguration)
    && validWorkerConfigurationTransition(record.binding, request.binding, input.configuration, request.configuration)
  const targetBinding = changingAccess || changingSkills ? request.binding : record.binding
  if (!session || !owner || !record.creation || record.closing || record.closed) {
    unavailable('The persisted chat has no recoverable native session.')
  }
  if (commandInputHash(input.configuration) !== targetBinding.owner.configurationHash
    || input.configuration.harness.harness !== session.harness || owner.sessionId !== session.nativeSessionId
    || !isDeepStrictEqual(request.binding, record.binding) && !changingAccess && !changingSkills && !settlingSkills) {
    unavailable('The saved conversation configuration or native session changed.')
  }
  for (const field of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const) {
    if (record.connection[field] !== input.connection[field]) unavailable('The original paired worker authority changed.')
  }
  assertWorkerProviderAccountBinding(record.binding.accountBinding, input.connection)
  const scopeOwner = closedWorkerConversationOwner(record, input.registry)
  await input.assertCurrent()
  if (record.turns.some(turn => !['completed', 'rejected'].includes(turn.status) && !turn.nativeTurnId && !turn.nativeSubmission)
    || record.compactions.some(control => !['completed', 'failed', 'no-op'].includes(control.state.status)
      && control.state.dispatchPhase !== 'dispatched')) {
    unavailable('The outstanding native input has no persisted dispatch identity; it will not be replayed.')
  }
  if (!await input.registry.closeOwner(scopeOwner, signal)) {
    unavailable('The original native chat process is still closing.')
  }
  const allocation = await input.allocate()
  try {
    const requestedPreferences = 'preferences' in input.request ? input.request.preferences : undefined
    const preferences = requestedPreferences ?? record.desiredPreferences
    if (preferences) await allocation.manager.configureSessionPreferences?.(preferences)
    const access = 'applicationAccess' in input.request ? input.request.applicationAccess : undefined
    const start = await allocation.start({ correlationId: record.creation.operationId, instructionsDelivered: true,
      ...(access ? { applicationAccess: access } : {}) })
    if (session.harness === 'codex' && start.kind === 'operator'
      && targetBinding.appMcpAccess === 'scoped' && !access) {
      start.observationOnly = true
      allocation.observationOnly = true
    }
    const attached = await allocation.manager.attachSession(session, start, signal)
    if (!isDeepStrictEqual(attached, session)) unavailable('Native recovery returned another session.')
    const { recoveredTurns, recoveredCompactions } = await readWorkerConversationResults(record,
      allocation.manager, signal, allocation.manager.readCompaction
        ? state => allocation.manager.readCompaction!(session, start, state, signal) : undefined)
    signal.throwIfAborted()
    await input.assertCurrent()
    for (const turn of recoveredTurns) await input.journal.finishTurn(record.binding, turn.correlationId, turn.result)
    for (const state of recoveredCompactions) await input.journal.compactProgress(record.binding, state)
    await input.journal.recoveredOwner(record.binding, input.connection, owner, await allocation.nativeOwner(session),
      changingAccess || changingSkills ? { targetBinding,
        ...(changingSkills && request.method === 'conversation.open' && request.previousConfiguration
          ? { previousConfiguration: request.previousConfiguration, configuration: input.configuration } : {}) } : undefined)
    if (preferences) await input.journal.preferences(targetBinding, preferences,
      allocation.manager.appliedSessionPreferences?.(session) ?? null)
    return allocation
  } catch (error) {
    try { await allocation.close() }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Native recovery and cleanup failed.', { cause: cleanup }) }
    throw error
  }
}
