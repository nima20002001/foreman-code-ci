import { hashWork } from '../../../test/helpers/hashWork.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { TransferContext, TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { ResumableByteTransferService } from './service.js'

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

it.each([8192, 65536])('keeps receiver hashing linear for %i-byte chunks and detects changed committed bytes', async chunkBytes => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent, 'transfer-hash-'))
  // Sixteen prefixes cost 7.5 payloads to rehash, exceeding the unchanged six-payload budget.
  const bytes = Buffer.alloc(chunkBytes * 16, 97)
  const context: TransferContext = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID() }
  const intent: TransferIntent = { ...context, version: 1, transferId: randomUUID(), operationId: randomUUID(),
    executionId: 'execution', attemptId: randomUUID(), placementHash: 'a'.repeat(64), rootId: randomUUID(),
    rootBindingRevision: 1, direction: 'to-main', byteClass: 'source', sha256: digest(bytes), byteSize: bytes.length,
    manifestDigest: 'b'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(), chunkBytes }
  const service = new ResumableByteTransferService(root, { authorize: async () => {} })
  try {
    await service.start(intent, context)
    hashWork.bytes = 0
    hashWork.limit = bytes.length * 6
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
      const chunk = bytes.subarray(offset, offset + chunkBytes)
      expect((await service.append(intent.transferId, context, { offset, bytes: chunk, sha256: digest(chunk) }))
        .durableOffset).toBe(offset + chunk.length)
    }
    hashWork.limit = Infinity
    const receipt = await service.finish(intent.transferId, context)
    expect(receipt.sha256).toBe(intent.sha256)
    await writeFile(join(root, `${intent.transferId}.part`), Buffer.alloc(bytes.length, 98), { mode: 0o600 })
    await expect(service.status(intent.transferId, context)).rejects.toThrow('corrupt')
  } finally {
    hashWork.limit = Infinity
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('counts original and copied hash updates without changing SHA-256 results', () => {
  hashWork.bytes = 0
  hashWork.limit = 5
  try {
    const original = createHash('sha256').update('a')
    const copied = original.copy().update(Uint8Array.of(98, 99))
    original.update('é')
    expect(hashWork.bytes).toBe(5)
    expect(copied.digest('hex')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(() => original.update(Buffer.from('f'))).toThrow('Hash work exceeded the linear delivery budget')
  } finally {
    hashWork.bytes = 0
    hashWork.limit = Infinity
  }
})
