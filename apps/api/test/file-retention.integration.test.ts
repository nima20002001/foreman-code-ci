import { readUntil } from './helpers/observableCondition.js'
import { decodeMcpToolResult, OperatorCompactCapabilitiesSchema } from '@foreman-code/contracts/operator-mcp'
import { removeFixtureDirectory } from './helpers/testResources.js'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import { afterAll, beforeAll, describe, it } from 'vitest'
import {
  DEFAULT_FILE_RETENTION_SECONDS, MAX_FILE_BYTES, FileWithRevisionSchema,
  FileRetentionGetResultSchema, FileRetentionSaveResultSchema, FileRetentionPreviewResultSchema,
  TemporaryFileSchema, temporaryFileExpiresAt, type FileState,
} from '@foreman-code/contracts/files'
import type { ManagementGrant } from '@foreman-code/contracts/management'

import {
  beginTransaction, commitTransaction, rollbackTransaction, withTransaction,
} from '../src/infrastructure/transaction.js'
import { fileStorageMigration } from '../src/infrastructure/fileStorageMigration.js'
import { fileRetentionMigration } from '../src/infrastructure/fileRetentionMigration.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { registerGraphqlMcp } from '../src/mcp/unified/transport.js'
import { registerOperatorHttpSecurity } from '../src/modules/access/http.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { DomainError } from '../src/modules/errors.js'
import { PostgresFileConversationAuthorization } from '../src/modules/files/authorization.js'
import { PostgresFileRepository } from '../src/modules/files/postgres.js'
import { FileRetentionService } from '../src/modules/files/retention.js'
import { readFileRetentionSnapshot } from '../src/modules/files/retentionSnapshot.js'
import { TemporaryFileService } from '../src/modules/files/service.js'
import { FileByteStorage } from '../src/modules/files/storage.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { FILE_RETENTION_PATH, registerFileRetentionRoutes } from '../src/routes/fileRetention.js'
import { registerFileRoutes } from '../src/routes/files.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

type Credential = Awaited<ReturnType<PostgresAccessService['issue']>>
type Owner = Credential & { conversationId: string }
type McpResult = { isError?: boolean; structuredContent?: unknown; tools?: { name: string }[];
  content?: { type: string; text?: string }[] }
const metadata = { filename: 'retention.md', mediaType: 'text/markdown' as const,
  byteSize: 0, sha256: createHash('sha256').update('').digest('hex') }
const grants: ManagementGrant[] = [{ actions: ['settings:read', 'settings:update', 'operator_chat:read', 'operator_chat:write'], scope: {} }]
const headers = (owner: Credential) => ({ authorization: `Bearer ${owner.token}`, host: 'localhost' })
const root = (owner: Owner) => `/api/operator/conversations/${owner.conversationId}/files`
const payload = (durationSeconds: number, expectedRevision = 0, applyToExisting = false) => ({
  commandId: randomUUID(), expectedRevision, durationSeconds, applyToExisting,
})

/** Real PostgreSQL transactions, credentials, HTTP and authenticated /mcp. No native harness/model. */
describe.skipIf(!postgresEnabled)('FIL-40 retention persistence and transport parity', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>, app: FastifyInstance, storageRoot: string, address: string
  let access: PostgresAccessService, commands: PostgresCommandCoordinator, retention: FileRetentionService
  let files: PostgresFileRepository, bytes: FileByteStorage, authorization: PostgresFileConversationAuthorization
  let operator: Awaited<ReturnType<PostgresOperatorRepository['ensure']>>
  let conversations: PostgresOperatorConversationRepository

  beforeAll(async () => {
    database = await agent3Database()
    // FIL-03 is already registered at this base; tolerate later integration of FIL-40 too.
    for (const migration of [fileStorageMigration, fileRetentionMigration]) {
      const found = await database.pool.query('select 1 from application_migrations where version=$1', [migration.version])
      if (found.rowCount) continue
      await withTransaction(database.pool, async client => {
        await client.query(migration.sql)
        await client.query('insert into application_migrations(version) values($1)', [migration.version])
      })
    }
    access = new PostgresAccessService(database.pool)
    commands = new PostgresCommandCoordinator(database.pool)
    retention = new FileRetentionService(database.pool, commands)
    files = new PostgresFileRepository(database.pool, readFileRetentionSnapshot)
    authorization = new PostgresFileConversationAuthorization(database.pool)
    storageRoot = await mkdtemp(join(tmpdir(), 'fil40-test-'))
    bytes = new FileByteStorage(storageRoot, MAX_FILE_BYTES)
    operator = await new PostgresOperatorRepository(database.pool).ensure()
    conversations = new PostgresOperatorConversationRepository(database.pool)
    app = Fastify()
    registerOperatorHttpSecurity(app, access)
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status
      : error instanceof z.ZodError ? 400 : 500).send({ error: {
      code: error instanceof DomainError ? error.code : error instanceof z.ZodError ? 'INVALID_REQUEST' : 'INTERNAL_ERROR',
    } }))
    registerFileRetentionRoutes(app, retention)
    registerFileRoutes(app, new TemporaryFileService(files, bytes, authorization))
    // Unrelated product services are intentionally absent; the real retention service/auth/MCP transport are not mocked.
    registerGraphqlMcp(app, { access, operator: { commands, fileRetention: retention } as unknown as OperatorServices })
    address = await app.listen({ host: '127.0.0.1', port: 0 })
  })
  afterAll(async () => {
    await app?.close()
    if (storageRoot) await removeFixtureDirectory(storageRoot)
    await database?.close()
  })

  async function newOwner(acceptedGrants = grants): Promise<Owner> {
    const credential = await access.issue({ name: 'FIL-40 test owner', audience: 'operator', grants: acceptedGrants,
      expiresAt: new Date(Date.now() + 3600000) })
    const conversation = await conversations.create(operator.operator.id, operator.configuration, credential.principal.id)
    return { ...credential, conversationId: conversation.id }
  }
  async function get(owner: Owner) {
    const response = await app.inject({ method: 'GET', url: FILE_RETENTION_PATH, headers: headers(owner) })
    assert.equal(response.statusCode, 200, response.body)
    return FileRetentionGetResultSchema.parse(response.json()).preference
  }
  async function save(owner: Owner, seconds: number, applyToExisting = false) {
    const preference = await get(owner)
    const response = await app.inject({ method: 'POST', url: FILE_RETENTION_PATH, headers: headers(owner),
      payload: payload(seconds, preference.revision, applyToExisting) })
    assert.equal(response.statusCode, 200, response.body)
    return FileRetentionSaveResultSchema.parse(response.json())
  }
  async function allocate(owner: Owner, requestId = randomUUID()) {
    const response = await app.inject({ method: 'POST', url: `${root(owner)}/uploads`, headers: headers(owner),
      payload: { requestId, ...metadata } })
    assert.ok([200, 201].includes(response.statusCode), response.body)
    return { value: FileWithRevisionSchema.parse(response.json().value), replayed: response.json().replayed as boolean }
  }
  async function seed(owner: Owner, options: { ageHours?: number; seconds?: number; state?: FileState;
    reference?: 'workspace_reference' | 'workflow_reference' } = {}) {
    const fileId = randomUUID(), revisionId = randomUUID()
    const createdAt = new Date(Date.now() - (options.ageHours ?? 2) * 3600000).toISOString()
    const seconds = options.seconds ?? DEFAULT_FILE_RETENTION_SECONDS
    const scope = options.reference ? { kind: options.reference, workspaceId: 'reference-workspace',
      ...(options.reference === 'workflow_reference' ? { workflowId: 'reference-workflow' } : {}) }
      : await authorization.resolve(owner.principal, { kind: 'operator', conversationId: owner.conversationId }, 'write')
    return files.create({ ownerPrincipalId: owner.principal.id, storageKey: randomUUID(),
      value: FileWithRevisionSchema.parse({ file: {
        fileId, currentRevisionId: revisionId, createdAt, scope, state: options.state ?? 'ready',
        ...(!options.reference ? { retentionDurationSeconds: seconds, expiresAt: temporaryFileExpiresAt(createdAt, seconds) } : {}),
      }, revision: { fileId, revisionId, ...metadata, origin: 'upload', createdAt } }) })
  }
  async function reread(stored: Awaited<ReturnType<typeof seed>>) {
    const found = await files.read(stored.value.file.fileId, stored.value.revision.revisionId)
    assert.ok(found)
    return found
  }
  async function mcp(owner: Credential, method: string, params: Record<string, unknown>): Promise<McpResult> {
    const id = randomUUID()
    const response = await fetch(new URL('/mcp', address), { method: 'POST', headers: {
      authorization: `Bearer ${owner.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
    }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
    const body = await response.text()
    assert.equal(response.status, 200, body)
    const messages = String(response.headers.get('content-type')).includes('text/event-stream')
      ? body.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)))
      : [JSON.parse(body)]
    const message = messages.find((item: { id?: string }) => item.id === id) as { result?: McpResult; error?: unknown } | undefined
    assert.ok(message?.result, body)
    return message.result
  }
  const call = (owner: Credential, name: string, input: Record<string, unknown> = {}) =>
    mcp(owner, 'tools/call', { name, arguments: input })
  function success(result: McpResult): unknown {
    assert.notEqual(result.isError, true, JSON.stringify(result))
    assert.ok(decodeMcpToolResult(result))
    return decodeMcpToolResult(result)
  }
  function failure(result: McpResult): string {
    assert.equal(result.isError, true, JSON.stringify(result))
    const decoded = decodeMcpToolResult(result) as { error: { code: string } }
    assert.deepEqual(Object.keys(decoded), ['error'])
    const text = result.content?.find((item) => item.type === 'text')?.text
    assert.ok(text)
    assert.deepEqual(decoded, JSON.parse(text))
    return decoded.error.code
  }

  it('saves without a revision through MCP, replays and reads back the last write', async () => {
    const owner = await newOwner()
    const reader = await newOwner([{ actions: ['settings:read'], scope: {} }])
    const input = { commandId: randomUUID(), durationSeconds: 3600 }
    assert.equal(failure(await call(reader, 'file_retention_save', input)), 'ACCESS_DENIED')
    const first = FileRetentionSaveResultSchema.parse(success(await call(owner, 'file_retention_save', input)))
    assert.equal(first.value.preference.revision, 1)
    const lastInput = { commandId: randomUUID(), durationSeconds: 7200 }
    const last = FileRetentionSaveResultSchema.parse(success(await call(owner, 'file_retention_save', lastInput)))
    assert.equal(last.value.preference.revision, 2)
    assert.deepEqual(FileRetentionSaveResultSchema.parse(success(await call(owner, 'file_retention_save', lastInput))),
      { ...last, replayed: true })
    assert.deepEqual(FileRetentionGetResultSchema.parse(success(await call(owner, 'file_retention_get'))).preference,
      last.value.preference)
    assert.equal(failure(await call(owner, 'file_retention_save', {
      ...input, commandId: randomUUID(), expectedRevision: 1,
    })), 'REVISION_CONFLICT')
    assert.deepEqual(await get(owner), last.value.preference)
  })

  it('returns default revision 0, allocates seven days, and snapshots a non-default for future files only', async () => {
    const owner = await newOwner(), requestId = randomUUID()
    assert.deepEqual(await get(owner), { ownerPrincipalId: owner.principal.id, durationSeconds: 604800, revision: 0 })
    const first = await allocate(owner, requestId)
    const original = TemporaryFileSchema.parse(first.value.file)
    assert.equal(original.expiresAt, temporaryFileExpiresAt(original.createdAt, 604800))
    const saved = await save(owner, 7200)
    assert.equal(saved.value.preference.revision, 1)
    assert.equal(saved.value.updatedFileCount, 0)
    const next = TemporaryFileSchema.parse((await allocate(owner)).value.file)
    assert.equal(next.retentionDurationSeconds, 7200)
    assert.equal(next.expiresAt, temporaryFileExpiresAt(next.createdAt, 7200))
    assert.deepEqual((await allocate(owner, requestId)).value, first.value)
    // A new service instance reads durable state, not an in-process cache.
    assert.deepEqual((await new FileRetentionService(database.pool, commands).get(owner.principal, 'http')).preference, saved.value.preference)
  })

  it('previews and shortens only still-live owner files from original createdAt; never resurrects or touches references', async () => {
    const owner = await newOwner(), other = await newOwner()
    const live = await Promise.all([seed(owner), seed(owner, { state: 'pending' }), seed(owner, { ageHours: 0.25 })])
    const excluded = await Promise.all([
      seed(owner, { state: 'expired' }), seed(owner, { state: 'removed' }),
      seed(owner, { seconds: 3600 }), seed(owner, { seconds: 3600, state: 'pending' }),
      seed(owner, { reference: 'workspace_reference' }), seed(owner, { reference: 'workflow_reference' }), seed(other),
    ])
    const previewResponse = await app.inject({ method: 'POST', url: `${FILE_RETENTION_PATH}/preview`,
      headers: headers(owner), payload: { durationSeconds: 3600 } })
    assert.equal(previewResponse.statusCode, 200, previewResponse.body)
    const preview = FileRetentionPreviewResultSchema.parse(previewResponse.json())
    assert.equal(preview.expireNowCount, 2)
    assert.equal(preview.preferenceRevision, 0)
    assert.equal(preview.ownerPrincipalId, owner.principal.id)
    assert.deepEqual(await reread(live[0]!), live[0], 'Preview must not mutate')
    const saved = await save(owner, 3600, true)
    assert.equal(saved.value.updatedFileCount, 3)
    assert.equal(saved.value.expiredNowCount, 2)
    for (const original of live) {
      const current = await reread(original), file = TemporaryFileSchema.parse(current.value.file)
      assert.equal(file.createdAt, original.value.file.createdAt)
      assert.equal(file.expiresAt, temporaryFileExpiresAt(file.createdAt, 3600))
      assert.deepEqual(current.value.revision, original.value.revision)
    }
    assert.equal((await reread(live[0]!)).value.file.state, 'expired')
    assert.equal((await reread(live[1]!)).value.file.state, 'expired')
    assert.equal((await reread(live[2]!)).value.file.state, 'ready')
    for (const original of excluded) assert.deepEqual(await reread(original), original)
    const extension = await save(owner, 31536000, true)
    assert.equal(extension.value.updatedFileCount, 1)
    assert.equal(extension.value.expiredNowCount, 0)
    assert.equal((await reread(live[0]!)).value.file.state, 'expired')
    assert.equal((await reread(live[1]!)).value.file.state, 'expired')
    for (const original of excluded) assert.deepEqual(await reread(original), original)
    for (const original of [...live.slice(0, 2), ...excluded.slice(0, 4)]) {
      const response = await app.inject({ method: 'GET', headers: headers(owner),
        url: `${root(owner)}/${original.value.file.fileId}/revisions/${original.value.revision.revisionId}/content` })
      assert.equal(response.statusCode, 410, response.body)
    }
  })

  it('extends live files from original creation, never from save time', async () => {
    const owner = await newOwner()
    const original = await seed(owner, { ageHours: 2, seconds: 10800 })
    const result = await save(owner, 604800, true)
    assert.equal(result.value.updatedFileCount, 1)
    assert.equal(result.value.expiredNowCount, 0)
    const extended = TemporaryFileSchema.parse((await reread(original)).value.file)
    assert.equal(extended.createdAt, original.value.file.createdAt)
    assert.equal(extended.expiresAt, temporaryFileExpiresAt(original.value.file.createdAt, 604800))
  })

  it('does not extend a file that expires while the save waits for its row lock', async () => {
    const owner = await newOwner()
    const original = await seed(owner, { ageHours: 1 - 3 / 3600, seconds: 3600 })
    const blocker = await database.pool.connect()
    let saving: ReturnType<FileRetentionService['save']> | undefined
    try {
      await beginTransaction(blocker)
      await blocker.query('select file_id from files where file_id=$1 for share', [original.value.file.fileId])
      const blockerPid = (await blocker.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      saving = retention.save(owner.principal, 'http', payload(7200, 0, true))
      void saving.catch(() => {
        // ignore: The saving promise is awaited after releasing the row lock and settled during cleanup.
      })
      const waiting = await readUntil(async () => {
        return (await database.pool.query<{ waiting: boolean }>(`select exists(select 1 from pg_stat_activity
          where $1::int=any(pg_blocking_pids(pid)) and query like '%for update%'
            and wait_event_type='Lock') as waiting`, [blockerPid])).rows[0]!.waiting
      }, value => value, { timeoutMs: 1000, description: 'the PostgreSQL lock wait' })
      assert.equal(waiting, true, 'Save must wait on the file row, not the retention-owner lock')
      await database.pool.query("select pg_sleep(greatest(0,extract(epoch from $1::timestamptz-clock_timestamp()))+0.02)",
        [TemporaryFileSchema.parse(original.value.file).expiresAt])
      const unavailable = await app.inject({ method: 'GET', headers: headers(owner),
        url: `${root(owner)}/${original.value.file.fileId}/revisions/${original.value.revision.revisionId}/content` })
      assert.equal(unavailable.statusCode, 410, unavailable.body)
      await commitTransaction(blocker)
      const saved = await saving
      assert.equal(saved.value.updatedFileCount, 0)
      assert.deepEqual(await reread(original), original)
      const stillUnavailable = await app.inject({ method: 'GET', headers: headers(owner),
        url: `${root(owner)}/${original.value.file.fileId}/revisions/${original.value.revision.revisionId}/content` })
      assert.equal(stillUnavailable.statusCode, 410, stillUnavailable.body)
    } finally {
      await rollbackTransaction(blocker)
      blocker.release()
      if (saving) await Promise.allSettled([saving])
    }
  }, 12_000)

  it('replays across HTTP/MCP, normalizes omitted false, rejects changed command identity and stale revisions', async () => {
    const owner = await newOwner(), input = payload(7200)
    const { applyToExisting: _omitted, ...omitted } = input
    void _omitted
    const first = FileRetentionSaveResultSchema.parse(success(await call(owner, 'file_retention_save', omitted)))
    const replay = await app.inject({ method: 'POST', url: FILE_RETENTION_PATH, headers: headers(owner), payload: input })
    assert.equal(replay.statusCode, 200, replay.body)
    assert.deepEqual(FileRetentionSaveResultSchema.parse(replay.json()), { ...first, replayed: true })
    assert.equal(failure(await call(owner, 'file_retention_save', { ...input, applyToExisting: true })), 'COMMAND_ID_CONFLICT')
    const oldFile = await seed(owner)
    const stale = await app.inject({ method: 'POST', url: FILE_RETENTION_PATH, headers: headers(owner), payload: payload(3600, 0, true) })
    assert.equal(stale.statusCode, 409, stale.body)
    assert.equal(stale.json().error.code, 'REVISION_CONFLICT')
    assert.deepEqual(await reread(oldFile), oldFile)
    assert.equal((await get(owner)).durationSeconds, 7200)
    const receipts = await database.pool.query('select count(*)::int as n from management_command_receipts where principal_id=$1 and operation=$2',
      [owner.principal.id, 'file_retention_save'])
    assert.equal(receipts.rows[0].n, 1)
  })

  it('does not reapply an apply-to-existing command on replay to later allocations', async () => {
    const owner = await newOwner(), input = payload(3600, 0, true)
    await seed(owner)
    const first = FileRetentionSaveResultSchema.parse(success(await call(owner, 'file_retention_save', input)))
    assert.equal(first.value.expiredNowCount, 1)
    await save(owner, 604800)
    const later = await allocate(owner)
    assert.deepEqual(FileRetentionSaveResultSchema.parse(success(await call(owner, 'file_retention_save', input))), { ...first, replayed: true })
    const current = await files.read(later.value.file.fileId, later.value.revision.revisionId)
    assert.equal(TemporaryFileSchema.parse(current!.value.file).retentionDurationSeconds, 604800)
    assert.equal((await get(owner)).revision, 2)
  })

  it('supports authenticated MCP list, preview, save and persisted HTTP/MCP readback', async () => {
    const owner = await newOwner()
    await seed(owner)
    const names = (await mcp(owner, 'tools/list', {})).tools!.map((tool) => tool.name)
    for (const name of ['file_retention_get', 'file_retention_preview', 'file_retention_save']) assert.ok(names.includes(name))
    assert.equal(FileRetentionGetResultSchema.parse(success(await call(owner, 'file_retention_get'))).preference.revision, 0)
    const preview = FileRetentionPreviewResultSchema.parse(success(await call(owner, 'file_retention_preview', { durationSeconds: 3600 })))
    assert.equal(preview.expireNowCount, 1)
    const saved = FileRetentionSaveResultSchema.parse(success(await call(owner, 'file_retention_save', payload(3600, 0, true))))
    assert.equal(saved.value.updatedFileCount, 1)
    assert.equal(saved.value.expiredNowCount, 1)
    assert.deepEqual((await get(owner)), saved.value.preference)
    assert.deepEqual(FileRetentionGetResultSchema.parse(success(await call(owner, 'file_retention_get'))).preference, saved.value.preference)
    const audit = await database.pool.query('select source,outcome from management_audit where principal_id=$1 and action=$2',
      [owner.principal.id, 'file_retention_save'])
    assert.ok(audit.rows.some((row: { source: string; outcome: string }) => row.source === 'mcp' && row.outcome === 'succeeded'))
  })

  it('keeps owner retention capabilities under resource selection without broadening scoped settings grants', async () => {
    const capabilityGrant: ManagementGrant = { actions: ['capabilities:read'], scope: {} }
    const owner = await newOwner([...grants, capabilityGrant])
    const reader = await newOwner([capabilityGrant, { actions: ['settings:read'], scope: {} }])
    const scoped = await newOwner([capabilityGrant,
      { actions: ['settings:read', 'settings:update'], scope: { workspaceIds: ['workspace'] } }])
    const resource = { workspaceId: 'workspace', workflowId: 'workflow', runId: 'run' }
    const names = ['file_retention_get', 'file_retention_preview', 'file_retention_save']
    for (const input of [{}, resource]) {
      const ownerCapabilities = OperatorCompactCapabilitiesSchema.parse(success(
        await call(owner, 'operator_get_capabilities', input),
      ))
      for (const name of names) assert.ok(ownerCapabilities.tools.includes(name))
      const readerCapabilities = OperatorCompactCapabilitiesSchema.parse(success(
        await call(reader, 'operator_get_capabilities', input),
      ))
      assert.ok(readerCapabilities.tools.includes('file_retention_get'))
      assert.ok(readerCapabilities.tools.includes('file_retention_preview'))
      assert.ok(!readerCapabilities.tools.includes('file_retention_save'))
      const deniedCapabilities = OperatorCompactCapabilitiesSchema.parse(success(
        await call(scoped, 'operator_get_capabilities', input),
      ))
      for (const name of names) assert.ok(!deniedCapabilities.tools.includes(name))
    }
    const saved = FileRetentionSaveResultSchema.parse(success(await call(owner, 'file_retention_save', payload(7200))))
    assert.deepEqual(FileRetentionGetResultSchema.parse(success(await call(owner, 'file_retention_get'))).preference,
      saved.value.preference)
    assert.equal(failure(await call(scoped, 'file_retention_save', payload(7200))), 'ACCESS_DENIED')
    assert.deepEqual(await get(owner), saved.value.preference)
  })

  it('denies read-only and scoped callers through authenticated HTTP/MCP, and audits hidden-tool calls', async () => {
    const reader = await newOwner([{ actions: ['settings:read'], scope: {} }])
    const scoped = await newOwner([{ actions: ['settings:read', 'settings:update'], scope: { workspaceIds: ['workspace'] } }])
    assert.equal((await get(reader)).revision, 0)
    const tools = (await mcp(reader, 'tools/list', {})).tools!.map((tool) => tool.name)
    assert.ok(tools.includes('file_retention_get'))
    assert.ok(!tools.includes('file_retention_save'))
    for (const caller of [reader, scoped]) {
      const response = await app.inject({ method: 'POST', url: FILE_RETENTION_PATH, headers: headers(caller), payload: payload(3600) })
      assert.equal(response.statusCode, 403, response.body)
      assert.equal(failure(await call(caller, 'file_retention_save', payload(3600))), 'ACCESS_DENIED')
      const found = await database.pool.query('select 1 from file_retention_preferences where owner_principal_id=$1', [caller.principal.id])
      assert.equal(found.rowCount, 0)
      const audit = await database.pool.query("select source from management_audit where principal_id=$1 and action='file_retention_save' and outcome='denied'", [caller.principal.id])
      assert.ok(audit.rows.some((row: { source: string }) => row.source === 'mcp'))
      assert.ok(audit.rows.some((row: { source: string }) => row.source === 'http'))
    }
  })

  it('isolates two owners and rejects owner selectors instead of treating IDs as grants', async () => {
    const owner = await newOwner(), other = await newOwner(), original = await seed(owner)
    const response = await app.inject({ method: 'POST', url: FILE_RETENTION_PATH, headers: headers(other),
      payload: { ...payload(3600, 0, true), ownerPrincipalId: owner.principal.id } })
    assert.equal(response.statusCode, 400, response.body)
    const forbiddenGet = await app.inject({ method: 'GET', url: `${FILE_RETENTION_PATH}?ownerPrincipalId=${owner.principal.id}`, headers: headers(other) })
    assert.equal(forbiddenGet.statusCode, 400)
    const forbiddenPreview = await app.inject({ method: 'POST', url: `${FILE_RETENTION_PATH}/preview`, headers: headers(other),
      payload: { durationSeconds: 3600, ownerPrincipalId: owner.principal.id } })
    assert.equal(forbiddenPreview.statusCode, 400)
    await assert.rejects(retention.save(other.principal, 'mcp', { ...payload(3600, 0, true), ownerPrincipalId: owner.principal.id }), { name: 'ZodError' })
    const saved = FileRetentionSaveResultSchema.parse(success(await call(other, 'file_retention_save', payload(3600, 0, true))))
    assert.equal(saved.value.preference.ownerPrincipalId, other.principal.id)
    assert.equal(saved.value.updatedFileCount, 0)
    assert.deepEqual(await reread(original), original)
    assert.equal((await get(owner)).revision, 0)
  })

  it('does not let delegated Operator credentials change either their parent or their own preference', async () => {
    const human = await newOwner(), delegated = await newOwner()
    await database.pool.query('update management_principals set delegated_from=$2 where id=$1', [delegated.principal.id, human.principal.id])
    const response = await app.inject({ method: 'POST', url: FILE_RETENTION_PATH, headers: headers(delegated), payload: payload(3600) })
    assert.equal(response.statusCode, 403, response.body)
    assert.equal(response.json().error.code, 'FILE_RETENTION_OWNER_REQUIRED')
    assert.equal(failure(await call(delegated, 'file_retention_save', payload(3600))), 'FILE_RETENTION_OWNER_REQUIRED')
    assert.equal((await get(human)).revision, 0)
    const rows = await database.pool.query('select 1 from file_retention_preferences where owner_principal_id=any($1::text[])', [[human.principal.id, delegated.principal.id]])
    assert.equal(rows.rowCount, 0)
  })

  it('reauthorizes a previously successful command before replay', async () => {
    const owner = await newOwner(), input = payload(7200)
    await retention.save(owner.principal, 'http', input)
    await database.pool.query('update management_principals set grants=$2::jsonb where id=$1',
      [owner.principal.id, JSON.stringify([{ actions: ['settings:read'], scope: {} }])])
    await assert.rejects(retention.save(owner.principal, 'http', input), { code: 'ACCESS_DENIED' })
    assert.equal(failure(await call(owner, 'file_retention_save', input)), 'ACCESS_DENIED')
    assert.equal((await get(owner)).revision, 1)
  })

  it('allows local preferences while rejecting remote clients, invalid bearer and worker credentials', async () => {
    const worker = await access.issue({ name: 'FIL-40 worker', audience: 'worker', agentId: 'synthetic-agent', grants,
      expiresAt: new Date(Date.now() + 600000) })
    const local = await app.inject({ method: 'GET', url: FILE_RETENTION_PATH, headers: { host: 'localhost' } })
    assert.equal(local.statusCode, 200, local.body)
    FileRetentionGetResultSchema.parse(local.json())
    const remote = await app.inject({ method: 'GET', url: FILE_RETENTION_PATH, remoteAddress: '192.0.2.1' })
    assert.equal(remote.statusCode, 403, remote.body)
    for (const authorization of ['Bearer invalid', 'invalid']) {
      const response = await app.inject({ method: 'GET', url: FILE_RETENTION_PATH,
        headers: { host: 'localhost', ...(authorization ? { authorization } : {}) } })
      assert.equal(response.statusCode, 401, response.body)
    }
    const workerHttp = await app.inject({ method: 'POST', url: FILE_RETENTION_PATH, headers: headers(worker), payload: payload(3600) })
    assert.equal(workerHttp.statusCode, 403, workerHttp.body)
    const response = await app.inject({ method: 'POST', url: '/mcp', headers: { ...headers(worker), accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'file_retention_save', arguments: payload(3600) } } })
    assert.equal(response.statusCode, 403, response.body)
    // This retention-only composition does not install worker services; production role mapping is also unit-tested.
    assert.equal(response.json().error.code, 'AUTH_WRONG_AUDIENCE')
  })

  it.each([3599, 31536001, 3600.5])('rejects out-of-contract duration %s without writing', async (seconds) => {
    const owner = await newOwner()
    for (const [url, input] of [[FILE_RETENTION_PATH, payload(seconds)], [`${FILE_RETENTION_PATH}/preview`, { durationSeconds: seconds }]] as const) {
      const response = await app.inject({ method: 'POST', url, headers: headers(owner), payload: input })
      assert.equal(response.statusCode, 400, response.body)
    }
    assert.equal((await get(owner)).revision, 0)
  })

  it('serializes competing expectedRevision=0 saves into exactly one accepted revision', async () => {
    const owner = await newOwner()
    const responses = await Promise.all([3600, 7200].map((seconds) => app.inject({ method: 'POST', url: FILE_RETENTION_PATH,
      headers: headers(owner), payload: payload(seconds) })))
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409])
    assert.equal((await get(owner)).revision, 1)
  })

  it('keeps allocation snapshot/insertion atomic with an apply-to-existing save on another connection', async () => {
    const owner = await newOwner()
    let unblock!: () => void, entered!: () => void, blockerPid = 0
    const gate = new Promise<void>((resolve) => { unblock = resolve })
    const inSnapshot = new Promise<void>((resolve) => { entered = resolve })
    const allocatingRepository = new PostgresFileRepository(database.pool, async (client, ownerId) => {
      const seconds = await readFileRetentionSnapshot(client, ownerId)
      blockerPid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      entered(); await gate; return seconds
    })
    const uploading = new TemporaryFileService(allocatingRepository, bytes, authorization).allocate(owner.principal,
      { kind: 'operator', conversationId: owner.conversationId }, { requestId: randomUUID(), ...metadata })
    await inSnapshot
    const saving = retention.save(owner.principal, 'http', payload(3600, 0, true))
    // Observe the real blocked PostgreSQL connection, not a timing-only assertion.
    try {
      const waiting = await readUntil(async () => {
        const result = await database.pool.query<{ waiting: boolean }>(`select exists(select 1 from pg_stat_activity
          where $1::int=any(pg_blocking_pids(pid)) and query like '%273640%' and wait_event_type='Lock') as waiting`, [blockerPid])
        return result.rows[0]!.waiting
      }, value => value, { timeoutMs: 1000, description: 'the PostgreSQL lock wait' })
      assert.equal(waiting, true, 'Save must wait for the allocation transaction before applying retention')
    } finally { unblock(); await Promise.allSettled([uploading, saving]) }
    const [allocated, saved] = await Promise.all([uploading, saving])
    assert.equal(saved.value.updatedFileCount, 1)
    const found = await files.read(allocated.value.file.fileId, allocated.value.revision.revisionId)
    assert.equal(TemporaryFileSchema.parse(found!.value.file).retentionDurationSeconds, 3600)
    assert.equal(found!.value.file.createdAt, allocated.value.file.createdAt)
  })

  it('rolls back preference and file updates if the command receipt cannot commit', async () => {
    const owner = await newOwner(), original = await seed(owner)
    await database.pool.query(`create function fil40_receipt_failure() returns trigger language plpgsql as $$
      begin if new.operation='file_retention_save' and new.command_id='fil40-failing-receipt' then
        raise exception 'synthetic receipt failure'; end if; return new; end $$;
      create trigger fil40_receipt_failure before insert on management_command_receipts
      for each row execute function fil40_receipt_failure();`)
    try {
      await assert.rejects(retention.save(owner.principal, 'http', { ...payload(3600, 0, true), commandId: 'fil40-failing-receipt' }))
      assert.equal((await get(owner)).revision, 0)
      assert.deepEqual(await reread(original), original)
      const found = await database.pool.query('select 1 from management_command_receipts where principal_id=$1 and operation=$2',
        [owner.principal.id, 'file_retention_save'])
      assert.equal(found.rowCount, 0)
    } finally {
      await database.pool.query('drop trigger fil40_receipt_failure on management_command_receipts; drop function fil40_receipt_failure()')
    }
  })
})
