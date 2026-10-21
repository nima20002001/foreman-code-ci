import { removeFixtureDirectory } from './helpers/testResources.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { MAX_FILE_BYTES, FilePageSchema, FileWithRevisionSchema, temporaryFileExpiresAt } from '@foreman-code/contracts/files'
import { fileStorageMigration } from '../src/infrastructure/fileStorageMigration.js'
import { registerOperatorHttpSecurity } from '../src/modules/access/http.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { DomainError } from '../src/modules/errors.js'
import { PostgresFileConversationAuthorization } from '../src/modules/files/authorization.js'
import { PostgresFileRepository } from '../src/modules/files/postgres.js'
import type { AllocationSession, AllocationState } from '../src/modules/files/repository.js'
import { TemporaryFileService } from '../src/modules/files/service.js'
import { FileByteStorage } from '../src/modules/files/storage.js'
import { registerFileRoutes } from '../src/routes/files.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { fileFixtures, fileMetadata } from './helpers/fileFixtures.js'

/** Real authenticated HTTP, PostgreSQL allocations and disk bytes; no native sessions or paid models. */
describe.skipIf(!postgresEnabled)('FIL-03 temporary file HTTP and repository integration', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>, app: FastifyInstance, root: string
  let access: PostgresAccessService, owner: Awaited<ReturnType<PostgresAccessService['issue']>>
  let other: Awaited<ReturnType<PostgresAccessService['issue']>>, first: string, second: string
  let repository: PostgresFileRepository, service: TemporaryFileService
  const base = (conversationId: string) => `/api/operator/conversations/${conversationId}/files`
  const headers = () => ({ authorization: `Bearer ${owner.token}`, host: 'localhost' })
  beforeAll(async () => {
    database = await agent3Database()
    // Explicit lane registration for this isolated schema; production migrations.ts is untouched.
    const applied = await database.pool.query('select 1 from application_migrations where version=$1', [fileStorageMigration.version])
    if (!applied.rowCount) {
      const client = await database.pool.connect()
      try {
        await client.query('begin'); await client.query(fileStorageMigration.sql)
        await client.query('insert into application_migrations(version) values($1)', [fileStorageMigration.version]); await client.query('commit')
      } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
    }
    root = await mkdtemp(join(homedir(), '.fil03-http-test-'))
    access = new PostgresAccessService(database.pool)
    const issue = (name: string) => access.issue({ name, audience: 'operator', expiresAt: new Date(Date.now() + 600000),
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write'], scope: {} }] })
    owner = await issue('File owner'); other = await issue('Other owner')
    const operator = await new PostgresOperatorRepository(database.pool).ensure()
    const conversations = new PostgresOperatorConversationRepository(database.pool)
    first = (await conversations.create(operator.operator.id, operator.configuration, owner.principal.id)).id
    second = (await conversations.create(operator.operator.id, operator.configuration, owner.principal.id)).id
    repository = new PostgresFileRepository(database.pool)
    service = new TemporaryFileService(repository, new FileByteStorage(root, MAX_FILE_BYTES), new PostgresFileConversationAuthorization(database.pool))
    app = Fastify()
    registerOperatorHttpSecurity(app, access)
    app.setErrorHandler((error, _request, reply) => {
      const status = error instanceof DomainError ? error.status : error instanceof z.ZodError ? 400 : 500
      return reply.code(status).send({ error: { code: error instanceof DomainError ? error.code : 'INVALID_REQUEST' } })
    })
    registerFileRoutes(app, service)
    await app.ready()
  })
  afterAll(async () => { await app?.close(); if (root) await removeFixtureDirectory(root); await database?.close() })
  async function allocate(requestId: string, fixture = fileFixtures[0]!, conversationId = first) {
    const reply = await app.inject({ method: 'POST', url: `${base(conversationId)}/uploads`, headers: headers(), payload: { requestId, ...fileMetadata(fixture) } })
    assert.ok([200, 201].includes(reply.statusCode), reply.body)
    return FileWithRevisionSchema.parse(reply.json().value)
  }
  async function upload(requestId: string, bytes: Buffer, conversationId = first) {
    return app.inject({ method: 'PUT', url: `${base(conversationId)}/uploads/${requestId}`,
      headers: { ...headers(), 'content-type': 'application/octet-stream' }, payload: bytes })
  }
  async function finalize(requestId: string) {
    return app.inject({ method: 'POST', url: `${base(first)}/uploads/${requestId}/finalize`, headers: headers(), payload: {} })
  }
  const content = (conversationId: string, fileId: string, revisionId: string) => `${base(conversationId)}/${fileId}/revisions/${revisionId}/content`

  for (const fixture of fileFixtures) {
    it(`${fixture.mediaType}: authenticated byte-identical HTTP download`, async () => {
      const requestId = randomUUID(), value = await allocate(requestId, fixture)
      assert.equal((await upload(requestId, fixture.bytes)).statusCode, 200)
      const committed = await finalize(requestId)
      assert.equal(committed.statusCode, 200, committed.body)
      assert.equal(FileWithRevisionSchema.parse(committed.json().value).file.state, 'ready')
      const download = await app.inject({ method: 'GET', url: content(first, value.file.fileId, value.revision.revisionId), headers: headers() })
      assert.equal(download.statusCode, 200, download.body)
      assert.deepEqual(download.rawPayload, fixture.bytes)
      assert.equal(download.headers['x-content-type-options'], 'nosniff')
      assert.equal(download.headers['cache-control'], 'private, no-store')
      assert.ok(String(download.headers['content-disposition']).startsWith('attachment;'))
      const scope = value.file.scope
      assert.equal(scope.kind, 'temporary')
      if (scope.kind !== 'temporary') assert.fail('Expected temporary scope')
      assert.deepEqual(Object.keys(scope.chat).sort(), ['conversationId', 'kind', 'operatorId', 'ownerPrincipalId'])
    })
  }
  it('isolates two Operator chats, even for their common owner; foreign and unauthed callers cannot read', async () => {
    const requestId = randomUUID(), value = await allocate(requestId)
    await upload(requestId, fileFixtures[0]!.bytes); await finalize(requestId)
    const rows = await app.inject({ method: 'GET', url: base(second), headers: headers() })
    assert.equal(rows.statusCode, 200)
    assert.deepEqual(FilePageSchema.parse(rows.json()).items, [])
    assert.equal((await app.inject({ method: 'GET', url: content(second, value.file.fileId, value.revision.revisionId), headers: headers() })).statusCode, 404)
    assert.equal((await app.inject({ method: 'GET', url: content(first, value.file.fileId, value.revision.revisionId),
      headers: { ...headers(), authorization: `Bearer ${other.token}` } })).statusCode, 404)
    assert.equal((await app.inject({ method: 'GET', url: base(first), headers: { host: 'localhost', authorization: 'Bearer invalid' } })).statusCode, 401)
    assert.equal((await app.inject({ method: 'GET', url: content(first, value.file.fileId, randomUUID()), headers: headers() })).statusCode, 404)
    assert.equal((await upload(requestId, fileFixtures[0]!.bytes, second)).statusCode, 404)
  })
  it('replays one allocation/revision and rejects changed metadata or a different conversation', async () => {
    const requestId = randomUUID(), value = await allocate(requestId)
    assert.deepEqual(await allocate(requestId), value)
    await upload(requestId, fileFixtures[0]!.bytes); await finalize(requestId)
    assert.equal((await finalize(requestId)).json().replayed, true)
    assert.equal((await upload(requestId, fileFixtures[0]!.bytes)).json().replayed, true)
    const count = await database.pool.query('select count(*)::int as n from file_allocations where owner_principal_id=$1 and request_id=$2', [owner.principal.id, requestId])
    assert.equal(count.rows[0].n, 1)
    for (const [conversationId, metadata] of [[first, { ...fileMetadata(fileFixtures[0]!), filename: 'different.png' }],
      [second, fileMetadata(fileFixtures[0]!)] ] as const) {
      const conflict = await app.inject({ method: 'POST', url: `${base(conversationId)}/uploads`, headers: headers(), payload: { requestId, ...metadata } })
      assert.equal(conflict.statusCode, 409, conflict.body)
    }
  })
  it('a partial HTTP upload can be retried; pending and canceled staging never download', async () => {
    const requestId = randomUUID(), fixture = fileFixtures[0]!, value = await allocate(requestId, fixture)
    assert.equal((await upload(requestId, fixture.bytes.subarray(0, 10))).statusCode, 422)
    assert.equal((await finalize(requestId)).statusCode, 409)
    assert.equal((await app.inject({ method: 'GET', url: content(first, value.file.fileId, value.revision.revisionId), headers: headers() })).statusCode, 409)
    assert.equal((await upload(requestId, fixture.bytes)).statusCode, 200)
    const canceled = await app.inject({ method: 'DELETE', url: `${base(first)}/uploads/${requestId}`, headers: headers() })
    assert.equal(canceled.statusCode, 200, canceled.body)
    assert.equal(canceled.json().value.file.state, 'removed')
    assert.equal((await upload(requestId, fixture.bytes)).statusCode, 409)
    assert.equal((await finalize(requestId)).statusCode, 409)
    const stored = await repository.read(value.file.fileId, value.revision.revisionId)
    assert.ok(stored)
    assert.ok(!(await readdir(join(root, 'objects'))).includes(stored.storageKey))
  })
  it('only unsent staging is cancelable; finalized files and foreign allocations are protected', async () => {
    const requestId = randomUUID(); await allocate(requestId); await upload(requestId, fileFixtures[0]!.bytes); await finalize(requestId)
    assert.equal((await app.inject({ method: 'DELETE', url: `${base(first)}/uploads/${requestId}`, headers: headers() })).statusCode, 409)
    assert.equal((await app.inject({ method: 'DELETE', url: `${base(first)}/uploads/${requestId}`,
      headers: { ...headers(), authorization: `Bearer ${other.token}` } })).statusCode, 404)
  })
  for (const fault of ['staged', 'finalized'] as const) {
    it(`recovers a lost ${fault} database acknowledgement after filesystem publication`, async () => {
      class CrashAcknowledgement extends PostgresFileRepository {
        remaining: AllocationState | undefined = fault
        override withAllocation<T>(ownerId: string, requestId: string, operation: (session: AllocationSession) => Promise<T>): Promise<T> {
          return super.withAllocation(ownerId, requestId, (session) => operation({ ...session, setState: async (state) => {
            if (state === this.remaining) { this.remaining = undefined; throw new Error('synthetic lost acknowledgement') }
            return session.setState(state)
          } }))
        }
      }
      const interrupted = new TemporaryFileService(new CrashAcknowledgement(database.pool), new FileByteStorage(root, MAX_FILE_BYTES), new PostgresFileConversationAuthorization(database.pool))
      const requestId = randomUUID(), fixture = fileFixtures[0]!, value = await allocate(requestId, fixture)
      const target = { kind: 'operator' as const, conversationId: first }
      const sending = interrupted.upload(owner.principal, target, requestId, Readable.from([fixture.bytes]))
      if (fault === 'staged') await assert.rejects(sending, /lost acknowledgement/)
      else { await sending; await assert.rejects(interrupted.finalize(owner.principal, target, requestId), /lost acknowledgement/) }
      const recovered = await service.finalize(owner.principal, target, requestId)
      assert.equal(recovered.value.file.fileId, value.file.fileId)
      assert.equal(recovered.value.revision.revisionId, value.revision.revisionId)
      const downloaded = await app.inject({ method: 'GET', url: content(first, value.file.fileId, value.revision.revisionId), headers: headers() })
      assert.deepEqual(downloaded.rawPayload, fixture.bytes)
    })
  }
  it('enforces strict scope columns, immutable revisions and due-only metadata expiration', async () => {
    const now = new Date(), createdAt = new Date(now.getTime() - 7200000).toISOString()
    const scope = await new PostgresFileConversationAuthorization(database.pool).resolve(owner.principal, { kind: 'operator', conversationId: first }, 'write')
    const fileId = randomUUID(), revisionId = randomUUID()
    const stored = await repository.create({ ownerPrincipalId: owner.principal.id, storageKey: randomUUID(), value: {
      file: { fileId, currentRevisionId: revisionId, scope, state: 'pending', createdAt, retentionDurationSeconds: 3600, expiresAt: temporaryFileExpiresAt(createdAt, 3600) },
      revision: { fileId, revisionId, ...fileMetadata(fileFixtures[0]!), origin: 'upload', createdAt },
    } })
    await assert.rejects(database.pool.query('update files set workspace_id=$2 where file_id=$1', [fileId, 'forbidden-workspace']))
    await assert.rejects(database.pool.query('update files set expires_at=null where file_id=$1', [fileId]))
    await assert.rejects(database.pool.query('update file_revisions set filename=$2 where revision_id=$1', [revisionId, 'rewrite.png']))
    assert.equal((await repository.markExpired(fileId, now.toISOString()))?.state, 'expired')
    assert.equal(await repository.markExpired(fileId, now.toISOString()), undefined)
    assert.deepEqual((await repository.read(fileId, revisionId))?.value.revision, stored.value.revision)
    const permanentId = randomUUID(), permanentRevision = randomUUID()
    const permanent = await repository.create({ ownerPrincipalId: owner.principal.id, storageKey: randomUUID(), value: {
      file: { fileId: permanentId, currentRevisionId: permanentRevision, scope: { kind: 'workspace_reference', workspaceId: 'future-workspace' }, state: 'ready', createdAt },
      revision: { fileId: permanentId, revisionId: permanentRevision, ...fileMetadata(fileFixtures[0]!), origin: 'upload', createdAt },
    } })
    assert.equal(await repository.markExpired(permanentId, now.toISOString()), undefined)
    assert.equal(permanent.value.file.state, 'ready')
    const page = await repository.list({ kind: 'workspace_reference', workspaceId: 'future-workspace' }, { limit: 1 }, now.toISOString())
    assert.deepEqual(page.items.map((row) => row.file.fileId), [permanentId])
    const operatorPage = await repository.list(scope, { limit: 1 }, now.toISOString())
    assert.ok(operatorPage.pageInfo.nextCursor)
    const otherScope = await new PostgresFileConversationAuthorization(database.pool).resolve(owner.principal, { kind: 'operator', conversationId: second }, 'read')
    await assert.rejects(repository.list(otherScope, { limit: 1, cursor: operatorPage.pageInfo.nextCursor }, now.toISOString()), { code: 'FILE_CURSOR_INVALID' })
  })
})
