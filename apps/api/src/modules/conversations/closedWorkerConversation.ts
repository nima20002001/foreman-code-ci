import type { WorkerConversationReceipt } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeProcessRegistry, NativeLaunchObservation } from '../harnesses/recovery/processRegistry.js'
import { DomainError } from '../errors.js'
import { workerConversationProcessDigest } from './workerNativeOwner.js'

/** Confirms the journaled native owner and every launch in its process scope are closed. */
export function closedWorkerConversationOwner(record: WorkerConversationReceipt,
  registry: Pick<NativeProcessRegistry, 'snapshot'>, closed?: NativeLaunchObservation): string {
  const session = record.session
  const nativeOwner = record.nativeOwner
  if (!session || !nativeOwner || nativeOwner.sessionId !== session.nativeSessionId) {
    throw new DomainError('WORKER_CONVERSATION_RECOVERY_REQUIRED', 'The persisted chat has no native process identity.', 409)
  }
  const owner = `conversation:${record.binding.owner.conversationId}`
  const launches = registry.snapshot().launches.filter(launch => launch.owner === owner)
  if (closed && !launches.some(launch => launch.launchId === closed.launchId)) launches.push(closed)
  const original = launches.filter(launch => launch.guardian && launch.provider && launch.boundary
    && workerConversationProcessDigest(record.binding, launch) === nativeOwner.processIdentityDigest)
  if (original.length !== 1 || !launches.length
    || launches.some(launch => launch.lifecycle !== 'closed' || !launch.closureEvidence)) {
    throw new DomainError('WORKER_CONVERSATION_RECOVERY_REQUIRED',
      'The original native process has not been positively closed.', 409)
  }
  return owner
}
