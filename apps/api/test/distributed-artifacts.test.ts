import { randomUUID, createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import type { ArtifactEdgeBinding } from '@foreman-code/contracts/artifact-edges'
import type { VerifiedTransferReceipt } from '@foreman-code/contracts/byte-transfer'
import { DomainError } from '../src/modules/errors.js'
import { ArtifactEdgeService, type ArtifactEdgeRepository } from '../src/modules/files/distributed/edges.js'
import { DistributedArtifactPublicationService, type AcceptedArtifactPublication } from '../src/modules/files/distributed/publication.js'
import type { DistributedPublicationLink } from '../src/modules/files/distributed/publicationLedger.js'
import { registerDistributedArtifacts } from '../src/modules/files/distributed/adapters.js'
import { fileToolFixture } from './support/fileTools.js'
const hash = (v: string) => createHash('sha256').update(v).digest('hex')
const query = { query: vi.fn() } as unknown as import('../src/modules/files/repository.js').FileQuery
async function fixture() {
  const f = await fileToolFixture(), ref = await f.upload('pinned A bytes')
  const stored = await f.repository.read(ref.fileId, ref.revisionId)
  const attempt = { workspaceId: 'workspace-a', workflowId: 'workflow-a', runId: 'run-a', nodeId: 'node-a',
    executionId: 'execution-a', attemptId: randomUUID(), placementHash: hash('placement-a') }
  const b: ArtifactEdgeBinding = { version: 1, edgeId: randomUUID(), commandId: randomUUID(), producer: attempt,
    consumer: { ...attempt, nodeId: 'node-b', executionId: 'execution-b', attemptId: randomUUID(), placementHash: hash('placement-b') },
    outputKey: 'result', publication: { ownerPrincipalId: f.principal.id, requestId: 'publish', binding: hash('binding') },
    pins: { ...ref, sha256: stored!.value.revision.sha256, byteSize: stored!.value.revision.byteSize }, scope: f.scope,
    sender: { principalId: f.principal.id, grantId: 'grant-a', grantRevision: '1' },
    receiver: { principalId: f.principal.id, grantId: 'grant-b', grantRevision: '1' }, access: 'read-only', acceptedAt: f.clock().toISOString() }
  const bindings = new Map<string, ArtifactEdgeBinding>(), reads: string[] = []
  const repo: ArtifactEdgeRepository = {
    async pin(value, auth) {
      await auth(query)
      const prior = bindings.get(value.edgeId)
      if (prior && JSON.stringify(prior) !== JSON.stringify(value)) throw new DomainError('FILE_EDGE_CONFLICT', 'conflict', 409)
      bindings.set(value.edgeId, structuredClone(value)); return value
    },
    async read(id) { return bindings.get(id) },
    async recordRead(value, at, auth) { await auth(query); reads.push(`${value.edgeId}:${at}`) },
  }
  let revoked = false
  const authorization = { assertCurrent: vi.fn(async () => { if (revoked) throw new DomainError('AUTH_REVOKED', 'revoked', 403) }) }
  const service = new ArtifactEdgeService(repo, f.repository, f.bytes as unknown as import('../src/modules/files/storage.js').FileByteStorage, authorization, f.clock)
  return { f, b, service, reads, bindings, authorization, revoke: () => { revoked = true } }
}
describe('revision-pinned artifact edges', () => {
  it('retries one binding, preserves old pins and rejects changed pins and wrong attempt/grant', async () => {
    const t = await fixture()
    await t.service.pinAccepted(t.b); await t.service.pinAccepted(t.b)
    expect(t.bindings.size).toBe(1)
    const data = await t.service.readAccepted(t.b.edgeId, t.b.consumer, t.b.receiver, 0, 64)
    expect(data.status).toBe('ready')
    if (data.status === 'ready') expect(Buffer.from(data.contentBase64, 'base64').toString()).toBe('pinned A bytes')
    await expect(t.service.readAccepted(t.b.edgeId, { ...t.b.consumer, attemptId: 'old' }, t.b.receiver, 0, 4)).rejects.toMatchObject({ code: 'FILE_EDGE_DENIED' })
    await expect(t.service.readAccepted(t.b.edgeId, t.b.consumer, { ...t.b.receiver, grantRevision: '2' }, 0, 4)).rejects.toMatchObject({ code: 'FILE_EDGE_DENIED' })
    await expect(t.service.pinAccepted({ ...t.b, pins: { ...t.b.pins, sha256: hash('changed') } })).rejects.toMatchObject({ code: 'FILE_EDGE_CONFLICT' })
    expect(t.reads).toHaveLength(1)
  })
  it('denies expiry and mid-read revocation without provenance or bytes', async () => {
    const t = await fixture(); await t.service.pinAccepted(t.b)
    const download = t.f.bytes.download.bind(t.f.bytes)
    t.f.bytes.download = async (...args) => { const stream = await download(...args); t.revoke(); return stream }
    await expect(t.service.readAccepted(t.b.edgeId, t.b.consumer, t.b.receiver, 0, 4)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    expect(t.reads).toHaveLength(0)
    const expired = await fixture(); await expired.service.pinAccepted(expired.b)
    const originalDownload = expired.f.bytes.download.bind(expired.f.bytes)
    expired.f.bytes.download = async (...args) => { const stream = await originalDownload(...args); expired.f.advance(366 * 24 * 3600 * 1000); return stream }
    await expect(expired.service.readAccepted(expired.b.edgeId, expired.b.consumer, expired.b.receiver, 0, 4)).rejects.toMatchObject({ code: 'FILE_BYTES_UNAVAILABLE' })
    const e = await fixture(); await e.service.pinAccepted(e.b)
    e.f.repository.values.get(e.b.pins.fileId)!.value.file.state = 'removed'
    await expect(e.service.readAccepted(e.b.edgeId, e.b.consumer, e.b.receiver, 0, 4)).rejects.toMatchObject({ code: 'FILE_BYTES_UNAVAILABLE' })
  })
  it('uses authenticated HTTP and MCP for the same exact pins and denies unauthenticated caller', async () => {
    const t = await fixture(); await t.service.pinAccepted(t.b)
    const auth = async (request: import('fastify').FastifyRequest) => {
      if (request.headers.authorization !== 'Bearer owned') throw new DomainError('AUTH_REQUIRED', 'denied', 401)
      return { attempt: t.b.consumer, authority: t.b.receiver }
    }
    const app = Fastify()
    app.setErrorHandler((error, _request, reply) => { void reply.code(error instanceof DomainError ? error.status : 500).send({ error: error instanceof DomainError ? error.code : 'ERROR' }) })
    registerDistributedArtifacts(app, t.service, {} as DistributedArtifactPublicationService,
      { consumer: auth, producer: async () => { throw new DomainError('ACCESS_DENIED', 'denied', 403) } })
    const input = { edgeId: t.b.edgeId, offset: 0, length: 4 }
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      expect((await app.inject({ method: 'POST', url: '/api/artifact-inputs/read', payload: input })).statusCode).toBe(401)
      const http = await app.inject({ method: 'POST', url: '/api/artifact-inputs/read', headers: { authorization: 'Bearer owned' }, payload: input })
      expect(http.json()).toMatchObject({ status: 'ready', revision: { revisionId: t.b.pins.revisionId } })
      const call = (token: string) => fetch(new URL('/mcp/artifact-inputs', address), {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
          accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1,
          method: 'tools/call', params: { name: 'files.read_edge_input', arguments: input } }),
      })
      const denied = await call('foreign')
      expect(denied.status).toBe(401)
      await denied.text()
      const mcp = await call('owned')
      expect(mcp.status).toBe(200)
      expect(mcp.headers.get('content-type')).toMatch(/^application\/json/)
      const result = await mcp.json()
      expect(result.result.structuredContent).toMatchObject({ status: 'ready', revision: { revisionId: t.b.pins.revisionId } })
      expect(t.reads).toHaveLength(2)
    } finally { await app.close() }
  })
})

describe('verified transfer publication through the existing ledger', () => {
  it('recovers a lost finalization acknowledgment without staging bytes and denies changed retries', async () => {
    const f = await fileToolFixture()
    const context = { ...f.context, scope: { ...f.scope, chat: { ...f.scope.chat, runId: randomUUID(), executionId: randomUUID() } } } as typeof f.context
    const chat = context.scope.chat
    if (chat.kind !== 'agent') throw new Error('fixture')
    const attempt = { workspaceId: chat.workspaceId, workflowId: chat.workflowId, runId: chat.runId!, nodeId: 'node-a',
      executionId: chat.executionId!, attemptId: randomUUID(), placementHash: hash('placement') }
    const transferContext = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
      keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID() }
    const accepted: AcceptedArtifactPublication = { context, attempt, transferContext }
    const receipt: VerifiedTransferReceipt = { version: 1, receiptId: randomUUID(), transferId: randomUUID(), sha256: hash('result'), byteSize: 6,
      verifiedAt: f.clock().toISOString(), intent: { version: 1, ...transferContext, transferId: '', operationId: randomUUID(),
        executionId: attempt.executionId, attemptId: attempt.attemptId, placementHash: attempt.placementHash,
        rootId: randomUUID(), rootBindingRevision: 1, direction: 'to-main', byteClass: 'artifact', sha256: hash('result'), byteSize: 6,
        manifestDigest: hash('manifest'), expiresAt: new Date(f.clock().getTime() + 60_000).toISOString(), chunkBytes: 1024 } }
    receipt.intent.transferId = receipt.transferId
    const caller = { context, principal: f.principal, binding: hash('bound') }
    // Fixture authorization resolves the accepted target, production uses live DB row fences.
    const files = new (await import('../src/modules/files/service.js')).TemporaryFileService(f.repository, f.bytes as unknown as import('../src/modules/files/storage.js').FileByteStorage,
      { resolve: async () => context.scope }, undefined, f.clock)
    const links = new Map<string, DistributedPublicationLink>()
    const ledger = { read: async (_owner: string, request: string) => links.get(request),
      linkPublication: async (link: DistributedPublicationLink) => { links.set(link.requestId, structuredClone(link)) } }
    const reader = { resolveVerifiedReceipt: vi.fn(async () => receipt), openVerified: vi.fn(async () => Readable.from([Buffer.from('result')])) }
    const authority = { authorize: vi.fn(async () => caller), assertSourceLive: vi.fn(async () => {}) }
    const service = new DistributedArtifactPublicationService(files, ledger, reader, authority, f.clock)
    const input = { commandId: randomUUID(), artifactId: randomUUID(), scope: context.scope, filename: 'result.md', mediaType: 'text/markdown' }
    const first = await service.publishAccepted(accepted, receipt.transferId, input)
    reader.openVerified.mockRejectedValue(new Error('staging reclaimed'))
    f.advance(120_000) // transfer staging deadline expired, canonical file retention is unchanged
    const replay = await service.publishAccepted(accepted, receipt.transferId, input, 'mcp')
    expect(replay).toMatchObject({ replayed: true, value: { revision: { revisionId: first.value.revision.revisionId } } })
    expect(links.size).toBe(1); expect(f.repository.allocations.size).toBe(1)
    expect(reader.resolveVerifiedReceipt).toHaveBeenCalledTimes(1); expect(reader.openVerified).toHaveBeenCalledTimes(1)
    await expect(service.publishAccepted(accepted, receipt.transferId, { ...input, filename: 'changed.md' })).rejects.toMatchObject({ code: 'FILE_REQUEST_CONFLICT' })
    authority.authorize.mockRejectedValue(new DomainError('AUTH_REVOKED', 'revoked', 403))
    await expect(service.publishAccepted(accepted, receipt.transferId, input)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
  })
})

describe('physical deletion ownership', () => {
  it('defers held and uncertain objects without treating a hold as access authorization', async () => {
    const { DistributedArtifactDeletionOwnership } = await import('../src/modules/files/distributed/cleanup.js')
    const candidate = { fileId: 'file', revisionId: 'revision', storageKey: 'key', ownerPrincipalId: 'owner', requestId: 'request', expiresAt: '2000-01-01T00:00:00Z', retentionRevision: 1 }
    const materialization = { inspect: vi.fn(async () => 'clear' as const) }
    for (const state of ['held','unknown'] as const) {
      const ownership = new DistributedArtifactDeletionOwnership({ inspect: async () => state }, materialization)
      expect(await ownership.assertCanDelete(candidate, query)).toBe(false)
    }
    expect(materialization.inspect).not.toHaveBeenCalled()
    const ownership = new DistributedArtifactDeletionOwnership({ inspect: async () => 'clear' }, materialization)
    expect(await ownership.assertCanDelete(candidate, query)).toBe(true)
  })
})
