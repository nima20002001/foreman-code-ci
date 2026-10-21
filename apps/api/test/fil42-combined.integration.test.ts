import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import pg from 'pg'
import { afterAll, beforeAll, describe, it, vi } from 'vitest'
import { FileWithRevisionSchema, TemporaryFileSchema, type PermanentFileScope } from '@foreman-code/contracts/files'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { fileStorageMigration } from '../src/infrastructure/fileStorageMigration.js'
import { fileReferenceMigration } from '../src/infrastructure/fileReferenceMigration.js'
import { fileReferenceAccessMigration } from '../src/infrastructure/fileReferenceAccessMigration.js'
import { PostgresFileRepository } from '../src/modules/files/postgres.js'
import { AgentReferenceAccess } from '../src/modules/files/references/agentAccess.js'
import { PostgresReferenceReadRepository } from '../src/modules/files/references/agentProvenance.js'
import type { AgentReferenceContext } from '../src/modules/files/references/agentTypes.js'
import { fileToolFixture } from './support/fileTools.js'
import { absent, allocate, fil14Database, historical, owner, reread, save, sweep,
  type Fil14Database, type Runtime } from './helpers/fil14Lifecycle.js'

const enabled = Boolean(process.env.TEST_DATABASE_URL)
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()), homedir: () => process.env.HOME!,
}))
const at = '2026-09-28T01:00:00.000Z'
const created = '2026-09-28T00:00:00.000Z'

describe.skipIf(!enabled)('FIL-42 combined reference scope and Run provenance', () => {
  let admin: pg.Pool, pool: pg.Pool, schema: string
  let files: PostgresFileRepository, reads: PostgresReferenceReadRepository
  const content = new Map<string, Buffer>()
  const contexts: Record<string, AgentReferenceContext | null> = {
    A: { workspaceId: 'W', workflowId: 'A', agentId: 'shared', runId: 'run-A', executionId: 'execution-A' },
    B: { workspaceId: 'W', workflowId: 'B', agentId: 'shared', runId: 'run-B', executionId: 'execution-B' },
    C: { workspaceId: 'Z', workflowId: 'C', agentId: 'shared', runId: 'run-C', executionId: 'execution-C' },
    operator: null,
  }
  const principal = (id: string): ManagementPrincipal => ({ id, name: id, audience: id === 'operator' ? 'operator' : 'worker',
    ...(id === 'operator' ? {} : { agentId: 'shared' }), expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, grants: [] })
  const ref = (row: { file: { fileId: string }; revision: { revisionId: string } }) =>
    ({ fileId: row.file.fileId, revisionId: row.revision.revisionId, offset: 0, length: 100 })
  let access: AgentReferenceAccess

  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.pathname.toLowerCase().includes('test')) {
      throw new Error('FIL-42 requires an explicit loopback test database')
    }
    schema = `fil42_${randomUUID().replaceAll('-', '')}`
    admin = new pg.Pool({ connectionString: url.toString(), max: 1 })
    await createFixtureSchema(admin, schema)
    pool = new pg.Pool({ connectionString: url.toString(), max: 5,
      options: `-c search_path=${schema} -c statement_timeout=10000` })
    await pool.query(`create table operator_conversations(id text primary key);
      create table runs(id text primary key,workspace_id text not null,workflow_id text not null);
      create table harness_executions(id text primary key,run_id text not null references runs(id),agent_id text not null);`)
    for (const migration of [fileStorageMigration, fileReferenceMigration, fileReferenceAccessMigration]) await pool.query(migration.sql)
    await pool.query(`insert into runs values('run-A','W','A'),('run-B','W','B'),('run-C','Z','C');
      insert into harness_executions values('execution-A','run-A','shared'),('execution-B','run-B','shared'),
        ('execution-C','run-C','shared');`)
    files = new PostgresFileRepository(pool)
    reads = new PostgresReferenceReadRepository(pool)
    access = new AgentReferenceAccess({
      authorization: { async resolve(who) { return contexts[who.id] ?? null } }, files, reads,
      bytes: { async download(storageKey) { return Readable.from([content.get(storageKey)!]) as never } },
      clock: () => new Date(at),
    }, { maxPageSize: 100, maxReadBytes: 65536, maxFileBytes: 26214400 })
  }, 30_000)
  afterAll(async () => {
    await pool?.end()
    if (admin) { try { await dropFixtureSchema(admin, schema) } finally { await admin.end() } }
  })

  async function add(scope: PermanentFileScope, body: string) {
    const bytes = Buffer.from(body), fileId = randomUUID(), revisionId = randomUUID(), storageKey = randomUUID()
    const value = FileWithRevisionSchema.parse({ file: { fileId, currentRevisionId: revisionId, scope,
      state: 'ready', createdAt: created }, revision: { fileId, revisionId, filename: 'shared.md', mediaType: 'text/markdown',
      byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), origin: 'upload', createdAt: created } })
    await files.create({ ownerPrincipalId: 'human', storageKey, value })
    content.set(storageKey, bytes)
    return value
  }

  it('A and B inherit only W; C and global Operator inherit no W references, even with the same Agent ID', async () => {
    const a = await add({ kind: 'workflow_reference', workspaceId: 'W', workflowId: 'A' }, 'A only')
    const b = await add({ kind: 'workflow_reference', workspaceId: 'W', workflowId: 'B' }, 'B only')
    const w = await add({ kind: 'workspace_reference', workspaceId: 'W' }, 'W project')
    const z = await add({ kind: 'workflow_reference', workspaceId: 'Z', workflowId: 'C' }, 'C only')
    const expected = { A: [a.file.fileId, w.file.fileId], B: [b.file.fileId, w.file.fileId], C: [z.file.fileId], operator: [] }
    for (const id of ['A', 'B', 'C', 'operator'] as const) {
      const who = principal(id), manifest = await access.list(who, { kind: 'execution' }, { limit: 100 })
      assert.deepEqual(manifest.items.map((item) => item.fileId).sort(), expected[id].sort())
      for (const row of [a, b, w, z]) {
        const result = await access.read(who, { kind: 'execution' }, ref(row))
        assert.equal(result.status, new Set<string>(expected[id]).has(row.file.fileId) ? 'ready' : 'unavailable', `${id} / ${row.file.fileId}`)
      }
    }
    const first = (await pool.query('select revision_id from run_reference_file_reads where run_id=$1 and file_id=$2',
      ['run-A', a.file.fileId])).rows[0]!.revision_id
    assert.equal(first, a.revision.revisionId)
    const later = await add({ kind: 'workflow_reference', workspaceId: 'W', workflowId: 'A' }, 'new library file')
    assert.ok((await access.list(principal('A'), { kind: 'execution' }, { limit: 100 })).items.some((item) => item.fileId === later.file.fileId))
    assert.equal((await pool.query('select revision_id from run_reference_file_reads where run_id=$1 and file_id=$2',
      ['run-A', a.file.fileId])).rows[0]!.revision_id, first, 'Run A must keep revision R after library changes')
    await assert.rejects(pool.query('update file_revisions set filename=$2 where revision_id=$1', [first, 'overwrite.md']), /immutable/)
    await assert.rejects(pool.query('delete from file_revisions where revision_id=$1', [first]), /immutable/)
    await assert.rejects(files.removeReference(b.file.scope as PermanentFileScope,
      { fileId: a.file.fileId, revisionId: a.revision.revisionId }, pool), { code: 'FILE_NOT_FOUND' })
    const removed = await files.removeReference(a.file.scope as PermanentFileScope,
      { fileId: a.file.fileId, revisionId: a.revision.revisionId }, pool)
    assert.equal(removed.file.state, 'removed')
    assert.equal((await access.read(principal('A'), { kind: 'execution' }, ref(a))).status, 'unavailable')
    assert.equal((await pool.query('select revision_id from run_reference_file_reads where run_id=$1 and file_id=$2',
      ['run-A', a.file.fileId])).rows[0]!.revision_id, first)
    for (const row of [b, w, z]) {
      assert.equal((await files.removeReference(row.file.scope as PermanentFileScope,
        { fileId: row.file.fileId, revisionId: row.revision.revisionId }, pool)).file.state, 'removed')
    }
    assert.deepEqual((await access.list(principal('B'), { kind: 'execution' }, { limit: 100 })).items
      .filter((item) => item.state === 'ready'), [])
  })
})

describe('FIL-42 file-tool mutation boundary', () => {
  it('does not let an agent add, remove or overwrite permanent references through file tools', async () => {
    const f = await fileToolFixture()
    const source = await f.upload('read-only reference')
    const permanent = { kind: 'workflow_reference' as const, workspaceId: 'workspace-a', workflowId: 'workflow-a' }
    const readOnly = await f.issue({ allowMutation: false })
    await assert.rejects(f.service.createWorkingCopy(readOnly, { commandId: randomUUID(), source,
      destination: f.scope }), { code: 'FILE_TOOL_DENIED' })
    await assert.rejects(f.service.publish(readOnly, { commandId: randomUUID(), artifactId: randomUUID(),
      scope: permanent, filename: 'overwrite.md', mediaType: 'text/markdown' }), { code: 'FILE_TOOL_DENIED' })
    await assert.rejects(f.service.publish(f.token, { commandId: randomUUID(), artifactId: randomUUID(),
      scope: permanent, filename: 'overwrite.md', mediaType: 'text/markdown' }))
    assert.equal(Object.hasOwn(f.service, 'addReference'), false)
    assert.equal(Object.hasOwn(f.service, 'removeReference'), false)
  })
})

describe.skipIf(!enabled)('FIL-42 combined retention and permanent files', () => {
  let database: Fil14Database, runtime: Runtime
  beforeAll(async () => { database = await fil14Database(); runtime = await database.open() }, 60_000)
  afterAll(async () => { await database?.close() })

  it('non-default retention changes allocations and existing live files without reviving expiry or touching permanent files', async () => {
    const who = await owner(runtime)
    const old = await allocate(runtime, who, randomUUID())
    const permanent = await historical(runtime, who, { reference: 'workspace_reference', ageHours: 366 * 24 })
    await save(runtime, who, 7200, true)
    const next = await allocate(runtime, who, randomUUID())
    assert.equal(TemporaryFileSchema.parse(next.file).retentionDurationSeconds, 7200)
    assert.equal(TemporaryFileSchema.parse((await reread(runtime, old)).value.file).retentionDurationSeconds, 7200)
    await save(runtime, who, 3600, true)
    assert.equal(TemporaryFileSchema.parse((await reread(runtime, old)).value.file).retentionDurationSeconds, 3600)
    const expired = await historical(runtime, who, { ageHours: 24, seconds: 3600 })
    await sweep(runtime)
    await absent(database.root, expired)
    await save(runtime, who, 31536000, true)
    assert.equal((await reread(runtime, expired.value)).value.file.state, 'expired')
    const restarted = await database.open()
    try {
      await sweep(restarted)
      assert.deepEqual(await reread(restarted, permanent.value), permanent)
      assert.deepEqual(await restarted.cleanup.findByStorageKeys([permanent.storageKey]), [])
    } finally { await restarted.close() }
  })
})
