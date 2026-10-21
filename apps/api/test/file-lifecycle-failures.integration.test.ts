import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, it, vi } from 'vitest'
import { FilePageSchema } from '@foreman-code/contracts/files'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import {
  allocate, base, contentUrl, fil14Database, finalize, headers, markdown, owner, reread, upload,
  type Fil14Database, type Runtime,
} from './helpers/fil14Lifecycle.js'

// Fail only the selected syscall for THIS test's managed allocation. Every other open,
// write, link, fsync, unlink and database operation is real. Do not fill a real disk or
// change account/directory security settings to manufacture ENOSPC/EIO.
const fault = vi.hoisted(() => ({
  kind: null as null | 'write' | 'stage-link' | 'publish-link' | 'object-fsync' | 'cancel-remove',
  directory: '', object: '', objects: '', hits: 0,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const fail = (syscall: string, code = 'EIO') => {
    fault.hits++
    return Object.assign(new Error(`FIL-14 injected ${code} at ${syscall}`), { code, syscall })
  }
  return { ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const path = String(args[0])
      if (fault.kind === 'write' && path.startsWith(`${fault.directory}/`) && path.endsWith('.part')) {
        vi.spyOn(handle, 'write').mockImplementationOnce(async () => { throw fail('write', 'ENOSPC') })
      }
      if (fault.kind === 'object-fsync' && path === fault.objects) {
        vi.spyOn(handle, 'sync').mockImplementationOnce(async () => { throw fail('fsync') })
      }
      return handle
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      if (fault.kind === 'stage-link' && String(args[1]) === `${fault.directory}/verified`) throw fail('link')
      if (fault.kind === 'publish-link' && String(args[1]) === fault.object) throw fail('link')
      return actual.link(...args)
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (fault.kind === 'cancel-remove' && String(args[0]) === fault.directory) throw fail('rm')
      return actual.rm(...args)
    },
  }
})

describe.skipIf(!postgresEnabled)('FIL-14 real storage with narrowly injected disk/publication failures', () => {
  let database: Fil14Database, runtime: Runtime
  beforeAll(async () => { database = await fil14Database(); runtime = await database.open() }, 60_000)
  afterEach(() => { fault.kind = null; vi.restoreAllMocks() })
  afterAll(async () => { fault.kind = null; await database?.close() })

  // FIL-03 uses no-clobber link()+directory fsync, NOT rename(). Inject at the actual
  // publication operation rather than claiming a mock of unused rename() verifies it.
  for (const phase of ['write', 'stage-link', 'publish-link', 'object-fsync'] as const) {
    it(`${phase} failure exposes no ready file, preserves pins, and recovers after restart`, async () => {
      const who = await owner(runtime), requestId = randomUUID()
      const value = await allocate(runtime, who, requestId), stored = await reread(runtime, value)
      fault.directory = join(database.root, 'staging', stored.storageKey)
      fault.object = join(database.root, 'objects', stored.storageKey)
      fault.objects = join(database.root, 'objects'); fault.hits = 0
      if (phase === 'publish-link' || phase === 'object-fsync') {
        assert.equal((await upload(runtime, who, requestId, markdown.bytes)).statusCode, 200)
      }
      fault.kind = phase
      try {
        const failed = phase === 'write' || phase === 'stage-link'
          ? await upload(runtime, who, requestId, markdown.bytes) : await finalize(runtime, who, requestId)
        assert.equal(failed.statusCode, 500, failed.body)
        assert.equal(fault.hits, 1, 'The intended syscall fault must actually be exercised')
      } finally { fault.kind = null; vi.restoreAllMocks() }
      const current = await reread(runtime, value)
      assert.equal(current.value.file.state, 'pending')
      assert.deepEqual(current.value, value)
      const sql = await runtime.pool.query<{ n: number }>("select count(*)::int as n from files where file_id=$1 and state='ready'", [value.file.fileId])
      assert.equal(sql.rows[0]!.n, 0)
      const hidden = await runtime.app.inject({ method: 'GET', url: contentUrl(who, value), headers: headers(who) })
      assert.equal(hidden.statusCode, 409, hidden.body)
      const listed = await runtime.app.inject({ method: 'GET', url: base(who), headers: headers(who) })
      assert.equal(listed.statusCode, 200, listed.body)
      assert.deepEqual(FilePageSchema.parse(listed.json()).items, [value])
      if (phase === 'object-fsync') {
        // An unpublished object may exist after link succeeds but fsync fails. Metadata
        // must not advertise it; a fresh finalizer must reverify rather than allocate again.
        assert.deepEqual(await readFile(fault.object), markdown.bytes)
      } else await assert.rejects(readFile(fault.object), { code: 'ENOENT' })
      assert.ok(!(await readdir(fault.directory)).some((name) => name.endsWith('.part')))
      const restarted = await database.open()
      try {
        assert.deepEqual(await allocate(restarted, who, requestId), value)
        if (phase === 'write' || phase === 'stage-link') {
          assert.equal((await upload(restarted, who, requestId, markdown.bytes)).statusCode, 200)
        }
        const recovered = await finalize(restarted, who, requestId)
        assert.equal(recovered.statusCode, 200, recovered.body)
        assert.equal(recovered.json().value.file.state, 'ready')
        assert.equal(recovered.json().value.file.fileId, value.file.fileId)
        assert.deepEqual(recovered.json().value.revision, value.revision)
        const downloaded = await restarted.app.inject({ method: 'GET', url: contentUrl(who, value), headers: headers(who) })
        assert.equal(downloaded.statusCode, 200, downloaded.body)
        assert.deepEqual(downloaded.rawPayload, markdown.bytes)
        assert.deepEqual(await readdir(fault.directory), [])
        const count = await restarted.pool.query<{ n: number }>('select count(*)::int as n from file_revisions where file_id=$1', [value.file.fileId])
        assert.equal(count.rows[0]!.n, 1)
      } finally { await restarted.close() }
    })
  }

  it('commits cancellation before failing disk removal; retry and late writers cannot resurrect it', async () => {
    const who = await owner(runtime), requestId = randomUUID(), value = await allocate(runtime, who, requestId)
    assert.equal((await upload(runtime, who, requestId, markdown.bytes)).statusCode, 200)
    const stored = await reread(runtime, value)
    fault.directory = join(database.root, 'staging', stored.storageKey); fault.hits = 0; fault.kind = 'cancel-remove'
    try {
      const canceled = await runtime.app.inject({ method: 'DELETE', url: `${base(who)}/uploads/${requestId}`, headers: headers(who), payload: {} })
      assert.equal(canceled.statusCode, 500, canceled.body)
      assert.equal(fault.hits, 1)
    } finally { fault.kind = null }
    assert.equal((await reread(runtime, value)).value.file.state, 'removed')
    assert.deepEqual(await readFile(join(fault.directory, 'verified')), markdown.bytes)
    const restarted = await database.open()
    try {
      assert.equal((await upload(restarted, who, requestId, markdown.bytes)).statusCode, 409)
      assert.equal((await finalize(restarted, who, requestId)).statusCode, 409)
      const retried = await restarted.app.inject({ method: 'DELETE', url: `${base(who)}/uploads/${requestId}`, headers: headers(who), payload: {} })
      assert.equal(retried.statusCode, 200, retried.body)
      assert.equal(retried.json().replayed, true)
      assert.equal(retried.json().value.file.state, 'removed')
      assert.deepEqual(retried.json().value.revision, value.revision)
      await assert.rejects(readdir(fault.directory), { code: 'ENOENT' })
      const downloaded = await restarted.app.inject({ method: 'GET', url: contentUrl(who, value), headers: headers(who) })
      assert.equal(downloaded.statusCode, 410, downloaded.body)
    } finally { await restarted.close() }
  })
})
