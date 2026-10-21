import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileToolsMigration } from '../src/modules/files/tools/migration.js'
import { PostgresFileToolRepository } from '../src/modules/files/tools/postgres.js'
import type { CopyReceipt, FileToolArtifact, FileToolContext, PublicationLink } from '../src/modules/files/tools/types.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const schema = `fil05_${randomUUID().replaceAll('-', '')}`
const now = '2026-01-01T00:00:00.000Z', binding = 'a'.repeat(64)
const context: FileToolContext = { ownerPrincipalId: 'owner', nativeSessionId: 'native', turnId: 'turn',
  scope: { kind: 'temporary', chat: { kind: 'agent', conversationId: 'conversation', agentId: 'agent', workspaceId: 'workspace', workflowId: 'workflow' } },
  allowMutation: true, allowedTools: ['files.list', 'files.read', 'files.create_working_copy', 'files.publish_result'] }

describe.skipIf(!databaseUrl)('FIL-05 PostgreSQL durability and compare-and-set', () => {
  let admin: pg.Pool | undefined, pool: pg.Pool | undefined
  let first: PostgresFileToolRepository, second: PostgresFileToolRepository
  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || !/test/i.test(url.pathname)) throw new Error('Use an explicit loopback TEST_DATABASE_URL whose database name includes test.')
    admin = new pg.Pool({ connectionString: databaseUrl })
    await createFixtureSchema(admin, schema)
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c statement_timeout=5000` })
    // Minimal FIL-03 FK boundary, not a substitute for files.integration.test.ts or its full migration.
    await pool.query(`create table files(file_id text primary key,owner_principal_id text not null,unique(file_id,owner_principal_id));
      create table file_revisions(revision_id text primary key,file_id text not null references files(file_id),unique(file_id,revision_id));
      create table file_allocations(owner_principal_id text not null,request_id text not null,file_id text not null,
        revision_id text not null,state text not null,primary key(owner_principal_id,request_id));
      insert into files values ('file','owner'); insert into file_revisions values ('revision','file');
      insert into file_allocations values ('owner','request','file','revision','allocated');`)
    await pool.query(fileToolsMigration.sql)
    first = new PostgresFileToolRepository(pool)
    second = new PostgresFileToolRepository(pool)
  })
  afterAll(async () => {
    await pool?.end()
    if (admin) { try { await dropFixtureSchema(admin, schema) } finally { await admin.end() } }
  })

  it('persists hashed sessions across repository reconstruction; expiry and revocation fail closed', async () => {
    const hash = createHash('sha256').update(randomUUID()).digest('hex')
    await first.putSession(hash, { context, expiresAt: '2026-01-01T01:00:00.000Z' })
    expect((await second.session(hash, now))?.context).toEqual(context)
    expect(await second.session(hash, '2026-01-01T01:00:00.000Z')).toBeUndefined()
    await second.revokeSession(hash)
    expect(await first.session(hash, now)).toBeUndefined()
  })

  it('only one process owns an artifact write and old writers cannot complete over new ones', async () => {
    const artifact: FileToolArtifact = { artifactId: randomUUID(), binding, writeId: randomUUID(),
      state: 'failed', filename: 'result.md', mediaType: 'text/markdown', createdAt: now }
    await first.createArtifact(artifact)
    const a = randomUUID(), b = randomUUID()
    const results = await Promise.all([first.beginWrite(binding, artifact.artifactId, a), second.beginWrite(binding, artifact.artifactId, b)])
    expect(results.filter(Boolean)).toHaveLength(1)
    const winner = results[0] ? a : b, loser = results[0] ? b : a
    const snapshot = { storageKey: randomUUID(), revision: { fileId: artifact.artifactId, revisionId: randomUUID(),
      filename: 'result.md', mediaType: 'text/markdown' as const, byteSize: 0,
      sha256: createHash('sha256').update('').digest('hex'), origin: 'agent_output' as const, createdAt: now } }
    expect(await first.finishWrite(binding, artifact.artifactId, loser, snapshot)).toBe(false)
    expect(await second.finishWrite(binding, artifact.artifactId, winner, snapshot)).toBe(true)
    expect((await first.artifact(binding, artifact.artifactId))?.snapshot).toEqual(snapshot)
    expect(await first.artifact('b'.repeat(64), artifact.artifactId)).toBeUndefined()
  })

  it('deduplicates immutable copy receipts and rejects conflicting reuse', async () => {
    const receipt: CopyReceipt = { ownerPrincipalId: 'owner', commandId: randomUUID(), inputHash: 'b'.repeat(64),
      result: { value: { artifactId: randomUUID(), source: { fileId: 'file', revisionId: 'revision' },
        destination: context.scope, filename: 'result.md', createdAt: now }, replayed: false } }
    const [a, b] = await Promise.all([first.saveCopyReceipt(receipt), second.saveCopyReceipt(receipt)])
    expect(a).toEqual(b)
    await expect(first.saveCopyReceipt({ ...receipt, inputHash: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'FILE_REQUEST_CONFLICT' })
    await expect(pool!.query('delete from file_tool_copy_receipts')).rejects.toThrow('append-only')
  })

  it('commits the turn link before readiness; exact pins and provenance survive retries', async () => {
    const link: PublicationLink = { ownerPrincipalId: 'owner', requestId: 'request', binding, context,
      ref: { fileId: 'file', revisionId: 'revision' }, createdAt: now }
    await Promise.all([first.linkPublication(link), second.linkPublication(link)])
    expect(await second.publications(binding)).toEqual([])
    await pool!.query("update file_allocations set state='finalized' where request_id='request'")
    expect(await first.publications(binding)).toEqual([link.ref])
    await expect(second.linkPublication({ ...link, binding: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'FILE_REQUEST_CONFLICT' })
    await first.recordRead(binding, { ...link.ref, runId: 'run', executionId: 'execution', readAt: now })
    expect((await pool!.query('select count(*)::int as count from file_tool_read_provenance')).rows[0]?.count).toBe(1)
    await expect(pool!.query('delete from file_tool_publications')).rejects.toThrow('append-only')
  })
})
