import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, appendFile, writeFile, readFile, symlink, mkdir, rename, link } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { BYTE_TRANSFER_POLICY, type TransferContext, type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { ResumableByteTransferService } from './service.js'
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const fixtureRoot = join(homedir(), '.cache', 'foreman-tmp')
const roots: string[] = [], services: ResumableByteTransferService[] = []
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(bytes = Buffer.from('abcdefgh')) {
  await mkdir(fixtureRoot, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(fixtureRoot, '.graphql-transfer-test-')); roots.push(root)
  let epoch = randomUUID(), revoked = false, now = Date.now(), failure: string | undefined
  let beforeDataSync: (() => Promise<void>) | undefined
  const context: TransferContext = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: epoch }
  const intent: TransferIntent = { ...context, version: 1, transferId: randomUUID(), operationId: randomUUID(),
    executionId: randomUUID(), attemptId: randomUUID(), placementHash: hash(Buffer.from('placement')),
    rootId: randomUUID(), rootBindingRevision: 1, direction: 'to-main', byteClass: 'source',
    sha256: hash(bytes), byteSize: bytes.length, manifestDigest: hash(Buffer.from('manifest')),
    expiresAt: new Date(now + 60_000).toISOString(), chunkBytes: 4 }
  const create = () => {
    const service = new ResumableByteTransferService(root, { authorize: async (_, current) => {
      if (revoked || current.connectionEpoch !== epoch) throw new Error('Denied current authority')
    } }, () => now, async point => {
      if (point === 'data-sync') await beforeDataSync?.()
      if (failure === point) throw new Error('Injected disk failure')
    })
    services.push(service); return service
  }
  const service = create()
  const chunk = (offset: number, value = bytes.subarray(offset, offset + 4)) => ({ offset, bytes: value, sha256: hash(value) })
  return { root, context, intent, bytes, service, create, chunk,
    revoke: () => { revoked = true }, reconnect: () => { epoch = randomUUID(); return { ...context, connectionEpoch: epoch, bootId: randomUUID() } },
    time: (ms: number) => { now += ms }, fail: (point?: string) => { failure = point },
    beforeDataSync: (callback: () => Promise<void>) => { beforeDataSync = callback } }
}
describe('bounded authenticated transfer staging', () => {
  it('retires an abandoned hour-long input transfer at the idle deadline during update drain', async () => {
    const f = await fixture()
    f.intent.expiresAt = new Date(Date.parse(f.intent.expiresAt) + 59 * 60_000).toISOString()
    await f.service.start(f.intent, f.context)
    await f.service.append(f.intent.transferId, f.context, f.chunk(0))
    f.time(BYTE_TRANSFER_POLICY.maxIdleMs - 1)
    expect(await f.service.isRuntimeQuiescent()).toBe(false)
    f.time(1)
    expect(await f.service.isRuntimeQuiescent()).toBe(true)
    expect(await f.service.inventory()).toEqual([])
    await expect(readFile(join(f.root, `${f.intent.transferId}.part`))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(f.service.start(f.intent, f.context)).rejects.toThrow()
  })

  it('keeps a live writer closed to updates even when its last progress becomes idle', async () => {
    const f = await fixture()
    f.intent.expiresAt = new Date(Date.parse(f.intent.expiresAt) + 59 * 60_000).toISOString()
    await f.service.start(f.intent, f.context)
    let release!: () => void
    let entered!: () => void
    const writing = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    f.beforeDataSync(async () => { entered(); await gate })
    const append = f.service.append(f.intent.transferId, f.context, f.chunk(0))
    await writing
    try {
      f.time(BYTE_TRANSFER_POLICY.maxIdleMs)
      expect(await f.service.isRuntimeQuiescent()).toBe(false)
      expect(await f.service.inventory()).toHaveLength(1)
    } finally {
      release()
      await expect(append).rejects.toThrow('Transfer expired')
    }
  })

  it('keeps live writes and readers busy while finished old-epoch transfers permit Worker updates', async () => {
    const f = await fixture()
    expect(await f.service.isRuntimeQuiescent()).toBe(true)
    await f.service.start(f.intent, f.context)
    expect(await f.service.isRuntimeQuiescent()).toBe(false)
    await f.service.append(f.intent.transferId, f.context, f.chunk(0))
    await f.service.append(f.intent.transferId, f.context, f.chunk(4))
    const receipt = await f.service.finish(f.intent.transferId, f.context)
    const reader = await f.service.openVerified(receipt, f.context)
    expect(await f.service.isRuntimeQuiescent()).toBe(false)
    for await (const chunk of reader) expect(chunk.length).toBeGreaterThan(0)
    f.reconnect()
    expect(await f.service.isRuntimeQuiescent()).toBe(true)
  })
  it('returns verified bytes with the original workflow execution identifier', async () => {
    const f = await fixture()
    f.intent.executionId = `execution-${randomUUID()}`
    await f.service.start(f.intent, f.context)
    await f.service.append(f.intent.transferId, f.context, f.chunk(0))
    await f.service.append(f.intent.transferId, f.context, f.chunk(4))
    const receipt = await f.service.finish(f.intent.transferId, f.context)
    expect(receipt.intent.executionId).toBe(f.intent.executionId)
    const chunks = []
    for await (const chunk of await f.service.openVerified(receipt, f.context)) chunks.push(chunk)
    expect(Buffer.concat(chunks)).toEqual(f.bytes)
  })
  it('resumes authoritative offset across reconnect/restart and returns one final receipt after lost ACK', async () => {
    const f = await fixture(); await f.service.start(f.intent, f.context)
    await f.service.append(f.intent.transferId, f.context, f.chunk(0))
    expect((await f.service.append(f.intent.transferId, f.context, f.chunk(0))).durableOffset).toBe(4)
    await f.service.close(); const resumed = f.create(), current = f.reconnect()
    expect((await resumed.status(f.intent.transferId, current)).durableOffset).toBe(4)
    await expect(resumed.append(f.intent.transferId, f.context, f.chunk(4))).rejects.toThrow('Denied')
    await resumed.append(f.intent.transferId, current, f.chunk(4))
    const receipt = await resumed.finish(f.intent.transferId, current)
    expect(await resumed.finish(f.intent.transferId, current)).toEqual(receipt)
    expect(await resumed.resolveVerifiedReceipt(f.intent.transferId, current)).toEqual(receipt)
    const stream = await resumed.openVerified(receipt, current), chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    expect(Buffer.concat(chunks)).toEqual(f.bytes)
    await expect(resumed.openVerified({ ...receipt, receiptId: randomUUID() }, current)).rejects.toThrow('Unrecognized')
  })
  it('restarts the original admission after the first journal fsync fails', async () => {
    const f = await fixture(); f.fail('journal-sync')
    await expect(f.service.start(f.intent, f.context)).rejects.toThrow('Injected')
    expect(await readFile(join(f.root, `${f.intent.transferId}.part`))).toHaveLength(0)
    f.fail(); await f.service.close()
    const restarted = f.create(), current = f.reconnect()
    await expect(restarted.start(f.intent, f.context)).rejects.toThrow('Denied')
    expect((await restarted.start(f.intent, current)).durableOffset).toBe(0)
    await restarted.append(f.intent.transferId, current, f.chunk(0))
    await restarted.append(f.intent.transferId, current, f.chunk(4))
    expect((await restarted.finish(f.intent.transferId, current)).sha256).toBe(f.intent.sha256)
  })
  it('reconciles a crash-left pre-journal part only after stopped-owner lock removal', async () => {
    const f = await fixture()
    await writeFile(join(f.root, `${f.intent.transferId}.part`), 'uncommitted', { mode: 0o600 })
    await mkdir(join(f.root, `${f.intent.transferId}.lock`), { mode: 0o700 })
    await expect(f.service.start(f.intent, f.context)).rejects.toThrow()
    await rm(join(f.root, `${f.intent.transferId}.lock`), { recursive: true })
    expect((await f.service.start(f.intent, f.context)).durableOffset).toBe(0)
    expect(await readFile(join(f.root, `${f.intent.transferId}.part`))).toHaveLength(0)
  })
  it('truncates uncommitted tails after data write/journal fsync failure before ACK', async () => {
    const f = await fixture(); await f.service.start(f.intent, f.context)
    f.fail('journal-sync')
    await expect(f.service.append(f.intent.transferId, f.context, f.chunk(0))).rejects.toThrow('Injected')
    f.fail(); expect((await f.service.status(f.intent.transferId, f.context)).durableOffset).toBe(0)
    expect((await readFile(join(f.root, `${f.intent.transferId}.part`))).length).toBe(0)
    await f.service.append(f.intent.transferId, f.context, f.chunk(0))
    await appendFile(join(f.root, `${f.intent.transferId}.part`), 'tail')
    expect((await f.service.status(f.intent.transferId, f.context)).durableOffset).toBe(4)
    expect(await readFile(join(f.root, `${f.intent.transferId}.part`))).toEqual(f.bytes.subarray(0, 4))
  })
  it('rejects offsets, size/hash lies and conflicting retries without advancing', async () => {
    const f = await fixture(); await f.service.start(f.intent, f.context)
    await expect(f.service.append(f.intent.transferId, f.context, f.chunk(4))).rejects.toThrow('offset')
    await expect(f.service.append(f.intent.transferId, f.context, { ...f.chunk(0), sha256: '0'.repeat(64) })).rejects.toThrow('Invalid')
    await expect(f.service.append(f.intent.transferId, f.context, f.chunk(0, Buffer.alloc(5)))).rejects.toThrow('allocation')
    await f.service.append(f.intent.transferId, f.context, f.chunk(0))
    await expect(f.service.append(f.intent.transferId, f.context, f.chunk(0, Buffer.from('oops')))).rejects.toThrow('Conflicting')
    await expect(f.service.finish(f.intent.transferId, f.context)).rejects.toThrow('integrity')
    await expect(f.service.start({ ...f.intent, sha256: '0'.repeat(64) }, f.context)).rejects.toThrow('immutable')
    expect((await f.service.status(f.intent.transferId, f.context)).durableOffset).toBe(4)
  })
  it('fails closed on corruption, missing bytes and whole-object hash mismatch', async () => {
    const f = await fixture(); await f.service.start({ ...f.intent, sha256: '0'.repeat(64) }, f.context)
    await f.service.append(f.intent.transferId, f.context, f.chunk(0)); await f.service.append(f.intent.transferId, f.context, f.chunk(4))
    await expect(f.service.finish(f.intent.transferId, f.context)).rejects.toThrow('integrity')
    await writeFile(join(f.root, `${f.intent.transferId}.part`), 'corrupt!', { mode: 0o600 })
    await expect(f.service.status(f.intent.transferId, f.context)).rejects.toThrow('corrupt')
    await rm(join(f.root, `${f.intent.transferId}.part`))
    await expect(f.service.status(f.intent.transferId, f.context)).rejects.toThrow()
  })
  it('reauthorizes revocation/expiry and never reports verified on fsync failure', async () => {
    const f = await fixture(); await f.service.start(f.intent, f.context); f.fail('data-sync')
    await expect(f.service.append(f.intent.transferId, f.context, f.chunk(0))).rejects.toThrow('Injected')
    f.fail(); expect((await f.service.status(f.intent.transferId, f.context)).verifiedBytes).toBe(0)
    f.revoke(); await expect(f.service.append(f.intent.transferId, f.context, f.chunk(0))).rejects.toThrow('Denied')
    const g = await fixture(); await g.service.start(g.intent, g.context); g.time(60_001)
    await expect(g.service.finish(g.intent.transferId, g.context)).rejects.toThrow('expired')
    const record = JSON.parse(await readFile(join(g.root, `${g.intent.transferId}.json`), 'utf8'))
    expect(record.payload.progress.state).toBe('cancelled')
  })
  it('removes retired transfers from active inventory while preserving restart replay denials', async () => {
    const f = await fixture(Buffer.alloc(0))
    await f.service.start(f.intent, f.context)
    await f.service.finish(f.intent.transferId, f.context)
    await f.service.retire(f.intent.transferId)
    expect(await f.service.inventory()).toEqual([])
    await f.service.retire(f.intent.transferId)
    await f.service.close()
    const restarted = f.create()
    expect(await restarted.inventory()).toEqual([])
    await expect(restarted.start(f.intent, f.context)).rejects.toThrow('cancelled')
    await expect(restarted.start({ ...f.intent, sha256: 'c'.repeat(64) }, f.context)).rejects.toThrow('immutable')
    const next = { ...f.intent, transferId: randomUUID() }
    expect((await restarted.start(next, f.context)).state).toBe('allocated')
  })

  it('keeps external reservations in active inventory when canonical bytes are retired', async () => {
    const f = await fixture(Buffer.alloc(0))
    await f.service.start(f.intent, f.context)
    await f.service.reserve(f.intent, f.context, { kind: 'rsync-source', byteSize: 0 })
    await f.service.retire(f.intent.transferId)
    expect(await f.service.inventory()).toEqual([f.intent])
    expect(await f.service.hasReservation(f.intent, 'rsync-source')).toBe(true)
    await f.service.release(f.intent, 'rsync-source')
    await f.service.retire(f.intent.transferId)
    expect(await f.service.inventory()).toEqual([])
    expect(await f.service.hasReservation(f.intent, 'rsync-source')).toBe(false)
  })

  it('accepts zero bytes, tombstones cancellation and rejects other principals', async () => {
    const f = await fixture(Buffer.alloc(0)); await f.service.start(f.intent, f.context)
    await expect(f.service.status(f.intent.transferId, { ...f.context, deviceId: randomUUID() })).rejects.toThrow('principal')
    const receipt = await f.service.finish(f.intent.transferId, f.context); expect(receipt.byteSize).toBe(0)
    await f.service.cancel(f.intent.transferId, f.context)
    await expect(f.service.resolveVerifiedReceipt(f.intent.transferId, f.context)).rejects.toThrow('cancelled')
  })
  it('reserves persisted per-device quota and bounded chunk budget', async () => {
    const f = await fixture(); await f.service.start(f.intent, f.context)
    await f.service.start({ ...f.intent, transferId: randomUUID() }, f.context)
    await expect(f.service.start({ ...f.intent, transferId: randomUUID() }, f.context)).rejects.toThrow('quota')
    await expect(f.service.start({ ...f.intent, chunkBytes: BYTE_TRANSFER_POLICY.maxChunkBytes + 1 }, f.context)).rejects.toThrow()
  })
  it('rejects competing receiver writers rather than stealing a lock', async () => {
    const f = await fixture(); await f.service.start(f.intent, f.context)
    const other = f.create(); await other.start(f.intent, f.context)
    let announce!: () => void
    let release!: () => void
    const writing = new Promise<void>(resolve => { announce = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    f.beforeDataSync(async () => { announce(); await gate })
    const winner = f.service.append(f.intent.transferId, f.context, f.chunk(0))
    await writing
    try {
      await expect(other.append(f.intent.transferId, f.context, f.chunk(0))).rejects.toThrow('busy')
    } finally {
      release()
      expect((await winner).durableOffset).toBe(4)
    }
    expect((await f.service.status(f.intent.transferId, f.context)).durableOffset).toBe(4)
  })
  it('reconciles a lost final ACK after directory fsync failure without another receipt', async () => {
    const f = await fixture(Buffer.alloc(0)); await f.service.start(f.intent, f.context)
    f.fail('directory-sync'); await expect(f.service.finish(f.intent.transferId, f.context)).rejects.toThrow('Injected')
    f.fail(); const receipt = await f.service.finish(f.intent.transferId, f.context)
    expect(await f.service.finish(f.intent.transferId, f.context)).toEqual(receipt)
  })
  it('anchors disk writes through ancestor swaps and rejects multiply linked bytes', async () => {
    const f = await fixture(); await f.service.start(f.intent, f.context)
    const moved = f.root + '-moved'; roots.push(moved)
    await rename(f.root, moved)
    const outside = await mkdtemp(join(fixtureRoot, '.graphql-outside-test-')); roots.push(outside)
    await symlink(outside, f.root)
    await f.service.append(f.intent.transferId, f.context, f.chunk(0))
    expect(await readFile(join(moved, `${f.intent.transferId}.part`))).toEqual(f.bytes.subarray(0, 4))
    await expect(readFile(join(outside, `${f.intent.transferId}.part`))).rejects.toThrow()
    await link(join(moved, `${f.intent.transferId}.part`), join(moved, 'another-link'))
    await expect(f.service.status(f.intent.transferId, f.context)).rejects.toThrow('Unsafe')
  })
  it('bounds cleanup and preserves cancellation tombstones after expiry', async () => {
    const f = await fixture()
    const other = { ...f.intent, transferId: randomUUID() }
    await f.service.start(f.intent, f.context)
    await f.service.start(other, f.context)
    f.time(60_001)
    expect(await f.service.cleanupExpired(1)).toBe(1)
    expect(await f.service.inventory()).toHaveLength(1)
    expect(await f.service.cleanupExpired(1)).toBe(1)
    expect(await f.service.cleanupExpired(1)).toBe(0)
    expect(await f.service.inventory()).toEqual([])
    await f.service.close()
    const restarted = f.create()
    expect(await restarted.inventory()).toEqual([])
    for (const intent of [f.intent, other]) {
      await expect(restarted.cancel(intent.transferId, { ...f.context, deviceId: randomUUID() }))
        .rejects.toThrow('principal')
      expect((await restarted.cancel(intent.transferId, f.context)).state).toBe('cancelled')
      await expect(restarted.start({
        ...intent,
        expiresAt: new Date(Date.parse(intent.expiresAt) + 60_000).toISOString(),
      }, f.context)).rejects.toThrow('immutable')
    }
  })
  it('reclaims expired unfinished transfers before admitting another one for the device', async () => {
    const f = await fixture()
    const stale = [randomUUID(), randomUUID()]
    for (const transferId of stale) {
      await f.service.start({ ...f.intent, transferId }, f.context)
      await f.service.append(transferId, f.context, f.chunk(0))
    }
    await expect(f.service.start({ ...f.intent, transferId: randomUUID() }, f.context)).rejects.toThrow('quota exceeded')
    f.time(60_001)
    const next = { ...f.intent, transferId: randomUUID(), expiresAt: new Date(Date.now() + 120_000).toISOString() }
    await f.service.start(next, f.context)
    expect(await f.service.inventory()).toEqual([next])
    await f.service.close()
    const restarted = f.create()
    expect(await restarted.inventory()).toEqual([next])
    await restarted.append(next.transferId, f.context, f.chunk(0))
    await restarted.append(next.transferId, f.context, f.chunk(4))
    expect((await restarted.finish(next.transferId, f.context)).sha256).toBe(next.sha256)
    for (const transferId of stale) {
      expect(await restarted.cancel(transferId, f.context)).toMatchObject({
        transferId,
        state: 'cancelled',
        durableOffset: 4,
        verifiedBytes: 0,
      })
      await expect(restarted.start({ ...next, transferId }, f.context)).rejects.toThrow('immutable')
    }
  })
  it('rejects symlink ancestors and hardlinked/symlink partial files', async () => {
    const f = await fixture(); const parent = join(f.root, 'real'); await mkdir(parent, { mode: 0o700 }); await symlink(parent, join(f.root, 'alias'))
    const service = new ResumableByteTransferService(join(f.root, 'alias', 'child'), { authorize: async () => {} }); services.push(service)
    await expect(service.start(f.intent, f.context)).rejects.toThrow('ancestor')
    await f.service.start(f.intent, f.context); await rm(join(f.root, `${f.intent.transferId}.part`))
    await symlink('/etc/passwd', join(f.root, `${f.intent.transferId}.part`))
    await expect(f.service.status(f.intent.transferId, f.context)).rejects.toThrow()
  })
})

describe('external staging on the shared durable quota', () => {
  it('keeps canonical bytes charged after deletion while a verified reader still owns them', async () => {
    const f = await fixture(); await f.service.start(f.intent, f.context)
    await f.service.append(f.intent.transferId, f.context, f.chunk(0)); await f.service.append(f.intent.transferId, f.context, f.chunk(4))
    const receipt = await f.service.finish(f.intent.transferId, f.context), reader = await f.service.openVerified(receipt, f.context)
    try {
      await f.create().cancel(f.intent.transferId, f.context)
      const source = { ...f.intent, transferId: randomUUID(), byteSize: BYTE_TRANSFER_POLICY.maxSourceBytes }
      const allocation = { kind: 'rsync-source' as const, byteSize: source.byteSize * 2 }
      await expect(f.service.reserve(source, f.context, allocation)).rejects.toThrow('quota')
      await expect(reader.toArray()).rejects.toThrow('cancelled')
      await f.service.retire(f.intent.transferId)
      await f.service.reserve(source, f.context, allocation)
    } finally {
      if (!reader.closed) {
        const closed = new Promise<void>(resolve => { reader.once('close', resolve) })
        reader.destroy(); await closed
      }
    }
  })
  it('keeps cancelled canonical bytes charged when durable deletion is unconfirmed', async () => {
    const f = await fixture(), intent = { ...f.intent, byteSize: BYTE_TRANSFER_POLICY.maxSourceBytes }
    await f.service.start(intent, f.context); f.fail('directory-sync')
    await expect(f.service.cancel(intent.transferId, f.context)).rejects.toThrow('Injected')
    f.fail()
    const source = { ...intent, transferId: randomUUID() }, allocation = { kind: 'rsync-source' as const, byteSize: intent.byteSize * 2 }
    await expect(f.service.reserve(source, f.context, allocation)).rejects.toThrow('quota')
    await f.service.retire(intent.transferId)
    await f.service.reserve(source, f.context, allocation)
  })
  it('shares the existing persistent record cap with external-only journals', async () => {
    const f = await fixture()
    for (let index = 0; index < BYTE_TRANSFER_POLICY.maxRecords; index++) {
      await writeFile(join(f.root, `${randomUUID()}.json`), '', { mode: 0o600 })
    }
    await expect(f.service.reserve(f.intent, f.context, { kind: 'rsync-receiver', byteSize: f.intent.byteSize * 3 })).rejects.toThrow('record quota')
  })

  it('reserves source-only bytes without a canonical part and keeps exact retries immutable across restart', async () => {
    const f = await fixture(), allocation = { kind: 'rsync-source' as const, byteSize: f.intent.byteSize * 2 }
    await f.service.reserve(f.intent, f.context, allocation)
    const initial = await readFile(join(f.root, `${f.intent.transferId}.json`), 'utf8')
    await expect(readFile(join(f.root, `${f.intent.transferId}.part`))).rejects.toThrow()
    await expect(f.service.status(f.intent.transferId, f.context)).rejects.toThrow('not started')
    f.time(1000); await f.service.reserve(f.intent, f.context, allocation)
    expect(await readFile(join(f.root, `${f.intent.transferId}.json`), 'utf8')).toBe(initial)
    await f.service.close(); const resumed = f.create(), current = f.reconnect()
    await expect(resumed.reserve(f.intent, f.context, allocation)).rejects.toThrow('Denied')
    await resumed.reserve(f.intent, current, allocation)
    expect(await readFile(join(f.root, `${f.intent.transferId}.json`), 'utf8')).toBe(initial)
    await expect(resumed.reserve({ ...f.intent, sha256: '0'.repeat(64) }, current, allocation)).rejects.toThrow('immutable')
    await expect(resumed.reserve(f.intent, current, { ...allocation, byteSize: 1 })).rejects.toThrow('footprint')
  })
  it('adds canonical and receiver bytes to the same device budget and never drops holds on cancellation', async () => {
    const f = await fixture(), intent = { ...f.intent, byteSize: BYTE_TRANSFER_POLICY.maxStagingPerDeviceBytes / 4 }
    await f.service.reserve(intent, f.context, { kind: 'rsync-receiver', byteSize: intent.byteSize * 3 })
    await f.service.start(intent, f.context)
    const other = { ...intent, transferId: randomUUID(), byteSize: 1 }
    await expect(f.service.start(other, f.context)).rejects.toThrow('quota')
    await f.service.cancel(intent.transferId, f.context)
    await f.service.start({ ...other, byteSize: intent.byteSize }, f.context)
    await expect(f.service.reserve({ ...intent, transferId: randomUUID(), byteSize: 1 }, f.context,
      { kind: 'rsync-receiver', byteSize: 3 })).rejects.toThrow('quota')
    await f.service.release(intent, 'rsync-receiver')
    await f.service.release(intent, 'rsync-receiver')
    await f.service.reserve({ ...intent, transferId: randomUUID(), byteSize: 1 }, f.context, { kind: 'rsync-receiver', byteSize: 3 })
    await expect(f.service.reserve(intent, f.context, { kind: 'rsync-receiver', byteSize: intent.byteSize * 3 })).rejects.toThrow()
  })
  it('admits canonical bytes for the same logical transfer at the device active limit', async () => {
    const f = await fixture(), second = { ...f.intent, transferId: randomUUID() }
    await f.service.reserve(f.intent, f.context, { kind: 'rsync-receiver', byteSize: f.intent.byteSize * 3 })
    await f.service.reserve(second, f.context, { kind: 'rsync-source', byteSize: second.byteSize * 2 })
    await f.service.start(f.intent, f.context)
    await expect(f.service.start({ ...second, transferId: randomUUID() }, f.context)).rejects.toThrow('quota')
    await f.service.cancel(f.intent.transferId, f.context)
    await expect(f.service.start({ ...second, transferId: randomUUID() }, f.context)).rejects.toThrow('quota')
    await f.service.release(f.intent, 'rsync-receiver')
    await f.service.start({ ...second, transferId: randomUUID() }, f.context)
  })
  it('shares global bytes and active limits across devices and service instances', async () => {
    const f = await fixture()
    const source = { ...f.intent, byteSize: BYTE_TRANSFER_POLICY.maxSourceBytes }
    await f.service.reserve(source, f.context, { kind: 'rsync-source', byteSize: source.byteSize * 2 })
    const context = { ...f.context, deviceId: randomUUID() }, second = { ...source, transferId: randomUUID(), deviceId: context.deviceId }
    await f.create().reserve(second, context, { kind: 'rsync-source', byteSize: second.byteSize * 2 })
    const thirdContext = { ...context, deviceId: randomUUID() }, third = { ...second, transferId: randomUUID(), deviceId: thirdContext.deviceId, byteSize: 1 }
    await expect(f.service.start(third, thirdContext)).rejects.toThrow('quota')
    await f.service.release(source, 'rsync-source'); await f.service.release(second, 'rsync-source')
    for (let index = 0; index < BYTE_TRANSFER_POLICY.maxActiveGlobal; index++) {
      const current = { ...f.context, deviceId: randomUUID() }, intent = { ...f.intent, transferId: randomUUID(), deviceId: current.deviceId }
      await f.service.reserve(intent, current, { kind: 'rsync-receiver', byteSize: intent.byteSize * 3 })
    }
    await expect(f.service.start({ ...f.intent, transferId: randomUUID() }, f.context)).rejects.toThrow('quota')
  })
  it('does not renew original TTL or idle deadline and retains expired holds until trusted cleanup', async () => {
    const f = await fixture(), intent = { ...f.intent, byteSize: BYTE_TRANSFER_POLICY.maxSourceBytes }
    const allocation = { kind: 'rsync-source' as const, byteSize: intent.byteSize * 2 }
    await f.service.reserve(intent, f.context, allocation); f.time(60_001)
    await expect(f.service.reserve(intent, f.context, allocation)).rejects.toThrow('expired')
    await expect(f.service.reserve({ ...intent, expiresAt: new Date(Date.parse(intent.expiresAt) + 60_000).toISOString() }, f.context, allocation))
      .rejects.toThrow('immutable')
    const fresh = { ...intent, transferId: randomUUID(), byteSize: 1, expiresAt: new Date(Date.parse(intent.expiresAt) + 60_000).toISOString() }
    await expect(f.service.start(fresh, f.context)).rejects.toThrow('quota')
    f.revoke(); await f.service.release(intent, 'rsync-source')
    await expect(f.service.reserve(fresh, f.context, { kind: 'rsync-receiver', byteSize: 3 })).rejects.toThrow('Denied')
    const g = await fixture(), long = { ...g.intent, expiresAt: new Date(Date.parse(g.intent.expiresAt) + 10 * 60_000).toISOString() }
    await g.service.reserve(long, g.context, { kind: 'rsync-receiver', byteSize: long.byteSize * 3 })
    g.time(BYTE_TRANSFER_POLICY.maxIdleMs)
    await expect(g.service.reserve(long, g.context, { kind: 'rsync-receiver', byteSize: long.byteSize * 3 })).rejects.toThrow('expired')
  })
  it('keeps both kinds charged independently and retains release conflict identity', async () => {
    const f = await fixture()
    await f.service.reserve(f.intent, f.context, { kind: 'rsync-source', byteSize: f.intent.byteSize * 2 })
    await f.service.reserve(f.intent, f.context, { kind: 'rsync-receiver', byteSize: f.intent.byteSize * 3 })
    await expect(f.service.release({ ...f.intent, placementHash: '0'.repeat(64) }, 'rsync-source')).rejects.toThrow('immutable')
    await f.service.release(f.intent, 'rsync-source')
    const payload = JSON.parse(await readFile(join(f.root, `${f.intent.transferId}.json`), 'utf8')).payload
    expect(payload.external['rsync-source']).toEqual({ byteSize: f.intent.byteSize * 2, released: true })
    expect(payload.external['rsync-receiver'].released).toBe(false)
    await expect(f.service.reserve(f.intent, f.context, { kind: 'rsync-source', byteSize: f.intent.byteSize * 2 })).rejects.toThrow('released')
  })
  it('rechecks current authority after durable retry synchronization before ACK', async () => {
    const f = await fixture(), allocation = { kind: 'rsync-source' as const, byteSize: f.intent.byteSize * 2 }
    await f.service.reserve(f.intent, f.context, allocation)
    const retained = await readFile(join(f.root, `${f.intent.transferId}.json`), 'utf8')
    let revoked = false
    const retry = new ResumableByteTransferService(f.root, { authorize: async () => {
      if (revoked) throw new Error('Denied current authority')
    } }, Date.now, async point => { if (point === 'directory-sync') revoked = true })
    services.push(retry)
    await expect(retry.reserve(f.intent, f.context, allocation)).rejects.toThrow('Denied')
    expect(await readFile(join(f.root, `${f.intent.transferId}.json`), 'utf8')).toBe(retained)
  })
  it('commits holds before ACK and fails closed on the shared allocation lock', async () => {
    const f = await fixture(), allocation = { kind: 'rsync-receiver' as const, byteSize: f.intent.byteSize * 3 }
    f.fail('journal-sync'); await expect(f.service.reserve(f.intent, f.context, allocation)).rejects.toThrow('Injected')
    await expect(readFile(join(f.root, `${f.intent.transferId}.json`))).rejects.toThrow()
    f.fail('directory-sync'); await expect(f.service.reserve(f.intent, f.context, allocation)).rejects.toThrow('Injected')
    f.fail(); const retained = await readFile(join(f.root, `${f.intent.transferId}.json`), 'utf8')
    await f.service.reserve(f.intent, f.context, allocation)
    expect(await readFile(join(f.root, `${f.intent.transferId}.json`), 'utf8')).toBe(retained)
    await mkdir(join(f.root, 'allocation.lock'), { mode: 0o700 })
    await expect(f.create().reserve(f.intent, f.context, allocation)).rejects.toThrow()
    await rm(join(f.root, 'allocation.lock'), { recursive: true })
  })
})
