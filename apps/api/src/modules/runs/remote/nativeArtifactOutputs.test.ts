import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import type { VerifiedTransferReceipt } from '@foreman-code/contracts/byte-transfer'
import type { ArtifactAttempt, ArtifactEdgeBinding } from '@foreman-code/contracts/artifact-edges'
import { fileToolFixture } from '../../../../test/support/fileTools.js'
import { TemporaryFileService } from '../../files/service.js'
import { FileByteStorage } from '../../files/storage.js'
import { CanonicalNativeArtifactResults } from '../../files/distributed/nativeResults.js'
import { DistributedArtifactPublicationService, type AcceptedArtifactPublication, type ArtifactPublicationAuthority } from '../../files/distributed/publication.js'
import type { DistributedPublicationLink } from '../../files/distributed/publicationLedger.js'
import { DomainError } from '../../errors.js'
import { NativeArtifactOutputs, type NativeArtifactOutput, type NativeArtifactOutputRepository } from './nativeArtifactOutputs.js'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const f = await fileToolFixture(), body = Buffer.from('original native artifact bytes')
  const root = await mkdtemp(join(process.cwd(), '.native-output-test-')); roots.push(root)
  const files = new TemporaryFileService(f.repository, new FileByteStorage(root, MAX_FILE_BYTES), { resolve: async () => f.scope }, undefined, f.clock)
  if (f.scope.chat.kind !== 'agent') throw new Error('fixture')
  f.scope.chat.runId = randomUUID(); f.scope.chat.executionId = randomUUID()
  const attempt: ArtifactAttempt = { workspaceId: f.scope.chat.workspaceId, workflowId: f.scope.chat.workflowId,
    runId: f.scope.chat.runId!, nodeId: 'producer', executionId: f.scope.chat.executionId!, attemptId: randomUUID(), placementHash: hash('accepted placement') }
  const transferContext = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID() }
  const accepted: AcceptedArtifactPublication = { context: f.context, attempt, transferContext }
  const receipt: VerifiedTransferReceipt = { version: 1, receiptId: randomUUID(), transferId: randomUUID(), sha256: hash(body), byteSize: body.length,
    verifiedAt: f.clock().toISOString(), intent: { version: 1, ...transferContext, transferId: '', operationId: randomUUID(),
      executionId: attempt.executionId, attemptId: attempt.attemptId, placementHash: attempt.placementHash,
      rootId: randomUUID(), rootBindingRevision: 1, direction: 'to-main', byteClass: 'artifact', sha256: hash(body), byteSize: body.length,
      manifestDigest: hash('manifest'), expiresAt: new Date(f.clock().getTime() + 60_000).toISOString(), chunkBytes: 1024 } }
  receipt.intent.transferId = receipt.transferId
  const links = new Map<string, DistributedPublicationLink>()
  const ledger = { read: async (_owner: string, id: string) => links.get(id), linkPublication: async (link: DistributedPublicationLink) => {
    if (!links.has(link.requestId)) links.set(link.requestId, structuredClone(link))
  } }
  const caller = { context: f.context, principal: f.principal, binding: hash('native binding') }
  const authority = { authorize: vi.fn<ArtifactPublicationAuthority['authorize']>(async () => caller), assertSourceLive: vi.fn(async () => {}) }
  const transfers = { resolveVerifiedReceipt: vi.fn(async () => receipt), openVerified: vi.fn(async () => Readable.from([body])) }
  const publisher = new DistributedArtifactPublicationService(files, ledger, transfers, authority, f.clock)
  const results = new CanonicalNativeArtifactResults(files, ledger, authority, f.clock)
  const commands = [randomUUID(), randomUUID()]
  const publish = (commandId = commands[0]!) => publisher.publishAccepted(accepted, receipt.transferId,
    { commandId, artifactId: randomUUID(), scope: f.scope, filename: 'native.md', mediaType: 'text/markdown' })
  const records = new Map<string, NativeArtifactOutput>()
  const key = (producer: ArtifactAttempt, output: string) => JSON.stringify([producer.executionId, producer.attemptId, output])
  const repository: NativeArtifactOutputRepository = { read: async (producer, output) => records.get(key(producer, output)),
    bind: async (record, authorize) => {
      await authorize({ query: async () => ({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }) })
      const id = key(record.producer, record.outputKey), existing = records.get(id)
      if (existing && !isDeepStrictEqual(existing, record)) throw new DomainError('NATIVE_ARTIFACT_OUTPUT_CONFLICT', 'Original mapping already bound.', 409)
      if (!existing) records.set(id, structuredClone(record))
      return structuredClone(existing ?? record)
    } }
  const edges = { pinAccepted: vi.fn(async (binding: ArtifactEdgeBinding) => binding) }
  const outputs = new NativeArtifactOutputs(results, repository, authority, edges)
  const edge = { edgeId: 'edge', commandId: 'edge-command', producer: attempt, consumer: { ...attempt, nodeId: 'consumer', executionId: randomUUID(), attemptId: randomUUID() },
    outputKey: 'report', sender: { principalId: caller.principal.id, grantId: 'sender-grant', grantRevision: '1' },
    receiver: { principalId: 'receiver', grantId: 'receiver-grant', grantRevision: '1' }, access: 'read-only' as const, acceptedAt: f.clock().toISOString() }
  return { f, accepted, receipt, caller, authority, transfers, publisher, results, commands, publish, records, repository, edges, outputs, edge }
}
describe('persisted original native artifact output adoption', () => {
  it('binds genuine canonical pins and original receipt, then derives an exact read-only edge', async () => {
    const t = await fixture(); await t.publish()
    const output = await t.outputs.acceptOutput(t.accepted, 'report', t.commands[0]!)
    expect(output.nativeIdentity).toEqual({ nativeSessionId: 'native-a', turnId: 'turn-a' })
    expect(output.transferReceipt).toEqual(t.receipt)
    expect(output.producer).toEqual(t.accepted.attempt)
    const edge = await t.outputs.pinEdge(t.accepted, t.edge)
    expect(edge).toMatchObject({ publication: output.publication, pins: output.pins, producer: output.producer, access: 'read-only' })
    expect(t.records.size).toBe(1)
    expect(t.authority.authorize.mock.calls.some(call => call[1] !== undefined)).toBe(true)
  })
  it('reconstructs adapter after lost mapping ACK and reads original revision after a newer publication', async () => {
    const t = await fixture(); await t.publish()
    const bind = t.repository.bind.bind(t.repository)
    t.repository.bind = async (...args) => { await bind(...args); throw new Error('mapping ACK lost') }
    await expect(t.outputs.acceptOutput(t.accepted, 'report', t.commands[0]!)).rejects.toThrow('ACK lost')
    t.repository.bind = bind
    await t.publish(t.commands[1]!)
    t.transfers.openVerified.mockRejectedValue(new Error('staging expired'))
    t.f.advance(120_000)
    const restored = new NativeArtifactOutputs(t.results, t.repository, t.authority, t.edges)
    const output = await restored.readOutput(t.accepted, 'report')
    expect(output.commandId).toBe(t.commands[0])
    expect(await restored.acceptOutput(t.accepted, 'report', t.commands[0]!)).toEqual(output)
    expect((await restored.pinEdge(t.accepted, t.edge)).pins).toEqual(output.pins)
    expect(t.records.size).toBe(1)
    await expect(restored.acceptOutput(t.accepted, 'report', t.commands[1]!)).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_OUTPUT_CONFLICT' })
  })
  it('does not bind missing publication or pin an unadopted output', async () => {
    const t = await fixture()
    await expect(t.outputs.acceptOutput(t.accepted, 'report', t.commands[0]!)).rejects.toMatchObject({ code: 'FILE_PUBLICATION_PENDING' })
    await expect(t.outputs.pinEdge(t.accepted, t.edge)).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_OUTPUT_PENDING' })
    expect(t.records.size).toBe(0); expect(t.edges.pinAccepted).not.toHaveBeenCalled()
  })
  it.each(['native', 'pins', 'producer', 'receipt'] as const)('rejects changed %s readback without changing persisted mapping or edges', async changed => {
    const t = await fixture(); await t.publish()
    const original = await t.outputs.acceptOutput(t.accepted, 'report', t.commands[0]!)
    const read = t.results.readAccepted.bind(t.results)
    t.results.readAccepted = async (...args) => {
      const result = await read(...args)
      if (changed === 'native') result.nativeIdentity.turnId = 'replacement'
      if (changed === 'pins') result.pins.revisionId = randomUUID()
      if (changed === 'producer') result.attempt.attemptId = 'replacement'
      if (changed === 'receipt') result.transferReceipt.receiptId = randomUUID()
      return result
    }
    await expect(t.outputs.pinEdge(t.accepted, t.edge)).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_OUTPUT_CONFLICT' })
    expect([...t.records.values()]).toEqual([original]); expect(t.edges.pinAccepted).not.toHaveBeenCalled()
  })
  it('rechecks publication authorization in persistence and rejects another accepted consumer producer', async () => {
    const t = await fixture(); await t.publish()
    const authorize = t.authority.authorize.getMockImplementation()!
    t.authority.authorize.mockImplementation(async (...args) => {
      if (args[1]) throw new DomainError('FILE_TOOL_DENIED', 'grant revoked at persistence', 403)
      return authorize(...args)
    })
    await expect(t.outputs.acceptOutput(t.accepted, 'report', t.commands[0]!)).rejects.toMatchObject({ code: 'FILE_TOOL_DENIED' })
    expect(t.records.size).toBe(0)
    await expect(t.outputs.pinEdge(t.accepted, { ...t.edge, producer: { ...t.edge.producer, attemptId: 'replacement' } })).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_OUTPUT_CONFLICT' })
    expect(t.edges.pinAccepted).not.toHaveBeenCalled()
  })
})
