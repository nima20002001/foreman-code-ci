import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import { beforeEach, expect, it, vi } from 'vitest'
import type { RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import type { AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import { ExclusiveGraphConnection } from '../run-graph/connection.js'
import type { RunOwnership } from '../runs/ownership.js'
import { VerifiedRemoteEvidence } from '../runs/remote/resultBridge.js'
import { OwnedRemoteReceiptCommit } from './remoteReceiptCommit.js'

const readers = vi.hoisted(() => ({ intent: vi.fn(), placement: vi.fn() }))
vi.mock('./persistence.js', () => ({ readAcceptedPlacement: readers.placement }))
vi.mock('../runs/remote/persistence.js', async importOriginal => ({
  ...await importOriginal<typeof import('../runs/remote/persistence.js')>(),
  readReconciledDispatchIntent: readers.intent,
}))
beforeEach(() => vi.resetAllMocks())

function fixture() {
  const connection = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 }
  const receipt: RemoteOperationReceipt = {
    schemaVersion: 1, intent: { schemaVersion: 1, protocolVersion: 1, mainId: connection.mainId,
      runId: 'run', nodeId: 'node', executionId: 'execution', operationId: 'operation',
      occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1, attemptId: 'attempt',
      bindingHash: 'a'.repeat(64), inputDigest: `sha256:${'b'.repeat(64)}`, owner: { grantId: 'grant', epoch: '1' } },
    connection, workerIncarnationId: randomUUID(), sequence: 1, phase: 'received',
    entryAttempted: false, turnEntryAttempted: false, stopFence: false, controls: [],
  }
  readers.intent.mockResolvedValue(receipt.intent)
  readers.placement.mockResolvedValue({ mainId: connection.mainId, bindingHash: receipt.intent.bindingHash,
    hostRef: { kind: 'device', mainId: connection.mainId, deviceId: connection.deviceId },
    registration: { workerInstallationId: connection.workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
  } as AcceptedNodePlacement)
  let staged: RemoteOperationReceipt | undefined
  let committed: RemoteOperationReceipt | undefined
  const query = async (text: string, values: unknown[] = []) => {
    if (text.startsWith('select record from execution_dispatch_intents')) return { rows: [{ record: receipt.intent }], rowCount: 1 }
    if (text === 'commit') committed = staged
    if (text === 'rollback') staged = committed
    if (text.includes('from remote_dispatch_origins')) return { rows: [{ connection }], rowCount: 1 }
    if (text.includes('from remote_execution_receipts')) return { rows: staged ? [{ receipt: staged }] : [], rowCount: staged ? 1 : 0 }
    if (text.startsWith('insert into remote_execution_receipts')) staged = JSON.parse(String(values[2]))
    return { rows: [], rowCount: 0 }
  }
  const db = new ExclusiveGraphConnection({ query } as unknown as pg.ClientBase, () => {})
  const owner = { runId: 'run', assertOwned() {}, oneShotConnection: () => db,
    readOneShotFence: async () => ({ ownerId: 'owner', fence: '1' }) } as unknown as RunOwnership
  let revoked = false
  const domain = {
    assertCurrent: vi.fn(async () => { if (revoked) throw new Error('authority revoked') }),
    publishNative: vi.fn(async () => {}),
  }
  const port = new OwnedRemoteReceiptCommit(owner, receipt, connection, domain)
  return { receipt, connection, domain, db, port, committed: () => committed, revoke: () => { revoked = true } }
}

it('checks live receipt authority once at load and once at commit', async () => {
  const f = fixture()
  try {
    expect(await VerifiedRemoteEvidence.commit(f.receipt, f.connection, f.port)).toBe('accepted')
    expect(f.committed()).toEqual(f.receipt)
    expect(f.domain.assertCurrent).toHaveBeenCalledTimes(2)
    expect(f.domain.publishNative).toHaveBeenCalledOnce()
  } finally { await f.db.close() }
})

it('rolls back when publication changes authority before commit', async () => {
  const f = fixture()
  f.domain.publishNative.mockImplementation(async () => { f.revoke() })
  try {
    await expect(VerifiedRemoteEvidence.commit(f.receipt, f.connection, f.port)).rejects.toThrow('authority revoked')
    expect(f.committed()).toBeUndefined()
  } finally { await f.db.close() }
})
