import { removeFixtureDirectory } from './helpers/testResources.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { MAX_FILE_BYTES, FileWithRevisionSchema } from '@foreman-code/contracts/files'
import { registerOperatorHttpSecurity } from '../src/modules/access/http.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { DomainError } from '../src/modules/errors.js'
import { PostgresFileConversationAuthorization } from '../src/modules/files/authorization.js'
import { PostgresFileRepository } from '../src/modules/files/postgres.js'
import { TemporaryFileService } from '../src/modules/files/service.js'
import { FileByteStorage } from '../src/modules/files/storage.js'
import { registerFileRoutes } from '../src/routes/files.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

const body = Buffer.from('# upload action regression\n')
const metadata = { filename: 'upload.md', mediaType: 'text/markdown' as const,
  byteSize: body.length, sha256: createHash('sha256').update(body).digest('hex') }

describe.skipIf(!postgresEnabled)('FIL-03 upload IDs are not Operator chat actions', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>, app: FastifyInstance, root: string
  let access: PostgresAccessService, repository: PostgresFileRepository
  let operator: Awaited<ReturnType<PostgresOperatorRepository['ensure']>>
  let conversations: PostgresOperatorConversationRepository
  beforeAll(async () => {
    database = await agent3Database()
    access = new PostgresAccessService(database.pool)
    repository = new PostgresFileRepository(database.pool)
    operator = await new PostgresOperatorRepository(database.pool).ensure()
    conversations = new PostgresOperatorConversationRepository(database.pool)
    root = await mkdtemp(join(homedir(), '.fil03-action-test-'))
    const service = new TemporaryFileService(repository, new FileByteStorage(root, MAX_FILE_BYTES),
      new PostgresFileConversationAuthorization(database.pool))
    app = Fastify()
    registerOperatorHttpSecurity(app, access)
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError
      ? error.status : error instanceof z.ZodError ? 400 : 500).send({ error: {
      code: error instanceof DomainError ? error.code : 'INVALID_REQUEST',
    } }))
    registerFileRoutes(app, service)
    // These handlers must never be reached by a read/write-only credential.
    app.post('/api/operator/conversations/:conversationId/cancel', () => assert.fail('chat cancel was authorized'))
    app.post('/api/operator/conversations/:conversationId/responses', () => assert.fail('chat respond was authorized'))
    await app.ready()
  }, 30_000)
  afterAll(async () => {
    await app?.close()
    if (root) await removeFixtureDirectory(root)
    await database?.close()
  })
  async function owner() {
    const credential = await access.issue({ name: 'Read/write files only', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write'], scope: {} }] })
    const conversation = await conversations.create(operator.operator.id, operator.configuration, credential.principal.id)
    return { ...credential, root: `/api/operator/conversations/${conversation.id}`, headers: {
      host: 'localhost', authorization: `Bearer ${credential.token}`,
    } }
  }

  for (const requestId of ['cancel', 'responses']) {
    it(`allocates, uploads, finalizes and cancels pending '${requestId}' without cancel/respond grants`, async () => {
      const accepted = await owner()
      const allocated = await app.inject({ method: 'POST', url: `${accepted.root}/files/uploads`,
        headers: accepted.headers, payload: { requestId, ...metadata } })
      assert.equal(allocated.statusCode, 201, allocated.body)
      const value = FileWithRevisionSchema.parse(allocated.json().value)
      const uploaded = await app.inject({ method: 'PUT', url: `${accepted.root}/files/uploads/${requestId}`,
        headers: { ...accepted.headers, 'content-type': 'application/octet-stream' }, payload: body })
      assert.equal(uploaded.statusCode, 200, uploaded.body)
      const finalized = await app.inject({ method: 'POST', url: `${accepted.root}/files/uploads/${requestId}/finalize`,
        headers: accepted.headers, payload: {} })
      assert.equal(finalized.statusCode, 200, finalized.body)
      assert.equal(finalized.json().value.file.state, 'ready')
      const download = await app.inject({ method: 'GET', headers: accepted.headers,
        url: `${accepted.root}/files/${value.file.fileId}/revisions/${value.revision.revisionId}/content` })
      assert.equal(download.statusCode, 200, download.body)
      assert.deepEqual(download.rawPayload, body)
      assert.equal((await repository.read(value.file.fileId, value.revision.revisionId))?.value.file.state, 'ready')
      assert.equal((await app.inject({ method: 'DELETE', url: `${accepted.root}/files/uploads/${requestId}`,
        headers: accepted.headers })).statusCode, 409) // Still cannot cancel an accepted file.

      // requestId is unique per principal, so a second equally restricted owner tests pending cancellation.
      const pending = await owner()
      const allocation = await app.inject({ method: 'POST', url: `${pending.root}/files/uploads`,
        headers: pending.headers, payload: { requestId, ...metadata } })
      assert.equal(allocation.statusCode, 201, allocation.body)
      const pendingValue = FileWithRevisionSchema.parse(allocation.json().value)
      const upload = await app.inject({ method: 'PUT', url: `${pending.root}/files/uploads/${requestId}`,
        headers: { ...pending.headers, 'content-type': 'application/octet-stream' }, payload: body })
      assert.equal(upload.statusCode, 200, upload.body)
      assert.equal((await app.inject({ method: 'DELETE', url: `${pending.root}/files/uploads/${requestId}`,
        headers: accepted.headers })).statusCode, 404) // Same grants do not confer ownership.
      const canceled = await app.inject({ method: 'DELETE', url: `${pending.root}/files/uploads/${requestId}`,
        headers: pending.headers })
      assert.equal(canceled.statusCode, 200, canceled.body)
      assert.equal((await repository.read(pendingValue.file.fileId, pendingValue.revision.revisionId))?.value.file.state, 'removed')
      for (const action of ['cancel', 'responses']) {
        assert.equal((await app.inject({ method: 'POST', url: `${accepted.root}/${action}`,
          headers: accepted.headers, payload: {} })).statusCode, 403)
      }
      assert.equal((await app.inject({ method: 'PUT', url: `${accepted.root}/files/uploads/${requestId}`,
        headers: { host: 'localhost', authorization: 'Bearer invalid', 'content-type': 'application/octet-stream' }, payload: body })).statusCode, 401)
    })
  }
})
