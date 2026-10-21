import { isDeepStrictEqual } from 'node:util'
import type { DeviceConnectionIdentity } from '@foreman-code/contracts/device-identity'
import type { DispatchIntent, AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import { RemoteOperationReceiptSchema, remoteNativeContinues, type RemoteOperationReceipt, type RemoteNativeIdentity, type RemoteTerminalEvidence } from '@foreman-code/contracts/remote-execution'
import { hasPositiveRemoteEntryClosure, hasPositiveRemoteNonEntryClosure } from '@foreman-code/contracts/remote-execution-entry-closure-node'

export interface RemoteCommitFacts {
  intent: DispatchIntent
  placement: AcceptedNodePlacement
  originalConnection: DeviceConnectionIdentity
  originalIncarnationId: string
  /** Evaluated by main in the same transaction as canonical acceptance/edge publication. */
  grantIsLive: boolean
  lastSequence: number
  lastReceipt: RemoteOperationReceipt | null
  native: RemoteNativeIdentity | null
  terminal: RemoteTerminalEvidence | null
}
export interface RemoteResultTransaction {
  authority(operationId: string): Promise<RemoteCommitFacts | null>
  /** Bounded audit evidence only; cannot mutate execution state or schedule a node. */
  reject(receipt: RemoteOperationReceipt, reason: string): Promise<void>
  /** Canonical writer receives correlated evidence, never a trusted native capture cast. */
  accept(evidence: VerifiedRemoteEvidence): Promise<void>
  /** Retain an authenticated duplicate source without another canonical mutation. */
  retain?(evidence: VerifiedRemoteEvidence): Promise<void>
}
export interface RemoteResultCommitPort {
  transaction<T>(operationId: string, work: (transaction: RemoteResultTransaction) => Promise<T>): Promise<T>
}
export class VerifiedRemoteEvidence {
  private constructor(readonly receipt: RemoteOperationReceipt, readonly authority: RemoteCommitFacts) {}
  static async commit(raw: unknown, authenticatedConnection: DeviceConnectionIdentity, port: RemoteResultCommitPort) {
    const receipt = RemoteOperationReceiptSchema.parse(raw)
    return port.transaction(receipt.intent.operationId, async transaction => {
      const authority = await transaction.authority(receipt.intent.operationId)
      const reason = rejectionReason(receipt, authenticatedConnection, authority)
      if (reason) {
        // An identical committed terminal report converges without another publication.
        if (reason === 'stale_sequence' && authority?.lastReceipt && isDeepStrictEqual(receipt, authority.lastReceipt)) { await transaction.retain?.(new VerifiedRemoteEvidence(structuredClone(receipt), authority)); return 'duplicate' as const }
        if (reason === 'stale_sequence' && authority?.terminal != null
          && receipt.phase === 'confirmed_terminal' && isDeepStrictEqual(receipt.terminal, authority.terminal)) return 'duplicate' as const
        await transaction.reject(receipt, reason)
        return 'rejected' as const
      }
      if (!authority) throw new Error('Authority disappeared')
      await transaction.accept(new VerifiedRemoteEvidence(structuredClone(receipt), authority))
      return 'accepted' as const
    })
  }
}

function rejectionReason(receipt: RemoteOperationReceipt, authenticated: DeviceConnectionIdentity,
  authority: RemoteCommitFacts | null): string | null {
  if (!authority) return 'unknown_operation'
  if (!authority.grantIsLive) return 'revoked_grant'
  if (!sameRegisteredWorker(receipt.connection, authenticated)) return 'unauthenticated_connection'
  if (!isDeepStrictEqual(receipt.connection, authority.originalConnection)
    || receipt.workerIncarnationId !== authority.originalIncarnationId) return 'wrong_original_execution'
  if (!isDeepStrictEqual(receipt.intent, authority.intent)) return 'stale_binding_or_owner'
  const placement = authority.placement
  if (placement.hostRef.kind !== 'device' || placement.hostRef.deviceId !== receipt.connection.deviceId
    || placement.bindingHash !== receipt.intent.bindingHash
    || placement.registration?.workerInstallationId !== receipt.connection.workerInstallationId
    || placement.registration?.keyRevision !== receipt.connection.keyRevision
    || placement.registration?.authorizationRevision !== receipt.connection.authorizationRevision) return 'wrong_placement'
  if (authority.native !== null && !remoteNativeContinues(authority.native, receipt, authority.lastReceipt?.nativeTurnRetries)) return 'conflicting_native'
  if (authority.terminal !== null && !isDeepStrictEqual(receipt.terminal, authority.terminal)) return 'conflicting_terminal'
  const entryClosed = hasPositiveRemoteEntryClosure(receipt)
  const notStarted = hasPositiveRemoteNonEntryClosure(receipt)
  if (receipt.terminal?.entryClosure && !entryClosed) return 'invalid_entry_closure'
  if (receipt.terminal?.kind === 'not_started' && !notStarted) return 'non_entry_not_proven'
  if (receipt.phase === 'confirmed_terminal' && (!receipt.terminal || !receipt.native && !entryClosed && !notStarted)) {
    return 'missing_native_closure'
  }
  if (receipt.sequence <= authority.lastSequence) return 'stale_sequence'
  return null
}

function sameRegisteredWorker(a: DeviceConnectionIdentity, b: DeviceConnectionIdentity) {
  return a.mainId === b.mainId && a.deviceId === b.deviceId && a.workerInstallationId === b.workerInstallationId
    && a.keyRevision === b.keyRevision && a.authorizationRevision === b.authorizationRevision
}

