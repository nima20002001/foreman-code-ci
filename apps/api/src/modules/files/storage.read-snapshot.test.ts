import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { expect, it } from 'vitest'
import { FileDescriptionSchema } from '@foreman-code/contracts/files'
import { FileByteStorage } from './storage.js'

it('fences positioned immutable reads against backing changes and enforces bounds and closure', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent, 'file-read-snapshot-'))
  const bytes = Buffer.from('original file bytes')
  const expected = { filename: 'input.md', mediaType: 'text/markdown' as const, byteSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') }
  const storage = new FileByteStorage(root, 1024)
  const key = randomUUID()
  try {
    expect(FileDescriptionSchema.safeParse({
      filename: expected.filename, mediaType: expected.mediaType,
    }).success).toBe(true)
    const candidate = await storage.receive(key, Readable.from([bytes]), expected)
    await storage.stage(candidate, expected)
    await storage.finalize(key, expected)
    const reader = await storage.openRead(key, expected)
    try {
      expect(await reader.read(0, bytes.length)).toEqual(bytes)
      expect(await reader.read(9, 4)).toEqual(bytes.subarray(9, 13))
      await expect(reader.read(-1, 4)).rejects.toMatchObject({ code: 'FILE_RANGE_INVALID' })
      await expect(reader.read(bytes.length, 1)).rejects.toMatchObject({ code: 'FILE_RANGE_INVALID' })
      await chmod(join(root, 'objects', key), 0o600)
      await writeFile(join(root, 'objects', key), Buffer.alloc(bytes.length, 98))
      await expect(reader.read(0, 4)).rejects.toMatchObject({ code: 'FILE_BYTES_UNAVAILABLE' })
    } finally { await reader.close() }
    await expect(reader.read(0, 4)).rejects.toMatchObject({ code: 'FILE_BYTES_UNAVAILABLE' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
