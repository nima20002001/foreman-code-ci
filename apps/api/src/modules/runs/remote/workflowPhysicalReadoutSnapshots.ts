import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { DEVICE_JSON_CONTINUATION_LIMIT } from '@foreman-code/contracts/device-application'
import type { RemoteExecutionRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { RemoteWorkflowPhysicalReadout } from '@foreman-code/contracts/remote-workflow-physical'
import { DomainError } from '../../errors.js'

export type PhysicalReadoutSelector = Pick<Extract<RemoteExecutionRpcRequest, { method: 'physical-readout' }>,
  'intent' | 'placement' | 'receiptSequence' | 'sourceDigest'>

function selectorHash(input: PhysicalReadoutSelector) {
  const { intent, placement, receiptSequence, sourceDigest } = input
  return commandInputHash({ intent, placement, receiptSequence, sourceDigest })
}

/** Paging holds the observation served on the first page, including its verification window. */
export class WorkflowPhysicalReadoutSnapshots {
  private readonly snapshots = new Map<string, {
    operationId: string
    selector: string
    originalSelector: string
    readout: RemoteWorkflowPhysicalReadout
    bytes: number
    expiresAt: number
  }>()
  private bytes = 0

  constructor(private readonly now: () => number = () => Date.now()) {}

  private remove(key: string) {
    const snapshot = this.snapshots.get(key)
    if (!snapshot) return
    this.bytes -= snapshot.bytes
    this.snapshots.delete(key)
  }

  remember(input: PhysicalReadoutSelector, readout: RemoteWorkflowPhysicalReadout,
    metadata: { digest: string; byteSize: number }, options: {
      cleanup?: boolean; original?: PhysicalReadoutSelector
    } = {}) {
    for (const [key, snapshot] of this.snapshots) {
      if (snapshot.expiresAt <= this.now()) this.remove(key)
    }
    const selector = selectorHash(input)
    const key = `${selector}:${metadata.digest}`
    if (this.snapshots.has(key)) return
    while (this.bytes + metadata.byteSize > DEVICE_JSON_CONTINUATION_LIMIT * 4 || this.snapshots.size >= 128) {
      const oldest = options.cleanup && [...this.snapshots].find(([, snapshot]) =>
        snapshot.operationId === input.intent.operationId)
      if (!oldest) throw new DomainError('REMOTE_NATIVE_PHYSICAL_BACKPRESSURE',
        'Physical readout retention is full of replies being paged.', 503)
      this.remove(oldest[0])
    }
    this.snapshots.set(key, { operationId: input.intent.operationId, selector, readout,
      originalSelector: selectorHash(options.original ?? input),
      bytes: metadata.byteSize, expiresAt: Date.parse(readout.expiresAt) })
    this.bytes += metadata.byteSize
  }

  read(input: PhysicalReadoutSelector, digest: string): RemoteWorkflowPhysicalReadout {
    const key = `${selectorHash(input)}:${digest}`
    const snapshot = this.snapshots.get(key)
    if (!snapshot || snapshot.expiresAt <= this.now()) {
      this.remove(key)
      throw new DomainError('transfer-expired', 'The physical readout continuation is no longer retained.', 409)
    }
    return snapshot.readout
  }

  forget(input: PhysicalReadoutSelector) {
    const selector = selectorHash(input)
    for (const [key, snapshot] of this.snapshots) {
      if (snapshot.selector === selector || snapshot.originalSelector === selector) this.remove(key)
    }
  }

  purge(operationId: string) {
    for (const [key, snapshot] of this.snapshots) {
      if (snapshot.operationId === operationId) this.remove(key)
    }
  }

  clear() {
    this.snapshots.clear()
    this.bytes = 0
  }
}
