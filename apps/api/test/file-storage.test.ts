import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import { FileByteStorage } from '../src/modules/files/storage.js'
import { fileFixtures, fileMetadata, traversalZip, expansionZip } from './helpers/fileFixtures.js'

describe('FIL-03 managed file bytes', () => {
  let root: string, storage: FileByteStorage
  beforeEach(async () => {
    root = await mkdtemp(join(process.cwd(), '.fil03-bytes-test-'))
    storage = new FileByteStorage(root, MAX_FILE_BYTES)
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  for (const fixture of fileFixtures) {
    it(`${fixture.mediaType}: chunked upload, retry and byte-identical download`, async () => {
      const id = randomUUID(), metadata = fileMetadata(fixture)
      const candidate = await storage.receive(id, Readable.from([
        fixture.bytes.subarray(0, 3), fixture.bytes.subarray(3, 19), fixture.bytes.subarray(19),
      ]), metadata)
      await storage.stage(candidate, metadata)
      await storage.discard(candidate)
      // Restart after verified staging / before database acknowledgement.
      const restarted = new FileByteStorage(root, MAX_FILE_BYTES)
      await restarted.finalize(id, metadata)
      // Restart after atomic publication / before database acknowledgement.
      await new FileByteStorage(root, MAX_FILE_BYTES).finalize(id, metadata)
      const chunks: Buffer[] = []
      for await (const chunk of await restarted.download(id, metadata)) chunks.push(chunk as Buffer)
      assert.deepEqual(Buffer.concat(chunks), fixture.bytes)
      assert.equal((await readdir(join(root, 'objects'))).length, 1)
    })
  }
  const markdown = fileFixtures.find((fixture) => fixture.mediaType === 'text/markdown')!
  it('cleans a truncated attempt and retries without appending or allocating another object', async () => {
    const id = randomUUID(), metadata = fileMetadata(markdown)
    await assert.rejects(storage.receive(id, Readable.from([markdown.bytes.subarray(0, 10)]), metadata), { code: 'FILE_SIZE_MISMATCH' })
    assert.deepEqual(await readdir(join(root, 'staging', id)), [])
    const candidate = await storage.receive(id, Readable.from([markdown.bytes]), metadata)
    await storage.stage(candidate, metadata); await storage.discard(candidate); await storage.finalize(id, metadata)
    assert.deepEqual(await readFile(join(root, 'objects', id)), markdown.bytes)
  })
  it('cleans a disconnected stream and does not leave a partial file', async () => {
    const id = randomUUID()
    async function* disconnected() { yield markdown.bytes.subarray(0, 2); throw new Error('disconnected') }
    await assert.rejects(storage.receive(id, Readable.from(disconnected()), fileMetadata(markdown)), /disconnected/)
    assert.deepEqual(await readdir(join(root, 'staging', id)), [])
  })
  it('serializes no-clobber staging for two completed retry attempts', async () => {
    const id = randomUUID(), metadata = fileMetadata(markdown)
    const first = await storage.receive(id, Readable.from([markdown.bytes]), metadata)
    const second = await storage.receive(id, Readable.from([markdown.bytes]), metadata)
    await storage.stage(first, metadata); await storage.stage(second, metadata)
    await storage.discard(first); await storage.discard(second); await storage.finalize(id, metadata)
    assert.deepEqual(await readFile(join(root, 'objects', id)), markdown.bytes)
  })
  it('rejects hash, length and actual type mismatches', async () => {
    const metadata = fileMetadata(markdown)
    await assert.rejects(storage.receive(randomUUID(), Readable.from([markdown.bytes]), { ...metadata, sha256: '0'.repeat(64) }), { code: 'FILE_HASH_MISMATCH' })
    await assert.rejects(storage.receive(randomUUID(), Readable.from([markdown.bytes]), { ...metadata, byteSize: markdown.bytes.length - 1 }), { code: 'FILE_SIZE_MISMATCH' })
    await assert.rejects(storage.receive(randomUUID(), Readable.from([markdown.bytes]), { ...metadata, filename: 'x.png', mediaType: 'image/png' }), { code: 'FILE_TYPE_INVALID' })
    await assert.rejects(storage.receive(randomUUID(), Readable.from([]), { ...metadata, byteSize: MAX_FILE_BYTES + 1 }), { code: 'FILE_TOO_LARGE' })
  })
  for (const bytes of [traversalZip, expansionZip]) {
    it('rejects unsafe archive members/expansion without extraction', async () => {
      const metadata = fileMetadata({ filename: 'bad.zip', mediaType: 'application/zip', bytes })
      await assert.rejects(storage.receive(randomUUID(), Readable.from([bytes]), metadata), { code: 'FILE_TYPE_INVALID' })
    })
  }
  it('rejects a ZIP relabeled as DOCX', async () => {
    const zip = fileFixtures.find((fixture) => fixture.mediaType === 'application/zip')!
    await assert.rejects(storage.receive(randomUUID(), Readable.from([zip.bytes]), {
      ...fileMetadata(zip), filename: 'bad.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }), { code: 'FILE_TYPE_INVALID' })
  })
  it('supports empty UTF-8 Markdown and rejects binary/invalid UTF-8', async () => {
    const empty = { filename: 'empty.md', mediaType: 'text/markdown' as const, bytes: Buffer.alloc(0) }
    const id = randomUUID(), metadata = fileMetadata(empty)
    const candidate = await storage.receive(id, Readable.from([]), metadata)
    await storage.stage(candidate, metadata); await storage.discard(candidate); await storage.finalize(id, metadata)
    assert.equal((await readFile(join(root, 'objects', id))).length, 0)
    for (const bytes of [Buffer.from([0, 1]), Buffer.from([0xff, 0xfe])]) {
      await assert.rejects(storage.receive(randomUUID(), Readable.from([bytes]), fileMetadata({ ...empty, bytes })), { code: 'FILE_TYPE_INVALID' })
    }
  })
  it('detects missing and corrupted immutable bytes, never substitutes another revision', async () => {
    const id = randomUUID(), metadata = fileMetadata(markdown)
    await assert.rejects(storage.download(id, metadata), { code: 'FILE_BYTES_UNAVAILABLE' })
    const candidate = await storage.receive(id, Readable.from([markdown.bytes]), metadata)
    await storage.stage(candidate, metadata); await storage.discard(candidate); await storage.finalize(id, metadata)
    await chmod(join(root, 'objects', id), 0o600)
    await writeFile(join(root, 'objects', id), Buffer.alloc(markdown.bytes.length))
    await assert.rejects(storage.download(id, metadata), { code: 'FILE_HASH_MISMATCH' })
  })
  it('rejects /tmp, overlapping roots and symbolic links before writing through them', async () => {
    await assert.rejects(new FileByteStorage('/tmp/fil03-forbidden', MAX_FILE_BYTES).initialize())
    await assert.rejects(new FileByteStorage(root, MAX_FILE_BYTES, [root]).initialize())
    await symlink(root, join(root, 'alias'))
    await assert.rejects(new FileByteStorage(join(root, 'alias', 'child'), MAX_FILE_BYTES).initialize())
    assert.ok(!(await readdir(root)).includes('child'))
  })
  it('bounds chunked bytes independently of Content-Length and removes the rejected attempt', async () => {
    const id = randomUUID()
    async function* excessive() {
      for (let i = 0; i < MAX_FILE_BYTES / 65536; i++) yield Buffer.alloc(65536, 65)
      yield Buffer.from('A')
    }
    await assert.rejects(storage.receive(id, Readable.from(excessive()), {
      ...fileMetadata(markdown), byteSize: MAX_FILE_BYTES,
    }), { code: 'FILE_TOO_LARGE' })
    assert.deepEqual(await readdir(join(root, 'staging', id)), [])
  })
  it('cleans up a pre-aborted upload with a retryable 408', async () => {
    const id = randomUUID(), controller = new AbortController()
    controller.abort()
    await assert.rejects(storage.receive(id, Readable.from([markdown.bytes]), fileMetadata(markdown), controller.signal), { status: 408 })
    assert.deepEqual(await readdir(join(root, 'staging', id)), [])
  })
  it('rejects CRC corruption even when the submitted SHA-256 matches the corrupted bytes', async () => {
    const original = fileFixtures.find((fixture) => fixture.mediaType === 'image/png')!
    const bytes = Buffer.from(original.bytes)
    bytes[29] = bytes[29]! ^ 1
    await assert.rejects(storage.receive(randomUUID(), Readable.from([bytes]), fileMetadata({ ...original, bytes })), { code: 'FILE_TYPE_INVALID' })
  })

})
