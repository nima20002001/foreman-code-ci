import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TransferIntentSchema, TransferContextSchema } from '@foreman-code/contracts/byte-transfer'
import { JobOutputPublicationInputSchema } from '@foreman-code/contracts/job-output-transfer'
import { ResumableByteTransferService } from '../../byte-transfer/service.js'
import { createInstalledJobOutputRsyncStore } from './installedJobOutputRsyncStore.js'
import type { RetainedJobOutputRsyncRecord } from './jobOutputRsyncSource.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
  const directory = await mkdtemp('/tmp/job-output-retained-'); cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const rootDirectory = join(directory, 'original-store'); await mkdir(rootDirectory, { mode: 0o700 })
  const bytes = Buffer.from('original closed output'), sha256 = createHash('sha256').update(bytes).digest('hex')
  const context = TransferContextSchema.parse({ mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID() })
  const intent = TransferIntentSchema.parse({ version: 1, ...context, transferId: randomUUID(), operationId: randomUUID(),
    executionId: randomUUID(), attemptId: randomUUID(), placementHash: 'a'.repeat(64), rootId: randomUUID(), rootBindingRevision: 1,
    direction: 'to-main', byteClass: 'artifact', sha256, byteSize: bytes.length, manifestDigest: 'b'.repeat(64),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), chunkBytes: 8192 })
  const input = JobOutputPublicationInputSchema.parse({ workspaceId: 'workspace', executionId: intent.executionId,
    attemptId: intent.attemptId, owner: { grantId: randomUUID(), epoch: '1' }, commandId: randomUUID(), path: 'result.txt',
    mediaType: 'text/plain', sha256, byteSize: bytes.length })
  const record: RetainedJobOutputRsyncRecord = { intent, input, operationId: randomUUID(),
    specDigest: 'c'.repeat(64), closureEvidenceDigest: 'd'.repeat(64) }
  const authorize = vi.fn(async () => {}), quiescent = vi.fn(async () => {})
  const quotaRoot = join(directory, 'original-quota')
  const quota = new ResumableByteTransferService(quotaRoot, { authorize }); cleanups.push(() => quota.close())
  const release = vi.spyOn(quota, 'release')
  // Accepted/closure providers are contract fixtures only. Actual original quota
  // journal, store correlation, private files and recovery are exercised here.
  const ports = { rootDirectory, quota, authorize, quiescent, current: async () => context }
  const store = await createInstalledJobOutputRsyncStore(ports), signal = new AbortController().signal
  const journal = () => readFile(join(quotaRoot, `${intent.transferId}.json`), 'utf8')
  return { directory, rootDirectory, bytes, record, intent, ports, store, signal, journal, release, authorize, quiescent }
}

describe('original Job rsync retention with shared quota, no physical acceptance', () => {
  it('fsyncs exact correlation and recovers the original immutable reader without a second hold', async () => {
    const f = await fixture()
    await f.store.retain(f.record, f.bytes, f.signal)
    const before = await f.journal()
    expect(JSON.parse(before).payload.external['rsync-source']).toEqual({ byteSize: f.bytes.length * 2, released: false })
    f.bytes.fill(0)
    const recovered = await createInstalledJobOutputRsyncStore(f.ports), resolved = await recovered.resolve(f.intent.transferId, f.signal)
    expect(resolved.record).toEqual(f.record)
    expect(await resolved.source.read(f.intent, 0, f.intent.byteSize, f.signal)).toEqual(Buffer.from('original closed output'))
    await recovered.retain(f.record, Buffer.from('original closed output'), f.signal)
    expect(await f.journal()).toBe(before)
    await expect(recovered.retain({ ...f.record, closureEvidenceDigest: 'e'.repeat(64) }, Buffer.from('original closed output'), f.signal)).rejects.toThrow()
    expect(f.release).not.toHaveBeenCalled()
  })
  it('denies hash conflicts before staging and refuses corrupted retained bytes', async () => {
    const f = await fixture()
    await expect(f.store.retain(f.record, Buffer.alloc(f.bytes.length), f.signal)).rejects.toThrow()
    await expect(f.journal()).rejects.toMatchObject({ code: 'ENOENT' })
    await f.store.retain(f.record, f.bytes, f.signal)
    await writeFile(join(f.rootDirectory, `${f.intent.transferId}.retained.bytes`), Buffer.alloc(f.bytes.length))
    await expect(f.store.resolve(f.intent.transferId, f.signal)).rejects.toThrow()
    expect(JSON.parse(await f.journal()).payload.external['rsync-source'].released).toBe(false)
  })
  it('rechecks grants on each read and cannot substitute a changed intent or retargeted root', async () => {
    const f = await fixture()
    await f.store.retain(f.record, f.bytes, f.signal)
    const { source } = await f.store.resolve(f.intent.transferId, f.signal)
    await expect(source.read({ ...f.intent, attemptId: randomUUID() }, 0, 1)).rejects.toThrow()
    f.authorize.mockRejectedValueOnce(new Error('Original grant revoked'))
    await expect(source.read(f.intent, 0, 1)).rejects.toThrow('Original grant revoked')
    await rename(f.rootDirectory, join(f.directory, 'original-root'))
    await mkdir(f.rootDirectory, { mode: 0o700 })
    await expect(source.read(f.intent, 0, 1)).rejects.toThrow()
    await expect(f.store.retire(f.intent)).rejects.toThrow()
    expect(f.release).not.toHaveBeenCalled()
  })
  it('requires positive stopped readers; retirement is retryable and never releases backend snapshot quota', async () => {
    const f = await fixture()
    await f.store.retain(f.record, f.bytes, f.signal)
    const before = await f.journal()
    f.quiescent.mockRejectedValueOnce(new Error('Original reader still active'))
    await expect(f.store.retire(f.intent)).rejects.toThrow('Original reader still active')
    expect((await f.store.resolve(f.intent.transferId, f.signal)).record).toEqual(f.record)
    await f.store.retire(f.intent)
    await f.store.retire(f.intent)
    await expect(f.store.resolve(f.intent.transferId, f.signal)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await f.journal()).toBe(before); expect(f.release).not.toHaveBeenCalled()
  })
  it('preserves crash-left reader/writer locks and their charged reservation', async () => {
    const f = await fixture()
    await f.store.retain(f.record, f.bytes, f.signal)
    const before = await f.journal()
    await mkdir(join(f.rootDirectory, `${f.intent.transferId}.retained.lock`), { mode: 0o700 })
    await expect(f.store.retire(f.intent)).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(f.store.resolve(f.intent.transferId, f.signal)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await f.journal()).toBe(before); expect(f.release).not.toHaveBeenCalled()
  })
})
