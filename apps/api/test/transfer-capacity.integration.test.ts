import { randomUUID, createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { BYTE_TRANSFER_POLICY, type TransferContext, type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { ResumableByteTransferService } from '../src/modules/byte-transfer/service.js'

it('admits new transfers after retiring the record limit and preserves replay denials after restart', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent, 'transfer-capacity-'))
  const context: TransferContext = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID() }
  const intent: TransferIntent = { ...context, version: 1, transferId: randomUUID(), operationId: randomUUID(),
    executionId: 'execution', attemptId: randomUUID(), placementHash: 'a'.repeat(64), rootId: randomUUID(),
    rootBindingRevision: 1, direction: 'to-main', byteClass: 'source',
    sha256: createHash('sha256').digest('hex'), byteSize: 0, manifestDigest: 'b'.repeat(64),
    expiresAt: new Date(Date.now() + BYTE_TRANSFER_POLICY.maxLifetimeMs - 1000).toISOString(), chunkBytes: 8192 }
  let admissionSyncs = 0
  const createService = () => new ResumableByteTransferService(root, { authorize: async () => {} }, undefined,
    async point => { if (point === 'directory-sync') admissionSyncs++ })
  let service = createService()
  try {
    const lifecycleCount = BYTE_TRANSFER_POLICY.maxActiveGlobal * 2 + 1
    for (let index = 0; index < lifecycleCount; index++) {
      const current = { ...intent, transferId: index === 0 ? intent.transferId : randomUUID() }
      admissionSyncs = 0
      await service.start(current, context)
      expect(admissionSyncs).toBeLessThanOrEqual(BYTE_TRANSFER_POLICY.maxActiveGlobal + 2)
      expect((await service.inventory()).length).toBeLessThanOrEqual(BYTE_TRANSFER_POLICY.maxActiveGlobal)
      await service.finish(current.transferId, context)
      await service.retire(current.transferId)
      if (index === 0) expect(await service.inventory()).toEqual([])
    }
    await service.close()

    // Clone a service-created tombstone so the record-limit fixture avoids thousands of fsync-heavy lifecycles.
    const retired = join(root, 'retired')
    const template = JSON.parse(await readFile(join(retired, `${intent.transferId}.json`), 'utf8')).payload
    const replayIntents = [intent]
    for (let index = lifecycleCount; index < BYTE_TRANSFER_POLICY.maxRecords; index++) {
      const current = { ...intent, transferId: randomUUID() }
      const payload = {
        ...template,
        intent: current,
        progress: { ...template.progress, transferId: current.transferId },
      }
      const checksum = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
      await writeFile(join(retired, `${current.transferId}.json`), JSON.stringify({ checksum, payload }), { mode: 0o600 })
      if (index === Math.floor(BYTE_TRANSFER_POLICY.maxRecords / 2) || index === BYTE_TRANSFER_POLICY.maxRecords - 1) {
        replayIntents.push(current)
      }
    }

    service = createService()
    const next = { ...intent, transferId: randomUUID() }
    admissionSyncs = 0
    expect((await service.start(next, context)).state).toBe('allocated')
    expect(admissionSyncs).toBeLessThanOrEqual(BYTE_TRANSFER_POLICY.maxActiveGlobal + 2)
    expect((await service.inventory()).length).toBeLessThanOrEqual(BYTE_TRANSFER_POLICY.maxActiveGlobal)
    for (const replay of replayIntents) {
      await expect(service.start(replay, context)).rejects.toThrow('cancelled')
      await expect(service.start({ ...replay, sha256: 'c'.repeat(64) }, context)).rejects.toThrow('immutable')
    }
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
}, 180_000)
