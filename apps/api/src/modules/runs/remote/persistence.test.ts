import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import { ExclusiveGraphConnection } from '../../run-graph/connection.js'
import type { RunOwnership } from '../ownership.js'
import { VerifiedRemoteEvidence, type RemoteCommitFacts, type RemoteResultCommitPort } from './resultBridge.js'
import { persistVerifiedRemoteReceipt } from './persistence.js'
const digest = 'a'.repeat(64), mainId = randomUUID(), deviceId = randomUUID()
const connection = { mainId, deviceId, workerInstallationId: randomUUID(), bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 }
const receipt: RemoteOperationReceipt = { schemaVersion: 1, intent: { schemaVersion: 1, protocolVersion: 1, mainId, runId: 'run', nodeId: 'node', executionId: 'execution', occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation', bindingHash: digest, inputDigest: `sha256:${digest}`, owner: { grantId: 'grant', epoch: '1' } }, connection, workerIncarnationId: randomUUID(), sequence: 1, phase: 'received', entryAttempted: false, turnEntryAttempted: false, stopFence: false, controls: [] }
/** Real transaction/finalizer ordering; SQL constraints and DB/process loss need root integration. */
function fixture(revokeAtCommit: boolean) {
  let committed: RemoteOperationReceipt | undefined, staged: RemoteOperationReceipt | undefined, checks = 0
  const raw = { query: async (text: string, values: unknown[] = []) => {
    if (text.startsWith('begin')) staged = committed
    if (text === 'commit') committed = staged
    if (text === 'rollback') staged = committed
    if (text.startsWith('select record from execution_dispatch_intents')) return { rows: [{ record: receipt.intent }], rowCount: 1 }
    if (text.startsWith('select transition')) return { rows: [], rowCount: 0 }
    if (text.startsWith('select receipt')) return { rows: staged ? [{ receipt: staged }] : [], rowCount: staged ? 1 : 0 }
    if (text.startsWith('insert into remote_execution_receipts')) staged = JSON.parse(values[2] as string) as RemoteOperationReceipt
    return { rows: [], rowCount: 0 }
  } } as unknown as pg.ClientBase
  const db = new ExclusiveGraphConnection(raw, () => {})
  const owner = { runId: 'run', assertOwned: () => {}, readOneShotFence: async () => ({ ownerId: 'unit-owner', fence: 'unit-fence' }) } as unknown as RunOwnership
  const authority = { intent: receipt.intent, placement: { hostRef: { kind: 'device', mainId, deviceId }, bindingHash: digest, registration: { workerInstallationId: connection.workerInstallationId, keyRevision: 1, authorizationRevision: 1 } }, originalConnection: connection, originalIncarnationId: receipt.workerIncarnationId, grantIsLive: true, lastSequence: 0, lastReceipt: null, terminal: null, native: null } as RemoteCommitFacts
  const port: RemoteResultCommitPort = { transaction: (_operation, work) => db.transaction(sql => work({ authority: async () => authority, reject: async () => {}, accept: verified => persistVerifiedRemoteReceipt(sql, owner, verified, async () => { if (++checks === 2 && revokeAtCommit) throw new Error('revoked before COMMIT') }) })) }
  return { db, port, committed: () => committed, checks: () => checks }
}
describe('main remote receipt durability', () => {
  it('uses the existing transaction and revalidates live authority immediately before commit', async () => { const f = fixture(false); expect(await VerifiedRemoteEvidence.commit(receipt, connection, f.port)).toBe('accepted'); expect(f.committed()).toEqual(receipt); expect(f.checks()).toBe(2); await f.db.close() })
  it('rolls back receipt staging when a grant is revoked after the acceptance callback', async () => { const f = fixture(true); await expect(VerifiedRemoteEvidence.commit(receipt, connection, f.port)).rejects.toThrow('revoked before COMMIT'); expect(f.committed()).toBeUndefined(); await f.db.close() })
})
