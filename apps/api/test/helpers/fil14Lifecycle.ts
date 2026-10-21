import { removeFixtureDirectory } from './testResources.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import Fastify from 'fastify'
import pg from 'pg'
import { z } from 'zod'
import {
  DEFAULT_FILE_RETENTION_SECONDS, MAX_FILE_BYTES, FileWithRevisionSchema, temporaryFileExpiresAt,
  type FileState, type FileWithRevision,
} from '@foreman-code/contracts/files'

import { fileStorageMigration } from '../../src/infrastructure/fileStorageMigration.js'
import { fileReferenceMigration } from '../../src/infrastructure/fileReferenceMigration.js'
import { fileRetentionMigration } from '../../src/infrastructure/fileRetentionMigration.js'
import { registerOperatorHttpSecurity } from '../../src/modules/access/http.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { PostgresOperatorConversationRepository } from '../../src/modules/conversations/operatorChatRepository.js'
import { DomainError } from '../../src/modules/errors.js'
import { PostgresFileConversationAuthorization } from '../../src/modules/files/authorization.js'
import { ManagedFileCleanupBytes } from '../../src/modules/files/cleanup/bytes.js'
import { PostgresFileCleanupRepository } from '../../src/modules/files/cleanup/postgres.js'
import { TemporaryFileCleanupSweeper } from '../../src/modules/files/cleanup/sweeper.js'
import { PostgresFileRepository } from '../../src/modules/files/postgres.js'
import type { StoredFile } from '../../src/modules/files/repository.js'
import { FileRetentionService } from '../../src/modules/files/retention.js'
import { readFileRetentionSnapshot } from '../../src/modules/files/retentionSnapshot.js'
import { TemporaryFileService } from '../../src/modules/files/service.js'
import { FileByteStorage } from '../../src/modules/files/storage.js'
import { PostgresOperatorRepository } from '../../src/modules/operators/postgres.js'
import { registerFileRoutes } from '../../src/routes/files.js'
import { agent3Database } from './wave25Agent3.js'
import { fileMetadata } from './fileFixtures.js'

export const hour = 3_600_000
export const markdown = { filename: 'same.md', mediaType: 'text/markdown' as const,
  bytes: Buffer.from('# FIL-14\r\n\r\nExact bytes: café 日本語.\r\n') }
export type Fixture = Parameters<typeof fileMetadata>[0]
export type Owner = Awaited<ReturnType<PostgresAccessService['issue']>> & { conversationId: string }
export const target = (owner: Owner) => ({ kind: 'operator' as const, conversationId: owner.conversationId })
export const pins = (value: FileWithRevision) => ({ fileId: value.file.fileId, revisionId: value.revision.revisionId })
export const base = (owner: Owner) => `/api/operator/conversations/${owner.conversationId}/files`
export const contentUrl = (owner: Owner, value: FileWithRevision) =>
  `${base(owner)}/${value.file.fileId}/revisions/${value.revision.revisionId}/content`
export const headers = (owner: Owner) => ({ authorization: `Bearer ${owner.token}`, host: 'localhost' })

/** Bounded observation, not an arbitrary sleep used to guess which transaction won. */
export async function waitFor(check: () => Promise<boolean>, message: string, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs
  do {
    if (await check()) return
    await delay(10)
  } while (performance.now() < deadline)
  assert.fail(message)
}

/** Each suite gets a guarded disposable PostgreSQL schema and an app-private real filesystem.
 * open() always creates a NEW pool, byte store and authenticated HTTP application against
 * that persisted state. It never migrates/reset tables or carries service memory on restart.
 * This is a service/pool restart, not a claim of SIGKILL or PostgreSQL-server crash testing. */
export async function fil14Database() {
  const connectionString = process.env.TEST_DATABASE_URL
  if (!connectionString) throw new Error('TEST_DATABASE_URL is required for FIL-14 integration tests')
  const database = await agent3Database()
  let root: string | undefined
  const closers = new Set<() => Promise<void>>()
  try {
    for (const migration of [fileStorageMigration, fileReferenceMigration, fileRetentionMigration]) {
      if ((await database.pool.query('select 1 from application_migrations where version=$1', [migration.version])).rowCount) continue
      const client = await database.pool.connect()
      try {
        await client.query('begin'); await client.query(migration.sql)
        await client.query('insert into application_migrations(version) values($1)', [migration.version])
        await client.query('commit')
      } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
    }
    root = await mkdtemp(join(homedir(), '.fil14-lifecycle-'))
  } catch (error) {
    if (root) await removeFixtureDirectory(root)
    await database.close(); throw error
  }
  const storageRoot = root
  async function open(options: {
    repository?: (pool: pg.Pool) => PostgresFileRepository
    bytes?: FileByteStorage
  } = {}) {
    const applicationName = `fil14_${randomUUID()}`
    const pool = new pg.Pool({ connectionString: database.databaseUrl, max: 6, application_name: applicationName,
      options: `-c search_path=${database.schema} -c statement_timeout=10000 -c lock_timeout=5000` })
    const bytes = options.bytes ?? new FileByteStorage(storageRoot, MAX_FILE_BYTES)
    const files = options.repository?.(pool) ?? new PostgresFileRepository(pool, readFileRetentionSnapshot)
    const authorization = new PostgresFileConversationAuthorization(pool)
    const service = new TemporaryFileService(files, bytes, authorization)
    const access = new PostgresAccessService(pool)
    const retention = new FileRetentionService(pool, new PostgresCommandCoordinator(pool))
    const cleanup = new PostgresFileCleanupRepository(pool)
    const physical = new ManagedFileCleanupBytes(bytes)
    const app = Fastify()
    registerOperatorHttpSecurity(app, access)
    app.setErrorHandler((error, _request, reply) => {
      const status = error instanceof DomainError ? error.status : error instanceof z.ZodError ? 400 : 500
      return reply.code(status).send({ error: { code: error instanceof DomainError ? error.code : 'INVALID_REQUEST' } })
    })
    registerFileRoutes(app, service)
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true; closers.delete(close)
      try { await app.close() } finally { try { await physical.close() } finally { await pool.end() } }
    }
    closers.add(close)
    try { await bytes.initialize(); await app.ready() } catch (error) { await close(); throw error }
    return { pool, files, bytes, authorization, service, access, retention, cleanup, physical, app, applicationName, close }
  }
  return { ...database, root: storageRoot, open,
    async close() {
      try { await Promise.all([...closers].map((close) => close())) }
      finally { try { await removeFixtureDirectory(storageRoot) } finally { await database.close() } }
    },
  }
}
export type Fil14Database = Awaited<ReturnType<typeof fil14Database>>
export type Runtime = Awaited<ReturnType<Fil14Database['open']>>

export async function owner(runtime: Runtime): Promise<Owner> {
  const credential = await runtime.access.issue({ name: 'FIL-14 isolated owner', audience: 'operator',
    grants: [{ actions: ['settings:read', 'settings:update', 'operator_chat:read', 'operator_chat:write'], scope: {} }],
    expiresAt: new Date(Date.now() + hour) })
  const operator = await new PostgresOperatorRepository(runtime.pool).ensure()
  const conversation = await new PostgresOperatorConversationRepository(runtime.pool)
    .create(operator.operator.id, operator.configuration, credential.principal.id)
  return { ...credential, conversationId: conversation.id }
}
export async function anotherChat(runtime: Runtime, who: Owner): Promise<Owner> {
  const operator = await new PostgresOperatorRepository(runtime.pool).ensure()
  const conversation = await new PostgresOperatorConversationRepository(runtime.pool)
    .create(operator.operator.id, operator.configuration, who.principal.id)
  return { ...who, conversationId: conversation.id }
}
export async function allocate(runtime: Runtime, who: Owner, requestId: string, fixture: Fixture = markdown) {
  const reply = await runtime.app.inject({ method: 'POST', url: `${base(who)}/uploads`, headers: headers(who),
    payload: { requestId, ...fileMetadata(fixture) } })
  assert.ok([200, 201].includes(reply.statusCode), reply.body)
  return FileWithRevisionSchema.parse(reply.json().value)
}
export async function upload(runtime: Runtime, who: Owner, requestId: string, data: Buffer) {
  return runtime.app.inject({ method: 'PUT', url: `${base(who)}/uploads/${requestId}`,
    headers: { ...headers(who), 'content-type': 'application/octet-stream' }, payload: data })
}
export async function finalize(runtime: Runtime, who: Owner, requestId: string) {
  return runtime.app.inject({ method: 'POST', url: `${base(who)}/uploads/${requestId}/finalize`,
    headers: headers(who), payload: {} })
}
export async function ready(runtime: Runtime, who: Owner, fixture: Fixture = markdown) {
  const requestId = randomUUID(), value = await allocate(runtime, who, requestId, fixture)
  const uploaded = await upload(runtime, who, requestId, fixture.bytes)
  assert.equal(uploaded.statusCode, 200, uploaded.body)
  const finalized = await finalize(runtime, who, requestId)
  assert.equal(finalized.statusCode, 200, finalized.body)
  return { requestId, value: FileWithRevisionSchema.parse(finalized.json().value), initial: value }
}
export async function reread(runtime: Runtime, value: FileWithRevision) {
  const found = await runtime.files.read(value.file.fileId, value.revision.revisionId)
  assert.ok(found, 'Pinned immutable metadata must survive'); return found
}
export async function save(runtime: Runtime, who: Owner, durationSeconds: number, applyToExisting = false) {
  const { preference } = await runtime.retention.get(who.principal, 'http')
  return runtime.retention.save(who.principal, 'http', { commandId: randomUUID(), expectedRevision: preference.revision,
    durationSeconds, applyToExisting })
}
export async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  try { for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) }
  finally { stream.destroy() }
  return Buffer.concat(chunks)
}

/** Trusted fixture insertion ONLY for historical/downtime states. Live uploads above use
 * HTTP; we never widen public validation or fake the database's expiry/lock clock. */
export async function historical(runtime: Runtime, who: Owner, options: {
  ageHours?: number; createdAt?: string; seconds?: number; state?: FileState
  reference?: 'workspace_reference' | 'workflow_reference'; stagingOnly?: boolean
} = {}): Promise<StoredFile> {
  const now = (await runtime.pool.query<{ at: Date }>('select clock_timestamp() as at')).rows[0]!.at
  const createdAt = options.createdAt ?? new Date(now.getTime() - (options.ageHours ?? 2) * hour).toISOString()
  const fileId = randomUUID(), revisionId = randomUUID(), seconds = options.seconds ?? DEFAULT_FILE_RETENTION_SECONDS
  const scope = options.reference ? { kind: options.reference, workspaceId: 'fil14-reference-workspace',
    ...(options.reference === 'workflow_reference' ? { workflowId: 'fil14-reference-workflow' } : {}) }
    : await runtime.authorization.resolve(who.principal, target(who), 'write')
  const stored = await runtime.files.create({ ownerPrincipalId: who.principal.id, storageKey: randomUUID(),
    value: FileWithRevisionSchema.parse({
      file: { fileId, currentRevisionId: revisionId, createdAt, scope, state: options.state ?? 'ready',
        ...(!options.reference ? { retentionDurationSeconds: seconds, expiresAt: temporaryFileExpiresAt(createdAt, seconds) } : {}) },
      revision: { fileId, revisionId, createdAt, origin: 'upload', ...fileMetadata(markdown) },
    }),
  })
  const candidate = await runtime.bytes.receive(stored.storageKey, Readable.from([markdown.bytes]), stored.value.revision)
  try {
    await runtime.bytes.stage(candidate, stored.value.revision)
    if (!options.stagingOnly) await runtime.bytes.finalize(stored.storageKey, stored.value.revision)
  } finally { await runtime.bytes.discard(candidate) }
  return stored
}
export async function candidate(runtime: Runtime, stored: StoredFile) {
  const found = await runtime.cleanup.findByStorageKeys([stored.storageKey])
  assert.equal(found.length, 1, 'Must discover the real persisted eligible revision')
  return found[0]!
}
export async function absent(root: string, stored: StoredFile) {
  await assert.rejects(readFile(join(root, 'objects', stored.storageKey)), { code: 'ENOENT' })
  await assert.rejects(readdir(join(root, 'staging', stored.storageKey)), { code: 'ENOENT' })
}
export async function sweep(runtime: Runtime, batchSize = 2) {
  const errors: unknown[] = []
  const sweeper = new TemporaryFileCleanupSweeper(new PostgresFileCleanupRepository(runtime.pool),
    new ManagedFileCleanupBytes(runtime.bytes), (error) => { errors.push(error) }, { batchSize })
  try {
    for (let batch = 0; batch < 500; batch++) {
      const result = await sweeper.sweep()
      assert.deepEqual(errors, [], 'Cleanup must not silently hide filesystem or database errors')
      if (!result.hasMore) return
    }
    assert.fail('Bounded cleanup did not finish its discovery pass')
  } finally { await sweeper.stop() }
}
