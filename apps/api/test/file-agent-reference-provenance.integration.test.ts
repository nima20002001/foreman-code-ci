import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { fileStorageMigration } from '../src/infrastructure/fileStorageMigration.js'
import { fileReferenceMigration } from '../src/infrastructure/fileReferenceMigration.js'
import { fileReferenceAccessMigration } from '../src/infrastructure/fileReferenceAccessMigration.js'
import { PostgresReferenceReadRepository } from '../src/modules/files/references/agentProvenance.js'
import type { AgentReferenceContext } from '../src/modules/files/references/agentTypes.js'

/** Real independent PostgreSQL transactions, using minimal parent identity tables. This is a
 * storage/provenance integration fixture, not a native worker credential or full application fixture. */
describe.skipIf(!process.env.TEST_DATABASE_URL)('FIL-37 PostgreSQL immutable reference provenance', () => {
  let admin: pg.Pool | undefined, pool: pg.Pool, schema: string
  let first: PostgresReferenceReadRepository, second: PostgresReferenceReadRepository
  const at = '2026-09-28T01:00:00.000Z', created = '2026-09-28T00:00:00.000Z'
  const A: AgentReferenceContext = { workspaceId: 'W', workflowId: 'A', agentId: 'same-agent', runId: 'run-A', executionId: 'execution-A1' }
  const A2: AgentReferenceContext = { ...A, executionId: 'execution-A2' }
  const B: AgentReferenceContext = { workspaceId: 'W', workflowId: 'B', agentId: 'same-agent', runId: 'run-B', executionId: 'execution-B' }
  const Z: AgentReferenceContext = { workspaceId: 'Z', workflowId: 'A', agentId: 'same-agent', runId: 'run-Z', executionId: 'execution-Z' }
  const authorized = async () => undefined
  const ref = (fileId: string, revisionId = `rev-${fileId}`) => ({ fileId, revisionId })

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL!
    const parsed = new URL(url)
    // Same explicit loopback/test-name guard as test/helpers/wave25Agent3.ts; no DATABASE_URL fallback.
    if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || !parsed.pathname.toLowerCase().includes('test')) {
      throw new Error('Use an explicit loopback PostgreSQL database named for tests')
    }
    schema = `fil37_${randomUUID().replaceAll('-', '')}`
    admin = new pg.Pool({ connectionString: url, max: 1 })
    await createFixtureSchema(admin, schema)
    pool = new pg.Pool({ connectionString: url, max: 6,
      options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000` })
    await pool.query(`create table operator_conversations(id text primary key);
      create table runs(id text primary key,workspace_id text not null,workflow_id text not null);
      create table harness_executions(id text primary key,run_id text not null references runs(id),agent_id text not null);`)
    for (const migration of [fileStorageMigration, fileReferenceMigration, fileReferenceAccessMigration]) await pool.query(migration.sql)
    await pool.query(`insert into runs values('run-A','W','A'),('run-B','W','B'),('run-Z','Z','A');
      insert into harness_executions values('execution-A1','run-A','same-agent'),('execution-A2','run-A','same-agent'),
        ('execution-B','run-B','same-agent'),('execution-Z','run-Z','same-agent');`)
    first = new PostgresReferenceReadRepository(pool); second = new PostgresReferenceReadRepository(pool)
  }, 30_000)
  afterAll(async () => {
    await pool?.end()
    if (admin) { try { if (schema) await dropFixtureSchema(admin, schema) } finally { await admin.end() } }
  })

  async function file(scope: 'workflow_reference' | 'workspace_reference' = 'workflow_reference', workspaceId = 'W',
    workflowId: string | null = 'A', state: 'pending' | 'ready' = 'ready') {
    const fileId = randomUUID(), revisionId = `rev-${fileId}`, client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(`insert into files(file_id,owner_principal_id,current_revision_id,scope_kind,workspace_id,workflow_id,state,created_at)
        values($1,'owner',$2,$3,$4,$5,$6,$7::timestamptz)`,
      [fileId, revisionId, scope, workspaceId, scope === 'workspace_reference' ? null : workflowId, state, created])
      await client.query(`insert into file_revisions(revision_id,file_id,filename,media_type,byte_size,sha256,origin,created_at,storage_key)
        values($1,$2,'same-name.md','text/markdown',4,$3,'upload',$4::timestamptz,$5)`, [revisionId, fileId, '0'.repeat(64), created, randomUUID()])
      await client.query('commit'); return ref(fileId, revisionId)
    } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  }
  async function anotherRevision(pin: ReturnType<typeof ref>) {
    const revisionId = randomUUID()
    // An additional immutable fixture revision, NOT an overwrite or current-head update.
    await pool.query(`insert into file_revisions(revision_id,file_id,filename,media_type,byte_size,sha256,origin,created_at,storage_key)
      values($1,$2,'same-name.md','text/markdown',4,$3,'upload',$4::timestamptz,$5)`,
    [revisionId, pin.fileId, '1'.repeat(64), created, randomUUID()])
    return ref(pin.fileId, revisionId)
  }
  async function facts(fileId: string) {
    return (await pool.query('select run_id,execution_id,file_id,revision_id,read_at from run_reference_file_reads where file_id=$1 order by run_id,execution_id', [fileId])).rows
  }

  it('records A/B inheritance of W but never a sibling workflow or Z', async () => {
    const own = await file(), sibling = await file('workflow_reference', 'W', 'B'), workspace = await file('workspace_reference'), other = await file('workspace_reference', 'Z')
    assert.equal(await first.complete(A, own, at, authorized), 'ready')
    assert.equal(await first.complete(B, own, at, authorized), 'not_found')
    assert.equal(await first.complete(A, sibling, at, authorized), 'not_found')
    assert.equal(await first.complete(A, other, at, authorized), 'not_found')
    assert.equal(await first.complete(A, workspace, at, authorized), 'ready')
    assert.equal(await second.complete(B, workspace, at, authorized), 'ready')
    assert.equal(await first.complete(Z, other, at, authorized), 'ready')
    assert.equal((await facts(own.fileId)).length, 1); assert.equal((await facts(workspace.fileId)).length, 2)
  })
  it('retries retain one first-read fact; different executions share a single Run pin', async () => {
    const pin = await file()
    assert.deepEqual(await Promise.all([first.complete(A, pin, at, authorized), second.complete(A2, pin, at, authorized)]), ['ready', 'ready'])
    await first.complete(A, pin, '2026-09-28T02:00:00.000Z', authorized)
    assert.equal((await facts(pin.fileId)).length, 2)
    assert.equal((await pool.query('select 1 from run_reference_file_pins where file_id=$1', [pin.fileId])).rowCount, 1)
    assert.ok((await facts(pin.fileId)).every((row) => (row.read_at as Date).toISOString() === at))
  })
  it('two processes cannot pin different revisions of one file for the same Run', async () => {
    const old = await file(), newer = await anotherRevision(old)
    const results = await Promise.allSettled([first.complete(A, old, at, authorized), second.complete(A2, newer, at, authorized)])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    const failed = results.find((result) => result.status === 'rejected')
    assert.ok(failed?.status === 'rejected'); assert.equal(failed.reason.code, 'FILE_REFERENCE_PIN_CONFLICT')
    const stored = await facts(old.fileId)
    assert.equal(stored.length, 1)
    assert.equal((await first.pinned('run-A', [old.fileId])).get(old.fileId), stored[0]!.revision_id)
  })
  it('checks the exact execution despite shared Agent IDs and rolls back failed authorization', async () => {
    const pin = await file()
    await assert.rejects(first.complete({ ...A, executionId: 'execution-B' }, pin, at, authorized), { code: 'FILE_REFERENCE_ACCESS_DENIED' })
    await assert.rejects(first.complete(A, pin, at, async () => { throw new Error('revoked') }), /revoked/)
    assert.equal((await facts(pin.fileId)).length, 0)
    assert.equal((await first.pinned('run-A', [pin.fileId])).size, 0)
  })
  it('keeps pins and facts after removal; pending/missing/removed files do not create a read fact', async () => {
    const pin = await file(), pending = await file('workflow_reference', 'W', 'A', 'pending')
    await first.complete(A, pin, at, authorized)
    const before = await facts(pin.fileId)
    await pool.query("update files set state='removed' where file_id=$1", [pin.fileId])
    assert.equal(await first.complete(A, pin, at, authorized), 'removed')
    assert.equal(await first.complete(A, pending, at, authorized), 'pending')
    assert.equal(await first.complete(A, ref('missing'), at, authorized), 'not_found')
    assert.deepEqual(await facts(pin.fileId), before)
    assert.equal((await first.pinned('run-A', [pin.fileId])).get(pin.fileId), pin.revisionId)
    assert.equal((await facts(pending.fileId)).length, 0)
  })
  it('a non-Run conversation read does not invent a Run or an execution', async () => {
    const pin = await file()
    assert.equal(await first.complete({ workspaceId: 'W', workflowId: 'A', agentId: 'same-agent', conversationId: 'chat-A' }, pin, at, authorized), 'ready')
    assert.equal((await facts(pin.fileId)).length, 0)
  })
  it('enforces immutable metadata, valid lineage and exact revision pins at the database boundary', async () => {
    const pin = await file()
    await first.complete(A, pin, at, authorized)
    for (const table of ['run_reference_file_reads', 'run_reference_file_pins']) {
      await assert.rejects(pool.query(`delete from ${table} where file_id=$1`, [pin.fileId]), /immutable/)
      await assert.rejects(pool.query(`update ${table} set revision_id=revision_id where file_id=$1`, [pin.fileId]), /immutable/)
    }
    await assert.rejects(pool.query('insert into run_reference_file_pins(run_id,file_id,revision_id) values($1,$2,$3)', ['run-B', pin.fileId, pin.revisionId]), { code: '23514' })
    await assert.rejects(pool.query(`insert into run_reference_file_reads(run_id,execution_id,file_id,revision_id,read_at) values($1,$2,$3,$4,$5)`,
      ['run-A', 'execution-B', pin.fileId, pin.revisionId, at]), { code: '23514' })
    await assert.rejects(pool.query(`insert into run_reference_file_reads(run_id,execution_id,file_id,revision_id,read_at) values($1,$2,$3,$4,$5)`,
      ['run-A', 'execution-A2', pin.fileId, pin.revisionId, '2000-01-01T00:00:00.000Z']), { code: '23514' })
    const other = await anotherRevision(pin)
    await assert.rejects(first.complete(A2, other, at, authorized), { code: 'FILE_REFERENCE_PIN_CONFLICT' })
    assert.equal((await facts(pin.fileId)).length, 1)
  })
})
