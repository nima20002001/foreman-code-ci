import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import type { ArtifactEdgeBinding } from '@foreman-code/contracts/artifact-edges'
import { artifactEdgeMigrationSql } from '../src/infrastructure/artifactEdgeMigration.js'
import { PostgresArtifactEdgeRepository } from '../src/modules/files/distributed/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
const databaseUrl = process.env.TEST_DATABASE_URL
const schema = `w09_edges_${randomUUID().replaceAll('-', '')}`
const binding = (): ArtifactEdgeBinding => {
  const attempt = { workspaceId: 'workspace', workflowId: 'workflow', runId: 'run', nodeId: 'a',
    executionId: 'a-execution', attemptId: 'a-attempt', placementHash: 'a'.repeat(64) }
  return { version: 1, edgeId: randomUUID(), commandId: randomUUID(), producer: attempt,
    consumer: { ...attempt, nodeId: 'b', executionId: 'b-execution', attemptId: 'b-attempt' }, outputKey: 'result',
    publication: { ownerPrincipalId: 'owner', requestId: 'request', binding: 'b'.repeat(64) },
    pins: { fileId: randomUUID(), revisionId: randomUUID(), sha256: 'c'.repeat(64), byteSize: 10 },
    scope: { kind: 'temporary', chat: { kind: 'agent', conversationId: 'chat', agentId: 'agent', workspaceId: 'workspace', workflowId: 'workflow', runId: 'run', executionId: 'a-execution' } },
    sender: { principalId: 'sender', grantId: 'a-grant', grantRevision: '1' }, receiver: { principalId: 'receiver', grantId: 'b-grant', grantRevision: '1' },
    access: 'read-only', acceptedAt: new Date().toISOString() }
}
describe.skipIf(!databaseUrl)('W09 canonical edge database fault fixtures', () => {
  let admin: pg.Pool, pool: pg.Pool, repository: PostgresArtifactEdgeRepository
  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error('Explicit owned loopback TEST_DATABASE_URL required.')
    admin = new pg.Pool({ connectionString: databaseUrl }); await createFixtureSchema(admin, schema)
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
    await pool.query(`create table files(file_id text primary key,state text,scope_kind text,expires_at timestamptz);
      create table file_revisions(file_id text references files(file_id),revision_id text,sha256 text,byte_size bigint,unique(file_id,revision_id));
      create table file_tool_publications(file_id text,revision_id text,owner_principal_id text,request_id text,binding text);
      create table file_allocations(owner_principal_id text,request_id text,state text);
      create table file_tool_read_provenance(binding text,run_id text,execution_id text,file_id text,revision_id text,read_at timestamptz);
      create table grants(grant_id text primary key,revoked boolean); insert into grants values ('grant',false);`)
    await pool.query(artifactEdgeMigrationSql); repository = new PostgresArtifactEdgeRepository(pool)
  })
  afterAll(async () => { await pool?.end(); if (admin) { try { await dropFixtureSchema(admin, schema) } finally { await admin.end() } } })
  async function seed(b: ArtifactEdgeBinding, state = 'finalized') {
    await pool.query(`insert into files values ($1,'ready','temporary',clock_timestamp()+interval '1 hour')`, [b.pins.fileId])
    await pool.query('insert into file_revisions values ($1,$2,$3,$4)', [b.pins.fileId,b.pins.revisionId,b.pins.sha256,b.pins.byteSize])
    await pool.query('insert into file_tool_publications values ($1,$2,$3,$4,$5)', [b.pins.fileId,b.pins.revisionId,b.publication.ownerPrincipalId,b.publication.requestId,b.publication.binding])
    await pool.query('insert into file_allocations values ($1,$2,$3)', [b.publication.ownerPrincipalId,b.publication.requestId,state])
  }
  it('persists exact pins through reconstructed repositories, one identical edge and conflict rollback', async () => {
    const b = binding(); b.publication.requestId = b.edgeId; await seed(b)
    const authorize = async () => {}
    await Promise.all([repository.pin(b, authorize), new PostgresArtifactEdgeRepository(pool).pin(b, authorize)])
    expect(await new PostgresArtifactEdgeRepository(pool).read(b.edgeId)).toEqual(b)
    expect((await pool.query('select count(*)::int as count from file_artifact_edges where edge_id=$1', [b.edgeId])).rows[0].count).toBe(1)
    await expect(repository.pin({ ...b, consumer: { ...b.consumer, attemptId: 'late-attempt' } }, authorize)).rejects.toMatchObject({ code: 'FILE_EDGE_CONFLICT' })
    expect((await repository.read(b.edgeId))!.consumer.attemptId).toBe('b-attempt')
  })
  it('pending publication is never an edge, and expiry winning a lock wait denies pinning', async () => {
    const pending = binding(); pending.publication.requestId = pending.edgeId; await seed(pending, 'staged')
    await expect(repository.pin(pending, async () => {})).rejects.toMatchObject({ code: 'FILE_BYTES_UNAVAILABLE' })
    const b = binding(); b.publication.requestId = b.edgeId; await seed(b)
    let denied!: Promise<void>
    await withTransaction(pool, async client => {
      await client.query('select file_id from files where file_id=$1 for update', [b.pins.fileId])
      let reached!: () => void
      const authorized = new Promise<void>(resolve => { reached = resolve })
      const operation = repository.pin(b, async () => { reached() })
      denied = expect(operation).rejects.toMatchObject({ code: 'FILE_BYTES_UNAVAILABLE' })
      await authorized
      await client.query("update files set expires_at=clock_timestamp()-interval '1 second' where file_id=$1", [b.pins.fileId])
    })
    await denied
    expect(await repository.read(b.edgeId)).toBeUndefined()
  })
  it('revocation winning the authorization row lock denies read provenance', async () => {
    const b = binding(); b.publication.requestId = b.edgeId; await seed(b); await repository.pin(b, async () => {})
    let denied!: Promise<void>
    await withTransaction(pool, async client => {
      await client.query("select grant_id from grants where grant_id='grant' for update")
      let reached!: () => void
      const waiting = new Promise<void>(resolve => { reached = resolve })
      const operation = repository.recordRead(b, new Date().toISOString(), async query => {
        reached()
        const current = await query.query("select revoked from grants where grant_id='grant' for share")
        if (!current.rows[0] || current.rows[0].revoked) throw new DomainError('AUTH_REVOKED','revoked',403)
      })
      // Attach the rejection handler now: the operation can fail as soon as the lock is released.
      denied = expect(operation).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
      await waiting
      await client.query("update grants set revoked=true where grant_id='grant'")
    })
    await denied
    expect((await pool.query('select count(*)::int as count from file_artifact_edge_reads where edge_id=$1', [b.edgeId])).rows[0].count).toBe(0)
  })
})
