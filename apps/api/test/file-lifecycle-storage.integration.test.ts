import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { FilePageSchema, FileWithRevisionSchema, MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import { PostgresFileRepository } from '../src/modules/files/postgres.js'
import type { AllocationSession, AllocationState, FileMutationContext } from '../src/modules/files/repository.js'
import { FileByteStorage } from '../src/modules/files/storage.js'
import { readFileRetentionSnapshot } from '../src/modules/files/retentionSnapshot.js'
import { fileFixtures, fileMetadata } from './helpers/fileFixtures.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { allocate, anotherChat, base, contentUrl, fil14Database, finalize, headers, markdown, owner, ready, reread, upload, type Fil14Database, type Runtime } from './helpers/fil14Lifecycle.js'
import { deferred } from './helpers/deferred.js'

/** Real authenticated HTTP, PostgreSQL receipts and real disk. No product edits.
 * Missing TEST_DATABASE_URL skips this suite; that is not passed verification. */
describe.skipIf(!postgresEnabled)('FIL-14 storage, isolation and restart verification', () => {
  let database: Fil14Database, runtime: Runtime
  beforeAll(async () => { database = await fil14Database(); runtime = await database.open() }, 60_000)
  afterAll(async () => { await database?.close() })

  for (const fixture of fileFixtures) {
    it(`${fixture.mediaType}: byte-identical pinned HTTP read after a fresh pool/service restart`, async () => {
      const writer = await database.open()
      const who = await owner(writer), accepted = await ready(writer, who, fixture)
      const original = await reread(writer, accepted.value)
      await writer.close()
      const restarted = await database.open()
      try {
        const replay = await finalize(restarted, who, accepted.requestId)
        assert.equal(replay.statusCode, 200, replay.body)
        assert.equal(replay.json().replayed, true)
        assert.deepEqual(FileWithRevisionSchema.parse(replay.json().value), accepted.value)
        assert.deepEqual(await reread(restarted, accepted.value), original)
        const downloaded = await restarted.app.inject({ method: 'GET', url: contentUrl(who, accepted.value), headers: headers(who) })
        assert.equal(downloaded.statusCode, 200, downloaded.body)
        assert.deepEqual(downloaded.rawPayload, fixture.bytes)
        assert.equal(downloaded.headers['content-length'], String(fixture.bytes.length))
        assert.equal(downloaded.headers['content-type'], fixture.mediaType)
        assert.equal(downloaded.headers['cache-control'], 'private, no-store')
        assert.equal(downloaded.headers['x-content-type-options'], 'nosniff')
        assert.match(String(downloaded.headers['content-disposition']), /^attachment;/)
        assert.deepEqual(await readFile(join(database.root, 'objects', original.storageKey)), fixture.bytes)
        const listed = await restarted.app.inject({ method: 'GET', url: base(who), headers: headers(who) })
        assert.equal(listed.statusCode, 200, listed.body)
        assert.deepEqual(FilePageSchema.parse(listed.json()).items, [accepted.value])
      } finally { await restarted.close() }
    })
  }

  it('isolates equal filenames with different bytes in two Operator chats of the same owner', async () => {
    const first = await owner(runtime), second = await anotherChat(runtime, first)
    const different = { ...markdown, bytes: Buffer.from('# The OTHER chat\nNo shared content.\n') }
    const a = await ready(runtime, first, markdown), b = await ready(runtime, second, different)
    assert.equal(a.value.revision.filename, b.value.revision.filename)
    assert.notEqual(a.value.file.fileId, b.value.file.fileId)
    assert.notEqual(a.value.revision.revisionId, b.value.revision.revisionId)
    const storedA = await reread(runtime, a.value), storedB = await reread(runtime, b.value)
    assert.notEqual(storedA.storageKey, storedB.storageKey)
    for (const [who, accepted, fixture] of [[first, a, markdown], [second, b, different]] as const) {
      const listed = await runtime.app.inject({ method: 'GET', url: base(who), headers: headers(who) })
      assert.equal(listed.statusCode, 200, listed.body)
      assert.deepEqual(FilePageSchema.parse(listed.json()).items, [accepted.value])
      const downloaded = await runtime.app.inject({ method: 'GET', url: contentUrl(who, accepted.value), headers: headers(who) })
      assert.equal(downloaded.statusCode, 200, downloaded.body)
      assert.deepEqual(downloaded.rawPayload, fixture.bytes)
      const scope = accepted.value.file.scope
      assert.equal(scope.kind, 'temporary')
      if (scope.kind !== 'temporary') assert.fail('Expected a conversation file')
      assert.deepEqual(Object.keys(scope.chat).sort(), ['conversationId', 'kind', 'operatorId', 'ownerPrincipalId'])
      assert.equal(scope.chat.conversationId, who.conversationId)
    }
    for (const [who, foreign] of [[first, b.value], [second, a.value]] as const) {
      assert.equal((await runtime.app.inject({ method: 'GET', url: contentUrl(who, foreign), headers: headers(who) })).statusCode, 404)
    }
    assert.deepEqual(await readFile(join(database.root, 'objects', storedA.storageKey)), markdown.bytes)
    assert.deepEqual(await readFile(join(database.root, 'objects', storedB.storageKey)), different.bytes)
  })

  it('rejects foreign principals, conversation IDs, request IDs and mixed pins without metadata/byte mutation', async () => {
    const who = await owner(runtime), chat = await anotherChat(runtime, who), foreign = await owner(runtime)
    const accepted = await ready(runtime, who), other = await ready(runtime, chat)
    const stored = await reread(runtime, accepted.value)
    const receipt = await runtime.pool.query('select * from file_allocations where owner_principal_id=$1 and request_id=$2',
      [who.principal.id, accepted.requestId])
    for (const [pathOwner, authOwner, value] of [
      [chat, who, accepted.value], [who, foreign, accepted.value],
      [who, who, { ...accepted.value, revision: other.value.revision }],
      [who, who, { ...accepted.value, revision: { ...accepted.value.revision, revisionId: randomUUID() } }],
      [{ ...who, conversationId: randomUUID() }, who, accepted.value],
    ] as const) {
      const reply = await runtime.app.inject({ method: 'GET', url: contentUrl(pathOwner, value), headers: headers(authOwner) })
      assert.equal(reply.statusCode, 404, reply.body)
    }
    for (const [pathOwner, authOwner] of [[chat, who], [who, foreign]] as const) {
      for (const method of ['PUT', 'POST', 'DELETE'] as const) {
        const reply = await runtime.app.inject({ method,
          url: `${base(pathOwner)}/uploads/${accepted.requestId}${method === 'POST' ? '/finalize' : ''}`,
          headers: { ...headers(authOwner), ...(method === 'PUT' ? { 'content-type': 'application/octet-stream' } : {}) },
          payload: method === 'PUT' ? markdown.bytes : {},
        })
        assert.equal(reply.statusCode, 404, `${method}: ${reply.body}`)
      }
    }
    assert.equal((await runtime.app.inject({ method: 'GET', url: base(who), headers: headers(foreign) })).statusCode, 404)
    assert.equal((await runtime.app.inject({ method: 'GET', url: base(who), headers: { host: 'localhost', authorization: 'Bearer invalid' } })).statusCode, 401)
    for (const [destination, metadata] of [[chat, fileMetadata(markdown)],
      [who, { ...fileMetadata(markdown), filename: 'changed.md' }],
      [who, fileMetadata({ ...markdown, bytes: Buffer.from('different bytes\n') })]] as const) {
      const reply = await runtime.app.inject({ method: 'POST', url: `${base(destination)}/uploads`, headers: headers(who),
        payload: { requestId: accepted.requestId, ...metadata } })
      assert.equal(reply.statusCode, 409, reply.body)
      assert.equal(reply.json().error.code, 'FILE_REQUEST_CONFLICT')
    }
    assert.deepEqual(await reread(runtime, accepted.value), stored)
    assert.deepEqual((await runtime.pool.query('select * from file_allocations where owner_principal_id=$1 and request_id=$2',
      [who.principal.id, accepted.requestId])).rows, receipt.rows)
    assert.deepEqual(await readFile(join(database.root, 'objects', stored.storageKey)), markdown.bytes)
  })

  const acknowledgements: ReadonlyArray<{ boundary: AllocationState; afterCommit: boolean }> = [
    { boundary: 'allocated', afterCommit: true },
    { boundary: 'staged', afterCommit: false }, { boundary: 'staged', afterCommit: true },
    { boundary: 'finalized', afterCommit: false }, { boundary: 'finalized', afterCommit: true },
  ]
  for (const fault of acknowledgements) {
    it(`recovers ${fault.boundary} ${fault.afterCommit ? 'committed-but-lost reply' : 'bytes published before metadata commit'} without duplication`, async () => {
      class LostAcknowledgement extends PostgresFileRepository {
        armed = true
        private lose(state: AllocationState, afterCommit: boolean) {
          if (this.armed && state === fault.boundary && afterCommit === fault.afterCommit) {
            this.armed = false; throw new Error('FIL-14 injected lost acknowledgement')
          }
        }
        override withAllocation<T>(ownerId: string, requestId: string,
          operation: (session: AllocationSession) => Promise<T>, mutation?: FileMutationContext): Promise<T> {
          return super.withAllocation(ownerId, requestId, async (session) => {
            const adapted: AllocationSession = { ...session,
              setState: async (state) => {
                this.lose(state, false)
                const result = await session.setState(state)
                this.lose(state, true)
                return result
              },
            }
            if (session.createWithRetention) {
              const create = session.createWithRetention
              adapted.createWithRetention = async (build) => {
                const result = await create(build)
                this.lose('allocated', true)
                return result
              }
            }
            return operation(adapted)
          }, mutation)
        }
      }
      const interrupted = await database.open({ repository: (pool) => new LostAcknowledgement(pool, readFileRetentionSnapshot) })
      const who = await owner(interrupted), requestId = randomUUID()
      try {
        const allocation = await interrupted.app.inject({ method: 'POST', url: `${base(who)}/uploads`, headers: headers(who),
          payload: { requestId, ...fileMetadata(markdown) } })
        assert.equal(allocation.statusCode, fault.boundary === 'allocated' ? 500 : 201, allocation.body)
        if (fault.boundary !== 'allocated') {
          const sent = await upload(interrupted, who, requestId, markdown.bytes)
          assert.equal(sent.statusCode, fault.boundary === 'staged' ? 500 : 200, sent.body)
          if (fault.boundary === 'finalized') {
            assert.equal((await finalize(interrupted, who, requestId)).statusCode, 500)
          }
        }
        const committed = await interrupted.files.withAllocation(who.principal.id, requestId, (session) => session.read())
        assert.ok(committed)
        const expectedState = fault.boundary === 'finalized' && fault.afterCommit ? 'ready' : 'pending'
        assert.equal(committed.stored.value.file.state, expectedState)
        const preRecovery = await interrupted.app.inject({ method: 'GET', url: contentUrl(who, committed.stored.value), headers: headers(who) })
        assert.equal(preRecovery.statusCode, expectedState === 'ready' ? 200 : 409, preRecovery.body)
        const original = committed.stored.value
        await interrupted.close() // Drop the actual pool, authentication/HTTP app and every fault flag.
        const restarted = await database.open()
        try {
          const replay = await restarted.app.inject({ method: 'POST', url: `${base(who)}/uploads`, headers: headers(who),
            payload: { requestId, ...fileMetadata(markdown) } })
          assert.equal(replay.statusCode, 200, replay.body)
          assert.equal(replay.json().replayed, true)
          assert.equal(replay.json().value.file.fileId, original.file.fileId)
          assert.deepEqual(replay.json().value.revision, original.revision)
          if (fault.boundary === 'allocated') assert.equal((await upload(restarted, who, requestId, markdown.bytes)).statusCode, 200)
          const finalized = await finalize(restarted, who, requestId)
          assert.equal(finalized.statusCode, 200, finalized.body)
          assert.equal(finalized.json().value.file.state, 'ready')
          const repeated = await finalize(restarted, who, requestId)
          assert.equal(repeated.statusCode, 200, repeated.body)
          assert.equal(repeated.json().replayed, true)
          assert.deepEqual(repeated.json().value, finalized.json().value)
          const repeatedUpload = await upload(restarted, who, requestId, markdown.bytes)
          assert.equal(repeatedUpload.statusCode, 200, repeatedUpload.body)
          assert.equal(repeatedUpload.json().replayed, true)
          const counts = await restarted.pool.query<{ allocations: number; revisions: number; files: number }>(`select
            (select count(*)::int from file_allocations where owner_principal_id=$1 and request_id=$2) as allocations,
            (select count(*)::int from file_revisions where file_id=$3) as revisions,
            (select count(*)::int from files where owner_principal_id=$1) as files`,
          [who.principal.id, requestId, original.file.fileId])
          assert.deepEqual(counts.rows[0], { allocations: 1, revisions: 1, files: 1 })
          const downloaded = await restarted.app.inject({ method: 'GET', url: contentUrl(who, original), headers: headers(who) })
          assert.equal(downloaded.statusCode, 200, downloaded.body)
          assert.deepEqual(downloaded.rawPayload, markdown.bytes)
          const stored = await reread(restarted, original)
          assert.deepEqual(await readFile(join(database.root, 'objects', stored.storageKey)), markdown.bytes)
          assert.deepEqual(await readdir(join(database.root, 'staging', stored.storageKey)), [])
        } finally { await restarted.close() }
      } finally { await interrupted.close() }
    })
  }

  it('a late concurrent upload retry cannot replace a finalized object or create a second receipt', async () => {
    const who = await owner(runtime), requestId = randomUUID(), value = await allocate(runtime, who, requestId)
    const received = deferred(), release = deferred()
    class PausedReceiver extends FileByteStorage {
      override async receive(...args: Parameters<FileByteStorage['receive']>) {
        const candidate = await super.receive(...args)
        received.resolve(); await release.promise
        return candidate
      }
    }
    const slow = await database.open({ bytes: new PausedReceiver(database.root, MAX_FILE_BYTES) })
    const sending = upload(slow, who, requestId, markdown.bytes)
    void sending.catch(() => undefined)
    try {
      await Promise.race([received.promise, sending.then(() => assert.fail('Retry skipped the receive barrier'))])
      // The first upload has an open attempt but no DB transaction/publication lock.
      // An independent authenticated application can complete this same request.
      const faster = await upload(runtime, who, requestId, markdown.bytes)
      assert.equal(faster.statusCode, 200, faster.body)
      const accepted = await finalize(runtime, who, requestId)
      assert.equal(accepted.statusCode, 200, accepted.body)
      const stable = await reread(runtime, value)
      release.resolve()
      const late = await sending
      assert.equal(late.statusCode, 200, late.body)
      assert.equal(late.json().replayed, true)
      assert.deepEqual(late.json().value, accepted.json().value)
      assert.deepEqual(await reread(runtime, value), stable)
      assert.deepEqual(await readFile(join(database.root, 'objects', stable.storageKey)), markdown.bytes)
      assert.deepEqual(await readdir(join(database.root, 'staging', stable.storageKey)), [])
      const counts = await runtime.pool.query<{ allocations: number; revisions: number }>(`select
        (select count(*)::int from file_allocations where owner_principal_id=$1 and request_id=$2) as allocations,
        (select count(*)::int from file_revisions where file_id=$3) as revisions`,
      [who.principal.id, requestId, value.file.fileId])
      assert.deepEqual(counts.rows[0], { allocations: 1, revisions: 1 })
    } finally {
      release.resolve(); await Promise.allSettled([sending]); await slow.close()
    }
  })

  it('rejects a partial HTTP body, then restarts and retries without truncating crash residue or changing pins', async () => {
    const first = await database.open(), who = await owner(first), requestId = randomUUID()
    try {
      const value = await allocate(first, who, requestId)
      const short = await upload(first, who, requestId, markdown.bytes.subarray(0, 9))
      assert.equal(short.statusCode, 422, short.body)
      assert.equal((await finalize(first, who, requestId)).statusCode, 409)
      const stored = await reread(first, value)
      assert.equal(stored.value.file.state, 'pending')
      assert.deepEqual(await readdir(join(database.root, 'staging', stored.storageKey)), [], 'Failed live attempts remove their part')
      const residue = join(database.root, 'staging', stored.storageKey, `${randomUUID()}.part`)
      // Materialize the exact durable residue of a killed writer. We do not label this a SIGKILL test.
      const partial = Buffer.from('unacknowledged earlier attempt')
      await writeFile(residue, partial, { mode: 0o600 })
      await first.close()
      const restarted = await database.open()
      try {
        const replayed = await allocate(restarted, who, requestId)
        assert.deepEqual(replayed, value)
        const download = await restarted.app.inject({ method: 'GET', url: contentUrl(who, value), headers: headers(who) })
        assert.equal(download.statusCode, 409)
        assert.equal((await upload(restarted, who, requestId, markdown.bytes)).statusCode, 200)
        const accepted = await finalize(restarted, who, requestId)
        assert.equal(accepted.statusCode, 200, accepted.body)
        assert.deepEqual(accepted.json().value.revision, value.revision)
        assert.equal(accepted.json().value.file.createdAt, value.file.createdAt)
        assert.deepEqual(await readFile(residue), partial, 'A retry must use a new private attempt, not truncate crash bytes')
        assert.deepEqual(await readFile(join(database.root, 'objects', stored.storageKey)), markdown.bytes)
        const rows = await restarted.pool.query('select allocation_id from file_allocations where owner_principal_id=$1 and request_id=$2',
          [who.principal.id, requestId])
        assert.equal(rows.rowCount, 1)
      } finally { await restarted.close() }
    } finally { await first.close() }
  })
})
