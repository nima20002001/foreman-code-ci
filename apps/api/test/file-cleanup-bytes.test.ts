import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { link, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { ManagedFileCleanupBytes } from '../src/modules/files/cleanup/bytes.js'

async function fixture(work: (value: { root: string; bytes: ManagedFileCleanupBytes }) => Promise<void>) {
  const root = await mkdtemp(join(process.cwd(), '.fil04-bytes-'))
  const storage = { root, initialize: async () => {
    for (const area of ['objects', 'staging']) await mkdir(join(root, area), { mode: 0o700, recursive: true })
  } }
  await storage.initialize()
  const bytes = new ManagedFileCleanupBytes(storage)
  try { await work({ root, bytes }) } finally { await bytes.close(); await rm(root, { recursive: true, force: true }) }
}
async function absent(path: string) { await assert.rejects(readFile(path), { code: 'ENOENT' }) }

describe('FIL-04 bounded physical cleanup', () => {
  it('unlinks an expired object, verified staging, crash parts and the empty allocation directory; retry is harmless', async () => {
    await fixture(async ({ root, bytes }) => {
      const key = randomUUID(), allocation = join(root, 'staging', key)
      await mkdir(allocation, { mode: 0o700 })
      await writeFile(join(root, 'objects', key), 'object')
      await writeFile(join(allocation, 'verified'), 'verified')
      await writeFile(join(allocation, `${randomUUID()}.part`), 'interrupted upload')
      assert.equal(await bytes.remove(key), true)
      await absent(join(root, 'objects', key))
      assert.deepEqual(await readdir(join(root, 'staging')), [])
      assert.equal(await bytes.remove(key), true)
    })
  })

  it('leaves an admitted download and a permanent reference hard link byte-identical at expiry', async () => {
    await fixture(async ({ root, bytes }) => {
      const temporary = randomUUID(), permanent = randomUUID(), payload = Buffer.from('shared immutable bytes\n')
      const object = join(root, 'objects', temporary), reference = join(root, 'objects', permanent)
      await writeFile(object, payload); await link(object, reference)
      const admitted = await open(object, 'r')
      try {
        await bytes.remove(temporary)
        assert.deepEqual(await admitted.readFile(), payload)
        assert.deepEqual(await readFile(reference), payload)
        await absent(object)
      } finally { await admitted.close() }
    })
  })

  it('bounds allocation work and resumes until a large crash directory is empty', async () => {
    await fixture(async ({ root, bytes }) => {
      const key = randomUUID(), allocation = join(root, 'staging', key)
      await mkdir(allocation, { mode: 0o700 })
      for (let count = 0; count < 130; count++) await writeFile(join(allocation, `${randomUUID()}.part`), 'x')
      assert.equal(await bytes.remove(key), false)
      assert.equal((await readdir(allocation)).length, 66)
      assert.equal(await bytes.remove(key), false)
      assert.equal((await readdir(allocation)).length, 2)
      assert.equal(await bytes.remove(key), true)
      assert.deepEqual(await readdir(join(root, 'staging')), [])
    })
  })

  it('walks both managed areas in bounded pages and rediscovers residue created after a previous pass', async () => {
    await fixture(async ({ root, bytes }) => {
      const keys = Array.from({ length: 7 }, () => randomUUID()), seen = new Set<string>()
      for (const key of keys.slice(0, 3)) await writeFile(join(root, 'objects', key), 'x')
      for (const key of keys.slice(3)) await mkdir(join(root, 'staging', key), { mode: 0o700 })
      await writeFile(join(root, 'objects', 'not-an-internal-key'), 'unknown')
      let exhausted = false
      for (let count = 0; count < 10 && !exhausted; count++) {
        const page = await bytes.scan(2)
        assert.ok(page.keys.length <= 2)
        for (const key of page.keys) seen.add(key)
        exhausted = page.exhausted
      }
      assert.equal(exhausted, true); assert.deepEqual([...seen].sort(), keys.sort())
      const late = randomUUID()
      await mkdir(join(root, 'staging', late), { mode: 0o700 })
      assert.ok((await bytes.scan(100)).keys.includes(late))
      assert.equal(await readFile(join(root, 'objects', 'not-an-internal-key'), 'utf8'), 'unknown')
    })
  })

  it('never follows a staging-directory symlink or recursively removes unexpected children', async () => {
    await fixture(async ({ root, bytes }) => {
      const outside = join(root, 'untouched'), key = randomUUID(), other = randomUUID()
      await mkdir(outside, { mode: 0o700 }); await writeFile(join(outside, 'verified'), 'must remain')
      await symlink(outside, join(root, 'staging', key))
      await assert.rejects(bytes.remove(key), /private, owned/)
      assert.equal(await readFile(join(outside, 'verified'), 'utf8'), 'must remain')
      await mkdir(join(root, 'staging', other, 'unexpected'), { recursive: true, mode: 0o700 })
      await assert.rejects(bytes.remove(other), /Unexpected entry/)
      assert.deepEqual(await readdir(join(root, 'staging', other)), ['unexpected'])
    })
  })

  it('unlinks a leaf symlink without changing its target and rejects non-key paths', async () => {
    await fixture(async ({ root, bytes }) => {
      const key = randomUUID(), allocation = join(root, 'staging', key), target = join(root, 'keep')
      await mkdir(allocation, { mode: 0o700 }); await writeFile(target, 'unchanged')
      await symlink(target, join(allocation, 'verified'))
      await symlink(target, join(root, 'objects', key))
      assert.equal(await bytes.remove(key), true)
      assert.equal(await readFile(target, 'utf8'), 'unchanged')
      for (const bad of ['../keep', '/etc/passwd', 'filename.md', '']) await assert.rejects(bytes.remove(bad), /Invalid internal/)
    })
  })

  it('allows an already-open expired upload descriptor to finish without leaving publishable bytes', async () => {
    await fixture(async ({ root, bytes }) => {
      const key = randomUUID(), allocation = join(root, 'staging', key), part = join(allocation, `${randomUUID()}.part`)
      await mkdir(allocation, { mode: 0o700 })
      const receiving = await open(part, 'wx')
      try {
        await receiving.write('started before expiry')
        await bytes.remove(key)
        await receiving.write('finished after unlink')
        await absent(part)
        assert.deepEqual(await readdir(join(root, 'staging')), [])
      } finally { await receiving.close() }
    })
  })
})
