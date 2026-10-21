import type pg from 'pg'
import { randomUUID, createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { fileToolFixture } from '../../../../test/support/fileTools.js'
import { bindingIdentity } from '../../files/tools/context.js'
import type { DistributedPublicationLink } from '../../files/distributed/publicationLedger.js'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { DomainError } from '../../errors.js'
import { NativeArtifactOutputSchema } from './nativeArtifactOutputs.js'
import { PostgresNativeArtifactOutputRepository } from './nativeArtifactOutputPostgres.js'

async function fixture() {
  const f = await fileToolFixture(), mainId = randomUUID(), sha256 = 'a'.repeat(64), transferId = randomUUID()
  if (f.scope.chat.kind !== 'agent') throw new Error('fixture')
  f.scope.chat.executionId = randomUUID()
  const producer = { workspaceId: 'workspace-a', workflowId: 'workflow-a', runId: 'run-a', nodeId: 'producer', executionId: f.scope.chat.executionId,
    attemptId: randomUUID(), placementHash: 'b'.repeat(64) }
  const record = NativeArtifactOutputSchema.parse({ version: 1, producer, outputKey: 'report', commandId: 'original-command',
    nativeIdentity: { nativeSessionId: f.context.nativeSessionId, turnId: f.context.turnId },
    publication: { ownerPrincipalId: f.principal.id, requestId: 'original-publication', binding: bindingIdentity(f.context) },
    pins: { fileId: randomUUID(), revisionId: randomUUID(), sha256, byteSize: 123 }, scope: f.scope,
    transferReceipt: { version: 1, receiptId: randomUUID(), transferId, sha256, byteSize: 123, verifiedAt: new Date().toISOString(),
      intent: { version: 1, mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
        bootId: randomUUID(), connectionEpoch: randomUUID(), transferId, operationId: randomUUID(), executionId: producer.executionId,
        attemptId: producer.attemptId, placementHash: producer.placementHash, rootId: randomUUID(), rootBindingRevision: 1,
        direction: 'to-main', byteClass: 'artifact', sha256, byteSize: 123, manifestDigest: 'c'.repeat(64), chunkBytes: 1024,
        expiresAt: '2099-01-01T00:00:00.000Z' } } })
  type Row = { principal_id: string; command_id: string; target_key: string; input_hash: string; result: unknown }
  const link: DistributedPublicationLink = { ...record.publication, context: f.context, ref: { fileId: record.pins.fileId, revisionId: record.pins.revisionId },
    transferReceipt: record.transferReceipt, publicationInputHash: 'original-input', createdAt: new Date().toISOString() }
  const state = { row: undefined as Row | undefined, link, expired: false, missing: false, audits: 0, loseAck: false, committed: false,
    queries: [] as string[] }
  let before: Row | undefined
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    state.queries.push(sql)
    let rows: unknown[] = [], count = 0
    if (sql === 'select pg_backend_pid() as pid') rows = [{ pid: 123 }]
    else if (sql.startsWith('begin')) { before = structuredClone(state.row); state.committed = false }
    else if (sql === 'commit') { state.committed = true; if (state.loseAck) { state.loseAck = false; throw new Error('COMMIT acknowledgment lost') } }
    else if (sql === 'rollback') { if (!state.committed) state.row = before }
    else if (sql.includes('select p.record from file_tool_publications')) rows = state.missing ? [] : [{ record: state.link }]
    else if (sql.startsWith('select file_id from files')) rows = state.expired ? [] : [{ file_id: record.pins.fileId }]
    else if (sql.startsWith('insert into management_command_receipts')) {
      if (!state.row) { state.row = { principal_id: args[0] as string, command_id: args[2] as string, target_key: args[3] as string,
        input_hash: args[4] as string, result: JSON.parse(args[5] as string) }; count = 1 }
    } else if (sql.startsWith('insert into management_audit')) { state.audits++; count = 1 }
    else if (sql.includes('from management_command_receipts')) rows = state.row ? [state.row] : []
    return { rows, rowCount: rows.length || count, command: '', oid: 0, fields: [] }
  })
  const client = { query, on: vi.fn(), removeListener: vi.fn(), release: vi.fn() }
  const pool = { connect: vi.fn(async () => client), query } as unknown as pg.Pool
  const repository = new PostgresNativeArtifactOutputRepository(pool, mainId), authorize = vi.fn(async () => {})
  return { record, mainId, link, state, pool, repository, authorize, client }
}
describe('original output mapping in the existing command ledger', () => {
  it('commits exact canonical pins with audit and rechecks authority before COMMIT, including replay', async () => {
    const t = await fixture()
    expect(await t.repository.bind(t.record, t.authorize)).toEqual(t.record)
    expect(t.authorize).toHaveBeenCalledTimes(2)
    expect(t.state.audits).toBe(1)
    expect(t.state.row?.target_key).toBe(JSON.stringify([t.mainId, t.record.producer.executionId, t.record.producer.attemptId, 'report']))
    expect(t.state.queries.some(sql => sql.includes('for update of f'))).toBe(true)
    expect(await t.repository.bind(t.record, t.authorize)).toEqual(t.record)
    expect(t.authorize).toHaveBeenCalledTimes(4); expect(t.state.audits).toBe(1)
    expect(await new PostgresNativeArtifactOutputRepository(t.pool, t.mainId).read(t.record.producer, 'report')).toEqual(t.record)
  })
  it('recovers a committed mapping after lost ACK without second insertion or audit', async () => {
    const t = await fixture(); t.state.loseAck = true
    await expect(t.repository.bind(t.record, t.authorize)).rejects.toThrow('acknowledgment lost')
    expect(await new PostgresNativeArtifactOutputRepository(t.pool, t.mainId).bind(t.record, t.authorize)).toEqual(t.record)
    expect(t.state.audits).toBe(1)
  })
  it.each(['command', 'publication', 'native', 'pins', 'producer'] as const)('rejects changed %s for the original slot', async field => {
    const t = await fixture(); await t.repository.bind(t.record, t.authorize)
    const changed = structuredClone(t.record)
    if (field === 'command') changed.commandId = 'replacement-command'
    if (field === 'publication') changed.publication.requestId = 'replacement-publication'
    if (field === 'native') changed.nativeIdentity.turnId = 'replacement-turn'
    if (field === 'pins') changed.pins.revisionId = randomUUID()
    if (field === 'producer') changed.producer.nodeId = 'replacement-node'
    await expect(t.repository.bind(changed, t.authorize)).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_OUTPUT_CONFLICT' })
    expect(t.state.row?.result).toEqual(t.record)
  })
  it.each(['main', 'attempt', 'direction', 'scope'] as const)('rejects wrong %s ownership before SQL', async field => {
    const t = await fixture(), changed = structuredClone(t.record)
    if (field === 'main') changed.transferReceipt.intent.mainId = randomUUID()
    if (field === 'attempt') changed.transferReceipt.intent.attemptId = randomUUID()
    if (field === 'direction') changed.transferReceipt.intent.direction = 'to-worker'
    if (field === 'scope' && changed.scope.kind === 'temporary' && changed.scope.chat.kind === 'agent') changed.scope.chat.runId = 'another-run'
    await expect(t.repository.bind(changed, t.authorize)).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_OUTPUT_CONFLICT' })
    expect(t.pool.connect).not.toHaveBeenCalled()
  })
  it('rolls back if authority is revoked or retention expires after insertion, and rechecks retries', async () => {
    const t = await fixture()
    t.authorize.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { throw new DomainError('AUTH_REVOKED', 'revoked', 403) })
    await expect(t.repository.bind(t.record, t.authorize)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    expect(t.state.row).toBeUndefined(); expect(t.state.queries.at(-1)).toBe('rollback')
    t.authorize.mockImplementation(async () => {})
    await t.repository.bind(t.record, t.authorize)
    t.state.expired = true
    await expect(t.repository.bind(t.record, t.authorize)).rejects.toMatchObject({ code: 'FILE_BYTES_UNAVAILABLE' })
    expect(t.state.row?.result).toEqual(t.record)
  })
  it.each(['receipt', 'binding', 'missing'] as const)('rejects invalid canonical %s evidence', async field => {
    const t = await fixture()
    if (field === 'receipt') t.state.link.transferReceipt = { ...t.record.transferReceipt, receiptId: randomUUID() }
    if (field === 'binding') t.state.link.context = { ...t.state.link.context, nativeSessionId: 'another-session' }
    if (field === 'missing') t.state.missing = true
    await expect(t.repository.bind(t.record, t.authorize)).rejects.toMatchObject({ code: field === 'missing' ? 'FILE_BYTES_UNAVAILABLE' : 'NATIVE_ARTIFACT_OUTPUT_CONFLICT' })
    expect(t.state.row).toBeUndefined()
  })
  it('returns absence and rejects a different producer on read', async () => {
    const t = await fixture()
    expect(await t.repository.read(t.record.producer, 'report')).toBeUndefined()
    await t.repository.bind(t.record, t.authorize)
    await expect(t.repository.read({ ...t.record.producer, nodeId: 'replacement' }, 'report')).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_OUTPUT_CONFLICT' })
    expect(t.state.row?.input_hash).toBe(createHash('sha256').update(canonicalGraphJson(t.record)).digest('hex'))
  })
  it('rechecks authority after canonical file locks before commit', async () => {
    const t = await fixture()
    t.authorize.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { throw new DomainError('AUTH_REVOKED', 'revoked at commit', 403) })
    await expect(t.repository.bind(t.record, t.authorize)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    expect(t.state.row).toBeUndefined()
    expect(t.state.queries.at(-1)).toBe('rollback')
  })
  it('audits exactly one successful output binding inside its transaction', async () => {
    const t = await fixture()
    await t.repository.bind(t.record, t.authorize)
    expect(t.state.audits).toBe(1)
    await t.repository.bind(t.record, t.authorize)
    expect(t.state.audits).toBe(1)
    expect(t.state.queries.findIndex(sql => sql.startsWith('insert into management_audit'))).toBeLessThan(t.state.queries.indexOf('commit'))
  })
})
