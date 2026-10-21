import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TransferContext, TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { ResumableByteTransferService } from './service.js'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const fixtureRoot = '/tmp'
const roots: string[] = [], services: ResumableByteTransferService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(bytes = Buffer.alloc(0)) {
  const root = await mkdtemp(join(fixtureRoot, '.graphql-receiver-durability-')); roots.push(root)
  let failure = false, denied = false, now = Date.now()
  const context: TransferContext = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID() }
  const intent: TransferIntent = { ...context, version: 1, transferId: randomUUID(), operationId: randomUUID(),
    executionId: randomUUID(), attemptId: randomUUID(), placementHash: hash(Buffer.from('placement')),
    rootId: randomUUID(), rootBindingRevision: 1, direction: 'to-main', byteClass: 'source',
    sha256: hash(bytes), byteSize: bytes.length, manifestDigest: hash(Buffer.from('manifest')),
    expiresAt: new Date(now + 60_000).toISOString(), chunkBytes: 4 }
  const create = () => {
    const service = new ResumableByteTransferService(root, { authorize: async () => {
      if (denied) throw new Error('Denied current authority')
    } }, () => now, async point => {
      if (failure && point === 'directory-sync') throw new Error('Injected directory sync failure')
    })
    services.push(service); return service
  }
  return { context, intent, service: create(), create,
    chunk: { offset: 0, bytes, sha256: hash(bytes) },
    journal: () => readFile(join(root, `${intent.transferId}.json`), 'utf8'),
    fail: () => { failure = true }, recover: () => { failure = false; now += 1000 },
    deny: () => { denied = true } }
}

describe.each([false, true])('canonical journal durability replay (restart=%s)', restart => {
  it.each(['finish', 'resolveVerifiedReceipt'] as const)('requires directory sync before %s returns the original receipt', async operation => {
    const f = await fixture(); await f.service.start(f.intent, f.context)
    f.fail()
    await expect(f.service.finish(f.intent.transferId, f.context)).rejects.toThrow('Injected directory sync failure')
    const original = await f.journal(), receipt = JSON.parse(original).payload.receipt
    expect(receipt.byteSize).toBe(0)
    let service = f.service
    if (restart) { await service.close(); service = f.create() }
    for (let retry = 0; retry < 2; retry++) {
      await expect(service[operation](f.intent.transferId, f.context)).rejects.toThrow('Injected directory sync failure')
      expect(await f.journal()).toBe(original)
    }
    f.recover()
    expect(await service[operation](f.intent.transferId, f.context)).toEqual(receipt)
    expect(await service.finish(f.intent.transferId, f.context)).toEqual(receipt)
    expect(await f.journal()).toBe(original)
    f.deny()
    await expect(service[operation](f.intent.transferId, f.context)).rejects.toThrow('Denied current authority')
  })

  it.each(['start', 'status'] as const)('requires directory sync before %s acknowledges a failed start', async operation => {
    const f = await fixture(); f.fail()
    await expect(f.service.start(f.intent, f.context)).rejects.toThrow('Injected directory sync failure')
    const original = await f.journal(), progress = JSON.parse(original).payload.progress
    let service = f.service
    if (restart) { await service.close(); service = f.create() }
    const replay = () => operation === 'start' ? service.start(f.intent, f.context) : service.status(f.intent.transferId, f.context)
    for (let retry = 0; retry < 2; retry++) {
      await expect(replay()).rejects.toThrow('Injected directory sync failure')
      expect(await f.journal()).toBe(original)
    }
    f.recover()
    expect(await replay()).toEqual(progress)
    expect(await f.journal()).toBe(original)
    f.deny(); await expect(replay()).rejects.toThrow('Denied current authority')
  })

  it.each(['start', 'status', 'append'] as const)('requires directory sync before %s acknowledges a failed append', async operation => {
    const f = await fixture(Buffer.from('abcd')); await f.service.start(f.intent, f.context)
    f.fail()
    await expect(f.service.append(f.intent.transferId, f.context, f.chunk)).rejects.toThrow('Injected directory sync failure')
    const original = await f.journal(), progress = JSON.parse(original).payload.progress
    expect(progress.durableOffset).toBe(4)
    let service = f.service
    if (restart) { await service.close(); service = f.create() }
    const replay = () => operation === 'start' ? service.start(f.intent, f.context)
      : operation === 'status' ? service.status(f.intent.transferId, f.context)
        : service.append(f.intent.transferId, f.context, f.chunk)
    for (let retry = 0; retry < 2; retry++) {
      await expect(replay()).rejects.toThrow('Injected directory sync failure')
      expect(await f.journal()).toBe(original)
    }
    f.recover()
    expect(await replay()).toEqual(progress)
    expect(await f.journal()).toBe(original)
    f.deny(); await expect(replay()).rejects.toThrow('Denied current authority')
  })
})
