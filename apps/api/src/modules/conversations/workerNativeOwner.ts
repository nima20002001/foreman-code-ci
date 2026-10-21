import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { WorkerConversationBinding, WorkerConversationReceipt } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeLaunchObservation, NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import { DomainError } from '../errors.js'

export function workerConversationProcessDigest(binding: WorkerConversationBinding, launch: NativeLaunchObservation) {
  return commandInputHash({ owner: launch.owner, binding, launchId: launch.launchId, bootId: launch.bootId,
    guardian: launch.guardian, provider: launch.provider, boundary: launch.boundary }).slice('sha256:'.length)
}

export async function closeRecoveredWorkerSession(record: WorkerConversationReceipt,
  registry: Pick<NativeProcessRegistry, 'snapshot' | 'closeOwner'> & Partial<Pick<NativeProcessRegistry, 'closedRegistration'>>,
  signal: AbortSignal) {
  signal.throwIfAborted()
  const owner = `conversation:${record.binding.owner.conversationId}`
  const launches = registry.snapshot().launches.filter(launch => launch.owner === owner)
  const closed = registry.closedRegistration?.(owner)
  if (closed && !launches.some(launch => launch.launchId === closed.launchId)) launches.push(closed)
  const original = launches.filter(launch => record.nativeOwner
    && workerConversationProcessDigest(record.binding, launch) === record.nativeOwner.processIdentityDigest)
  if (!record.session || record.nativeOwner?.sessionId !== record.session.nativeSessionId || original.length !== 1
    || launches.some(launch => launch.lifecycle === 'active' && launch !== original[0])
    || launches.some(launch => launch.lifecycle === 'closed' && !launch.closureEvidence)) {
    throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE', 'The previous native process identity changed.', 409)
  }
  if (!await registry.closeOwner(owner, signal)) throw new DomainError(
    'WORKER_CONVERSATION_UNAVAILABLE', 'The previous native process closure is unconfirmed.', 409)
}
