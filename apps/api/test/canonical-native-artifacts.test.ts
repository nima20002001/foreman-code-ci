import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import type { VerifiedTransferReceipt } from '@foreman-code/contracts/byte-transfer'
import { DomainError } from '../src/modules/errors.js'
import { TemporaryFileService } from '../src/modules/files/service.js'
import { FileByteStorage } from '../src/modules/files/storage.js'
import { CanonicalNativeArtifactResults } from '../src/modules/files/distributed/nativeResults.js'
import { DistributedArtifactPublicationService, type AcceptedArtifactPublication } from '../src/modules/files/distributed/publication.js'
import type { DistributedPublicationLink } from '../src/modules/files/distributed/publicationLedger.js'
import { fileToolFixture } from './support/fileTools.js'

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const f = await fileToolFixture(), body = Buffer.from('# Native output\nExact bytes: 雪\n')
  const root = await mkdtemp(join(process.cwd(), '.native-artifacts-test-')); roots.push(root)
  const bytes = new FileByteStorage(root, MAX_FILE_BYTES)
  const files = new TemporaryFileService(f.repository, bytes, { resolve: async () => f.scope }, undefined, f.clock)
  if (f.scope.chat.kind !== 'agent') throw new Error('fixture')
  f.scope.chat.runId = randomUUID(); f.scope.chat.executionId = randomUUID()
  const attempt = { workspaceId: f.scope.chat.workspaceId, workflowId: f.scope.chat.workflowId,
    runId: f.scope.chat.runId!, nodeId: 'node-a', executionId: f.scope.chat.executionId!,
    attemptId: randomUUID(), placementHash: hash('placement') }
  const transferContext = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID() }
  const accepted: AcceptedArtifactPublication = { context: f.context, attempt, transferContext }
  const receipt: VerifiedTransferReceipt = { version: 1, receiptId: randomUUID(), transferId: randomUUID(),
    sha256: hash(body), byteSize: body.length, verifiedAt: f.clock().toISOString(), intent: { version: 1, ...transferContext,
      transferId: '', operationId: randomUUID(), executionId: attempt.executionId, attemptId: attempt.attemptId,
      placementHash: attempt.placementHash, rootId: randomUUID(), rootBindingRevision: 1, direction: 'to-main', byteClass: 'artifact',
      sha256: hash(body), byteSize: body.length, manifestDigest: hash('manifest'),
      expiresAt: new Date(f.clock().getTime() + 60_000).toISOString(), chunkBytes: 1024 } }
  receipt.intent.transferId = receipt.transferId
  const links = new Map<string, DistributedPublicationLink>()
  const ledger = { read: async (_owner: string, request: string) => links.get(request),
    linkPublication: async (link: DistributedPublicationLink) => { if (!links.has(link.requestId)) links.set(link.requestId, structuredClone(link)) } }
  const caller = { context: f.context, principal: f.principal, binding: hash('native-binding') }
  const authority = { authorize: vi.fn(async () => caller), assertSourceLive: vi.fn(async () => {}) }
  const transfers = { resolveVerifiedReceipt: vi.fn(async () => receipt), openVerified: vi.fn(async () => Readable.from([body.subarray(0, 7), body.subarray(7)])) }
  const publisher = new DistributedArtifactPublicationService(files, ledger, transfers, authority, f.clock)
  const results = new CanonicalNativeArtifactResults(files, ledger, authority, f.clock)
  const input = { commandId: randomUUID(), artifactId: randomUUID(), scope: f.scope, filename: 'native.md', mediaType: 'text/markdown' }
  const publish = () => publisher.publishAccepted(accepted, receipt.transferId, input)
  const read = () => results.readAccepted(accepted, input.commandId)
  return { f, root, bytes, files, body, accepted, receipt, links, caller, authority, transfers, publisher, results, input, publish, read }
}

describe('canonical native artifact result port', () => {
  it('reconciles lost publication ACK with original receipts, one allocation and byte-identical pins after staging expiry', async () => {
    const t = await fixture()
    const finalized = t.files.finalize.bind(t.files)
    t.files.finalize = vi.fn(async (...args: Parameters<typeof finalized>) => {
      await finalized(...args)
      throw new Error('publication ACK lost')
    })
    await expect(t.publish()).rejects.toThrow('publication ACK lost')
    t.files.finalize = finalized
    t.transfers.openVerified.mockRejectedValue(new Error('staging reclaimed'))
    t.f.advance(120_000)
    const result = await t.read()
    const replay = await t.publish()
    expect(result.pins).toEqual({ fileId: replay.value.file.fileId, revisionId: replay.value.revision.revisionId,
      sha256: hash(t.body), byteSize: t.body.length })
    expect(result.transferReceipt).toEqual(t.receipt)
    expect(result.attempt).toEqual(t.accepted.attempt)
    expect(result.nativeIdentity).toEqual({ nativeSessionId: 'native-a', turnId: 'turn-a' })
    expect(t.links.size).toBe(1); expect(t.f.repository.allocations.size).toBe(1)
    expect(t.transfers.openVerified).toHaveBeenCalledTimes(1)
    const stored = await t.f.repository.read(result.pins.fileId, result.pins.revisionId)
    expect(await readFile(join(t.root, 'objects', stored!.storageKey))).toEqual(t.body)
    const readOnly = { ...t.caller, context: { ...t.caller.context, allowMutation: false, allowedTools: ['files.list' as const] } }
    t.authority.authorize.mockResolvedValue(readOnly)
    expect((await t.read()).publication).toEqual(result.publication)
    const reconnected = { ...t.accepted, transferContext: { ...t.accepted.transferContext, bootId: randomUUID(), connectionEpoch: randomUUID() } }
    expect((await t.results.readAccepted(reconnected, t.input.commandId)).transferReceipt).toEqual(t.receipt)
  })
  it('keeps the original command pinned when the same native producer publishes another output', async () => {
    const t = await fixture(); await t.publish()
    const original = await t.read(), body = Buffer.from('# A later native output\n')
    const transferId = randomUUID()
    const receipt = { ...t.receipt, receiptId: randomUUID(), transferId, sha256: hash(body), byteSize: body.length,
      intent: { ...t.receipt.intent, transferId, sha256: hash(body), byteSize: body.length } }
    t.transfers.resolveVerifiedReceipt.mockResolvedValue(receipt)
    t.transfers.openVerified.mockImplementation(async () => Readable.from([body]))
    const next = await t.publisher.publishAccepted(t.accepted, transferId, { ...t.input, commandId: randomUUID(), artifactId: randomUUID() })
    expect(next.value.revision.revisionId).not.toBe(original.pins.revisionId)
    expect((await t.read()).pins).toEqual(original.pins)
    expect((await t.read()).transferReceipt).toEqual(t.receipt)
    expect(t.links.size).toBe(2)
  })
  it('excludes missing or pending publication without manufacturing attachments', async () => {
    const t = await fixture()
    await expect(t.read()).rejects.toMatchObject({ code: 'FILE_PUBLICATION_PENDING' })
    t.transfers.openVerified.mockRejectedValue(new Error('transfer unavailable'))
    await expect(t.publish()).rejects.toThrow('transfer unavailable')
    await expect(t.read()).rejects.toMatchObject({ code: 'FILE_NOT_READY' })
  })
  for (const mode of ['corrupt', 'missing'] as const) {
    it(`rejects ${mode} finalized canonical bytes after staging reclamation`, async () => {
      const t = await fixture(), published = await t.publish()
      const stored = await t.f.repository.read(published.value.file.fileId, published.value.revision.revisionId)
      const path = join(t.root, 'objects', stored!.storageKey)
      if (mode === 'missing') await unlink(path)
      else { await chmod(path, 0o600); await writeFile(path, Buffer.alloc(t.body.length, 65)) }
      t.transfers.openVerified.mockRejectedValue(new Error('staging reclaimed'))
      await expect(t.read()).rejects.toMatchObject({ code: mode === 'corrupt' ? 'FILE_HASH_MISMATCH' : 'FILE_BYTES_UNAVAILABLE' })
      expect(t.transfers.openVerified).toHaveBeenCalledTimes(1)
    })
  }
  it('rechecks expiry and current authority after canonical verification', async () => {
    const t = await fixture(); await t.publish()
    const download = t.bytes.download.bind(t.bytes)
    t.bytes.download = async (...args) => { const opened = await download(...args); t.f.advance(366 * 24 * 3600 * 1000); return opened }
    await expect(t.read()).rejects.toMatchObject({ code: 'FILE_BYTES_UNAVAILABLE' })
    const revoked = await fixture(); await revoked.publish()
    revoked.authority.authorize.mockResolvedValueOnce(revoked.caller).mockRejectedValue(new DomainError('AUTH_REVOKED', 'revoked', 403))
    await expect(revoked.read()).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    const waited = await fixture(); await waited.publish()
    waited.authority.authorize.mockResolvedValueOnce(waited.caller).mockImplementation(async () => {
      waited.f.advance(366 * 24 * 3600 * 1000); return waited.caller
    })
    await expect(waited.read()).rejects.toMatchObject({ code: 'FILE_BYTES_UNAVAILABLE' })
  })
  it('denies old attempts, foreign bindings and receipt pins without allocating new output', async () => {
    const t = await fixture(); await t.publish()
    await expect(t.results.readAccepted({ ...t.accepted, attempt: { ...t.accepted.attempt, attemptId: randomUUID() } }, t.input.commandId))
      .rejects.toMatchObject({ code: 'FILE_PUBLICATION_CONFLICT' })
    await expect(t.results.readAccepted({ ...t.accepted, transferContext: { ...t.accepted.transferContext, keyRevision: 2 } }, t.input.commandId))
      .rejects.toMatchObject({ code: 'FILE_PUBLICATION_CONFLICT' })
    t.authority.authorize.mockResolvedValue({ ...t.caller, binding: hash('foreign-turn') })
    await expect(t.read()).rejects.toMatchObject({ code: 'FILE_PUBLICATION_CONFLICT' })
    t.authority.authorize.mockResolvedValue(t.caller)
    const link = [...t.links.values()][0]!
    link.context.nativeSessionId = 'foreign-native'
    await expect(t.read()).rejects.toMatchObject({ code: 'FILE_PUBLICATION_CONFLICT' })
    link.context.nativeSessionId = t.caller.context.nativeSessionId
    link.transferReceipt.sha256 = hash('other'); link.transferReceipt.intent.sha256 = hash('other')
    await expect(t.read()).rejects.toMatchObject({ code: 'FILE_PUBLICATION_CONFLICT' })
    t.authority.authorize.mockResolvedValue({ ...t.caller, context: { ...t.caller.context, allowedTools: [] } })
    await expect(t.read()).rejects.toMatchObject({ code: 'FILE_TOOL_DENIED' })
    expect(t.f.repository.allocations.size).toBe(1)
  })
})
