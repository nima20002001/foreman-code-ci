import { isDeepStrictEqual } from 'node:util'
import { commandInputHash } from './commandIdentityNode.js'
import { RemoteEntryClosureSchema, type RemoteEntryClosure } from './remoteExecutionEntryClosure.js'
import type { RemoteOperationReceipt } from './remoteExecution.js'
import type { DispatchIntent } from './nodePlacement.js'

export function remoteEntryClosureDigest(closure: RemoteEntryClosure): string {
  return commandInputHash(RemoteEntryClosureSchema.parse(closure)).slice('sha256:'.length)
}

export function hasPositiveRemoteEntryClosure(receipt: RemoteOperationReceipt): boolean {
  const closure = receipt.terminal?.entryClosure
  if (!closure || receipt.native || !receipt.entryAttempted || receipt.turnEntryAttempted || !receipt.stopFence
    || receipt.terminal?.kind !== 'cancelled' || receipt.terminal.result || receipt.terminal.resultDigest
    || (receipt.terminal.artifactDigests?.length ?? 0) !== 0) return false
  const original = { ...receipt.intent, owner: closure.intent.owner }
  return isDeepStrictEqual(closure.intent, original) && isDeepStrictEqual(closure.connection, receipt.connection)
    && receipt.terminal.closureEvidenceDigest === remoteEntryClosureDigest(closure)
}

export function remoteNonEntryClosureDigest(intent: DispatchIntent): string {
  return commandInputHash({ intent, nativeEntryAttempted: false }).slice('sha256:'.length)
}

export function hasPositiveRemoteNonEntryClosure(receipt: RemoteOperationReceipt): boolean {
  const terminal = receipt.terminal
  return !!terminal && terminal.kind === 'not_started' && !receipt.entryAttempted && !receipt.turnEntryAttempted
    && !receipt.native && receipt.stopFence && !terminal.result && !terminal.resultDigest && !terminal.entryClosure
    && (terminal.artifactDigests?.length ?? 0) === 0
    && terminal.closureEvidenceDigest === remoteNonEntryClosureDigest(receipt.intent)
}
