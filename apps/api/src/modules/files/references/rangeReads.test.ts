import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import type { ReadStream } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { FileReferenceRepository, StoredFile } from '../repository.js'
import { FileByteStorage } from '../storage.js'
import { AgentReferenceService } from './agentService.js'
import { FileReferenceService } from './service.js'

for (const caller of ['operator', 'agent'] as const) {
  it(`${caller} reads reuse verification and read only the requested positioned bytes`, async () => {
    const parent = join(homedir(), '.cache', 'foreman-tmp')
    await mkdir(parent, { recursive: true })
    const root = await mkdtemp(join(parent, 'reference-ranges-'))
    const content = Buffer.from('0123456789abcdef'.repeat(32768))
    const scope = { kind: 'workspace_reference' as const, workspaceId: 'workspace' }
    const createdAt = '2026-01-01T00:00:00.000Z'
    const revision = { fileId: 'file', revisionId: 'revision', filename: 'notes.md', mediaType: 'text/markdown' as const,
      byteSize: content.length, sha256: createHash('sha256').update(content).digest('hex'), origin: 'upload' as const, createdAt }
    const stored: StoredFile = { storageKey: randomUUID(), ownerPrincipalId: 'owner', value: {
      file: { fileId: 'file', currentRevisionId: 'revision', state: 'ready', scope, createdAt }, revision,
    } }
    const principal: ManagementPrincipal = { id: 'caller', name: 'Caller', audience: 'operator',
      expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, grants: [] }
    const storage = new FileByteStorage(root, content.length)
    try {
      const candidate = await storage.receive(stored.storageKey, Readable.from([content]), revision)
      await storage.stage(candidate, revision)
      await storage.finalize(stored.storageKey, revision)
      const repository = { read: async () => stored } as unknown as FileReferenceRepository
      const operator = new FileReferenceService(repository, storage, { resolve: async () => scope },
        { execute: async () => { throw new Error('Unexpected mutation') } })
      const agent = new AgentReferenceService({ bytes: storage, files: repository,
        authorization: { resolve: async () => ({ workspaceId: 'workspace', workflowId: 'workflow', agentId: 'agent' }) },
        reads: { pinned: async () => new Map(), complete: async (_context, _ref, _at, authorize) => {
          await authorize({} as never)
          return 'ready'
        } },
      }).forExecution(principal)
      const read = (offset: number, length: number) => {
        const input = { fileId: 'file', revisionId: 'revision', offset, length }
        return caller === 'operator' ? operator.read(principal, scope, input) : agent.read(input)
      }
      expect((await read(0, 1)).status).toBe('ready')
      const probe = await open(join(root, 'objects', stored.storageKey))
      const prototype = Object.getPrototypeOf(probe)
      await probe.close()
      let descriptorBytes = 0
      const streams: ReadStream[] = []
      const originalRead = prototype.read
      const originalStream = prototype.createReadStream
      const readSpy = vi.spyOn(prototype, 'read').mockImplementation(async function (this: unknown, ...args: unknown[]) {
        const result = await originalRead.apply(this, args)
        descriptorBytes += result.bytesRead
        return result
      })
      const streamSpy = vi.spyOn(prototype, 'createReadStream').mockImplementation(function (this: unknown, ...args: unknown[]) {
        const stream = originalStream.apply(this, args)
        streams.push(stream)
        return stream
      })
      try {
        for (const offset of [content.length - 20, content.length - 13]) {
          const result = await read(offset, 13)
          expect(result.status).toBe('ready')
          if (result.status !== 'ready') throw new Error('Expected a readable reference')
          expect(Buffer.from(result.contentBase64, 'base64')).toEqual(content.subarray(offset, offset + 13))
          expect(result.byteLength).toBe(13)
        }
        expect(descriptorBytes).toBe(26)
        expect(streams.reduce((sum, stream) => sum + stream.bytesRead, 0)).toBeLessThanOrEqual(26)
      } finally {
        readSpy.mockRestore()
        streamSpy.mockRestore()
      }
      const eof = await read(content.length, 13)
      expect(eof.status).toBe('ready')
      if (eof.status !== 'ready') throw new Error('Expected an EOF result')
      expect(eof.byteLength).toBe(0)
      expect(eof.eof).toBe(true)
      await expect(storage.download(stored.storageKey, { ...revision, sha256: '0'.repeat(64) },
        { offset: 0, length: 1 })).rejects.toMatchObject({ code: 'FILE_HASH_MISMATCH' })
      const object = join(root, 'objects', stored.storageKey)
      await chmod(object, 0o600)
      await writeFile(object, Buffer.alloc(content.length, 120))
      await expect(read(0, 13)).rejects.toMatchObject({ code: 'FILE_HASH_MISMATCH' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}
