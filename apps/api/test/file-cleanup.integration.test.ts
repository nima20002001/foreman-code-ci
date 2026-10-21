import { readUntil } from './helpers/observableCondition.js'
import { removeFixtureDirectory } from './helpers/testResources.js'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, it } from 'vitest'
import {
  DEFAULT_FILE_RETENTION_SECONDS, MAX_FILE_BYTES, FileWithRevisionSchema, TemporaryFileSchema,
  temporaryFileExpiresAt, type FileState,
} from '@foreman-code/contracts/files'

import { fileStorageMigration } from '../src/infrastructure/fileStorageMigration.js'
import { fileReferenceMigration } from '../src/infrastructure/fileReferenceMigration.js'
import { fileRetentionMigration } from '../src/infrastructure/fileRetentionMigration.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresFileConversationAuthorization } from '../src/modules/files/authorization.js'
import { ManagedFileCleanupBytes } from '../src/modules/files/cleanup/bytes.js'
import { PostgresFileCleanupRepository } from '../src/modules/files/cleanup/postgres.js'
import type { FileCleanupCandidate } from '../src/modules/files/cleanup/repository.js'
import { TemporaryFileCleanupSweeper } from '../src/modules/files/cleanup/sweeper.js'
import { PostgresFileRepository } from '../src/modules/files/postgres.js'
import type { StoredFile } from '../src/modules/files/repository.js'
import { FileRetentionService } from '../src/modules/files/retention.js'
import { readFileRetentionSnapshot } from '../src/modules/files/retentionSnapshot.js'
import { TemporaryFileService } from '../src/modules/files/service.js'
import { FileByteStorage } from '../src/modules/files/storage.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { deferred } from './helpers/deferred.js'

type Credential = Awaited<ReturnType<PostgresAccessService['issue']>>
type Owner = Credential & { conversationId: string }
const hour = 3_600_000
const content = Buffer.from('FIL-04 immutable bytes\n')
const metadata = { filename: 'cleanup.md', mediaType: 'text/markdown' as const,
  byteSize: content.length, sha256: createHash('sha256').update(content).digest('hex') }
const target = (owner: Owner) => ({ kind: 'operator' as const, conversationId: owner.conversationId })
const pins = (stored: StoredFile) => ({ fileId: stored.value.file.fileId, revisionId: stored.value.revision.revisionId })

/** Real PostgreSQL sessions + existing retention/allocation/download services + real managed bytes.
 * No model/native harness, DATABASE_URL fallback, or shared-schema reset. Skipped != passed. */
describe.skipIf(!postgresEnabled)('FIL-04 temporary cleanup integration', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>, storageRoot: string
  let access: PostgresAccessService, retention: FileRetentionService, files: PostgresFileRepository
  let bytes: FileByteStorage, cleanup: PostgresFileCleanupRepository, physical: ManagedFileCleanupBytes
  let authorization: PostgresFileConversationAuthorization, service: TemporaryFileService
  let conversations: PostgresOperatorConversationRepository
  let operator: Awaited<ReturnType<PostgresOperatorRepository['ensure']>>

  beforeAll(async () => {
    database = await agent3Database()
    for (const migration of [fileStorageMigration, fileReferenceMigration, fileRetentionMigration]) {
      if ((await database.pool.query('select 1 from application_migrations where version=$1', [migration.version])).rowCount) continue
      const client = await database.pool.connect()
      try {
        await client.query('begin'); await client.query(migration.sql)
        await client.query('insert into application_migrations(version) values($1)', [migration.version]); await client.query('commit')
      } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
    }
    access = new PostgresAccessService(database.pool)
    retention = new FileRetentionService(database.pool, new PostgresCommandCoordinator(database.pool))
    files = new PostgresFileRepository(database.pool, readFileRetentionSnapshot)
    authorization = new PostgresFileConversationAuthorization(database.pool)
    storageRoot = await mkdtemp(join(homedir(), '.fil04-integration-'))
    bytes = new FileByteStorage(storageRoot, MAX_FILE_BYTES)
    await bytes.initialize()
    physical = new ManagedFileCleanupBytes(bytes)
    cleanup = new PostgresFileCleanupRepository(database.pool)
    service = new TemporaryFileService(files, bytes, authorization)
    operator = await new PostgresOperatorRepository(database.pool).ensure()
    conversations = new PostgresOperatorConversationRepository(database.pool)
  })
  afterAll(async () => {
    await physical?.close()
    if (storageRoot) await removeFixtureDirectory(storageRoot)
    await database?.close()
  })

  async function owner(): Promise<Owner> {
    const credential = await access.issue({ name: 'FIL-04 owner', audience: 'operator',
      grants: [{ actions: ['settings:read', 'settings:update', 'operator_chat:read', 'operator_chat:write'], scope: {} }],
      expiresAt: new Date(Date.now() + hour) })
    const conversation = await conversations.create(operator.operator.id, operator.configuration, credential.principal.id)
    return { ...credential, conversationId: conversation.id }
  }
  async function save(who: Owner, durationSeconds: number, applyToExisting = false) {
    const { preference } = await retention.get(who.principal, 'http')
    return retention.save(who.principal, 'http', { commandId: randomUUID(), expectedRevision: preference.revision,
      durationSeconds, applyToExisting })
  }
  async function publish(stored: StoredFile, stagingOnly = false) {
    const candidate = await bytes.receive(stored.storageKey, Readable.from([content]), stored.value.revision)
    try {
      await bytes.stage(candidate, stored.value.revision)
      if (!stagingOnly) await bytes.finalize(stored.storageKey, stored.value.revision)
    } finally { await bytes.discard(candidate) }
  }
  async function seed(who: Owner, options: { ageHours?: number; createdAt?: string; seconds?: number; state?: FileState;
    reference?: 'workflow_reference' | 'workspace_reference'; allocation?: boolean; stagingOnly?: boolean } = {}) {
    const fileId = randomUUID(), revisionId = randomUUID()
    const createdAt = options.createdAt ?? new Date(Date.now() - (options.ageHours ?? 2) * hour).toISOString()
    const scope = options.reference ? { kind: options.reference, workspaceId: 'fil04-reference-workspace',
      ...(options.reference === 'workflow_reference' ? { workflowId: 'fil04-reference-workflow' } : {}) }
      : await authorization.resolve(who.principal, target(who), 'write')
    const seconds = options.seconds ?? DEFAULT_FILE_RETENTION_SECONDS
    const stored: StoredFile = { ownerPrincipalId: who.principal.id, storageKey: randomUUID(), value: FileWithRevisionSchema.parse({
      file: { fileId, currentRevisionId: revisionId, createdAt, scope, state: options.state ?? 'ready',
        ...(!options.reference ? { retentionDurationSeconds: seconds, expiresAt: temporaryFileExpiresAt(createdAt, seconds) } : {}) },
      revision: { fileId, revisionId, createdAt, origin: 'upload', ...metadata },
    }) }
    // Trusted fixture insertion represents bytes accepted in the past, before the simulated downtime.
    // Public allocate/upload/finalize are not loosened to accept already-overdue files.
    if (options.allocation) {
      const requestId = randomUUID()
      await files.withAllocation(who.principal.id, requestId, (session) => session.create({ allocationId: randomUUID(), requestId,
        inputHash: 'a'.repeat(64), state: options.stagingOnly ? 'staged' : 'finalized', stored }))
    } else await files.create(stored)
    await publish(stored, options.stagingOnly)
    return stored
  }
  async function reread(stored: StoredFile) {
    const found = await files.read(stored.value.file.fileId, stored.value.revision.revisionId)
    assert.ok(found); return found
  }
  async function candidate(stored: StoredFile) {
    const values = await cleanup.findByStorageKeys([stored.storageKey])
    assert.equal(values.length, 1); return values[0]!
  }
  async function missing(stored: StoredFile) {
    await assert.rejects(readFile(join(storageRoot, 'objects', stored.storageKey)), { code: 'ENOENT' })
    await assert.rejects(readdir(join(storageRoot, 'staging', stored.storageKey)), { code: 'ENOENT' })
  }
  async function sweepAll(batchSize = 2) {
    const errors: unknown[] = []
    const sweeper = new TemporaryFileCleanupSweeper(new PostgresFileCleanupRepository(database.pool),
      new ManagedFileCleanupBytes(bytes), (error) => { errors.push(error) }, { batchSize })
    try {
      for (let batch = 0; batch < 200; batch++) {
        const result = await sweeper.sweep()
        assert.deepEqual(errors, [])
        if (!result.hasMore) return
      }
      assert.fail('Bounded cleanup failed to finish a discovery pass')
    } finally { await sweeper.stop() }
  }

  it('honors default and changed allocation snapshots, not the current preference duration', async () => {
    const who = await owner()
    const originalAllocation = await service.allocate(who.principal, target(who), { requestId: randomUUID(), ...metadata })
    assert.equal(TemporaryFileSchema.parse(originalAllocation.value.file).retentionDurationSeconds, 604800)
    const overdueDefault = await seed(who, { ageHours: 8 * 24 }), liveDefault = await seed(who, { ageHours: 6 * 24 })
    await save(who, 3600)
    const changedAllocation = await service.allocate(who.principal, target(who), { requestId: randomUUID(), ...metadata })
    assert.equal(TemporaryFileSchema.parse(changedAllocation.value.file).retentionDurationSeconds, 3600)
    const overdueChanged = await seed(who, { ageHours: 2, seconds: 3600 })
    await save(who, 31536000, false)
    // Access rejects effective expiry even before cleanup persists the tombstone.
    await assert.rejects(service.download(who.principal, target(who), pins(overdueDefault)), { code: 'FILE_BYTES_UNAVAILABLE', status: 410 })
    assert.equal((await reread(overdueDefault)).value.file.state, 'ready')
    await sweepAll()
    for (const stored of [overdueDefault, overdueChanged]) {
      await missing(stored)
      const found = await reread(stored)
      assert.equal(found.value.file.state, 'expired')
      assert.equal(found.value.file.createdAt, stored.value.file.createdAt)
      assert.deepEqual(found.value.revision, stored.value.revision)
    }
    assert.deepEqual((await reread(liveDefault)).value, liveDefault.value)
    assert.deepEqual(await readFile(join(storageRoot, 'objects', liveDefault.storageKey)), content)
  })

  it('finds files expired immediately by apply-to-existing and never resurrects them on a later extension', async () => {
    const who = await owner(), stored = await seed(who)
    const shortened = await save(who, 3600, true)
    assert.equal(shortened.value.expiredNowCount, 1)
    assert.equal((await reread(stored)).value.file.state, 'expired')
    await save(who, 604800, true)
    assert.equal((await reread(stored)).value.file.state, 'expired')
    await sweepAll(); await missing(stored)
    assert.deepEqual((await reread(stored)).value.revision, stored.value.revision)
  })

  it('catches up after a crash between the tombstone commit and unlink, including staging and an older revision', async () => {
    const who = await owner(), stored = await seed(who, { ageHours: 8 * 24, allocation: true })
    await assert.rejects(cleanup.remove(await candidate(stored), async () => { throw new Error('simulated process interruption') }), /interruption/)
    assert.equal((await reread(stored)).value.file.state, 'expired')
    assert.deepEqual(await readFile(join(storageRoot, 'objects', stored.storageKey)), content)
    const olderKey = randomUUID(), olderRevisionId = randomUUID()
    await database.pool.query(`insert into file_revisions
      (revision_id,file_id,filename,media_type,byte_size,sha256,origin,created_at,storage_key)
      values ($1,$2,$3,$4,$5,$6,'upload',$7,$8)`, [olderRevisionId, stored.value.file.fileId,
      metadata.filename, metadata.mediaType, metadata.byteSize, metadata.sha256, stored.value.file.createdAt, olderKey])
    await publish({ ...stored, storageKey: olderKey, value: { ...stored.value, revision: { ...stored.value.revision, revisionId: olderRevisionId } } })
    await writeFile(join(storageRoot, 'staging', stored.storageKey, `${randomUUID()}.part`), 'crash residue')
    await sweepAll(1)
    await missing(stored)
    await assert.rejects(readFile(join(storageRoot, 'objects', olderKey)), { code: 'ENOENT' })
    assert.ok(await files.read(stored.value.file.fileId, olderRevisionId), 'Every immutable revision stays in metadata')
    // A request admitted before expiry can reach mkdir after the sweep. Disk reconciliation must revisit it.
    await mkdir(join(storageRoot, 'staging', stored.storageKey), { mode: 0o700 })
    await writeFile(join(storageRoot, 'staging', stored.storageKey, `${randomUUID()}.part`), 'late attempt')
    await sweepAll(1); await missing(stored)
  })

  it('cleans pending crash allocations and canceled temporary residue while preserving their metadata', async () => {
    const who = await owner()
    const pending = await seed(who, { ageHours: 8 * 24, state: 'pending', allocation: true, stagingOnly: true })
    const removed = await seed(who, { state: 'removed', stagingOnly: true })
    await sweepAll()
    await missing(pending); await missing(removed)
    assert.equal((await reread(pending)).value.file.state, 'expired')
    assert.equal((await reread(removed)).value.file.state, 'removed')
    assert.deepEqual((await reread(pending)).value.revision, pending.value.revision)
  })

  it('never touches either permanent scope, even removed references, unknown objects or a shared inode', async () => {
    const who = await owner()
    const workflow = await seed(who, { reference: 'workflow_reference', ageHours: 365 * 24 })
    const workspace = await seed(who, { reference: 'workspace_reference', ageHours: 365 * 24 })
    const removed = await seed(who, { reference: 'workspace_reference', state: 'removed', ageHours: 365 * 24 })
    const temporary = await seed(who, { ageHours: 8 * 24 })
    await unlink(join(storageRoot, 'objects', temporary.storageKey))
    await link(join(storageRoot, 'objects', workflow.storageKey), join(storageRoot, 'objects', temporary.storageKey))
    const unknownKey = randomUUID()
    await writeFile(join(storageRoot, 'objects', unknownKey), 'unmapped; do not infer authority from age')
    for (const reference of [workflow, workspace, removed]) {
      assert.deepEqual(await cleanup.findByStorageKeys([reference.storageKey]), [])
      const forged: FileCleanupCandidate = { ...pins(reference), ownerPrincipalId: who.principal.id,
        storageKey: reference.storageKey, requestId: null, retentionRevision: 0, expiresAt: '2000-01-01T00:00:00.000000Z' }
      assert.equal(await cleanup.remove(forged, async () => { assert.fail('Permanent bytes reached unlink'); }), 'stale')
    }
    await sweepAll(); await missing(temporary)
    for (const reference of [workflow, workspace, removed]) {
      assert.deepEqual(await reread(reference), reference)
      assert.deepEqual(await readFile(join(storageRoot, 'objects', reference.storageKey)), content)
      assert.deepEqual(await readdir(join(storageRoot, 'staging', reference.storageKey)), [])
    }
    assert.equal(await readFile(join(storageRoot, 'objects', unknownKey), 'utf8'), 'unmapped; do not infer authority from age')
  })

  it('coordinates two sweeper instances with publication and holds the retention lock through unlink', async () => {
    const who = await owner(), stored = await seed(who, { ageHours: 8 * 24, allocation: true })
    const selected = await candidate(stored), entered = deferred(), release = deferred()
    const first = cleanup.remove(selected, async () => { entered.resolve(); await release.promise; return physical.remove(stored.storageKey) })
    await entered.promise
    try {
      assert.equal(await new PostgresFileCleanupRepository(database.pool).remove(selected, async () => { assert.fail('Two sweepers entered unlink'); }), 'busy')
      assert.ok(selected.requestId)
      await assert.rejects(files.withAllocation(who.principal.id, selected.requestId, async () => undefined), { code: 'FILE_UPLOAD_BUSY' })
      const checking = await database.pool.connect()
      try {
        await checking.query('begin')
        const acquired = await checking.query<{ locked: boolean }>('select pg_try_advisory_xact_lock(hashtextextended($1,273640)) as locked', [who.principal.id])
        assert.equal(acquired.rows[0]!.locked, false, 'FIL-40 save must not race the physical deletion')
      } finally {
        try { await checking.query('rollback') } finally { checking.release() }
      }
    } finally { release.resolve(); await first }
    await missing(stored)
    await assert.rejects(service.finalize(who.principal, target(who), selected.requestId!), { code: 'FILE_EXPIRED' })
  })

  it('rejects a stale due snapshot while an earlier live extension commits after the old deadline', async () => {
    const who = await owner()
    await save(who, 3600)
    const stored = await seed(who, { seconds: 3600, createdAt: new Date(Date.now() - hour + 3000).toISOString() })
    const oldExpiry = TemporaryFileSchema.parse(stored.value.file).expiresAt
    const blocker = await database.pool.connect()
    let held = false, triggerCreated = false, saving: ReturnType<FileRetentionService['save']> | undefined
    try {
      await database.pool.query(`create function fil04_pause_receipt() returns trigger language plpgsql as $$
      begin if new.operation='file_retention_save' and new.command_id='fil04-extension-race' then
        perform pg_advisory_xact_lock(273604,4); end if; return new; end $$;
      create trigger fil04_pause_receipt before insert on management_command_receipts
      for each row execute function fil04_pause_receipt();`)
      triggerCreated = true
      await blocker.query('select pg_advisory_lock(273604,4)'); held = true
      const blockerPid = (await blocker.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      saving = retention.save(who.principal, 'http', { commandId: 'fil04-extension-race', expectedRevision: 1,
        durationSeconds: 7200, applyToExisting: true })
      void saving.catch(() => undefined)
      const waiting = await readUntil(async () => {
        return (await database.pool.query<{ waiting: boolean }>(`select exists(select 1 from pg_stat_activity
          where $1::int=any(pg_blocking_pids(pid)) and wait_event_type='Lock') as waiting`, [blockerPid])).rows[0]!.waiting
      }, value => value, { timeoutMs: 1000, description: 'the PostgreSQL lock wait' })
      assert.equal(waiting, true, 'Pause the real retention command after its live-file update, before COMMIT')
      await database.pool.query("select pg_sleep(greatest(0,extract(epoch from $1::timestamptz-clock_timestamp()))+0.02)", [oldExpiry])
      const stale = await candidate(stored) // MVCC still exposes the pre-save overdue file and preference revision 1.
      assert.equal(stale.retentionRevision, 1)
      assert.equal(await cleanup.remove(stale, async () => { assert.fail('Owner lock ignored'); }), 'busy')
      await blocker.query('select pg_advisory_unlock(273604,4)'); held = false
      assert.equal((await saving).value.updatedFileCount, 1)
      assert.equal(await cleanup.remove(stale, async () => { assert.fail('Stale expiry/revision deleted extended file'); }), 'stale')
      assert.deepEqual(await cleanup.findByStorageKeys([stored.storageKey]), [])
      const extended = TemporaryFileSchema.parse((await reread(stored)).value.file)
      assert.equal(extended.state, 'ready'); assert.equal(extended.retentionDurationSeconds, 7200)
      assert.deepEqual(await readFile(join(storageRoot, 'objects', stored.storageKey)), content)
    } finally {
      try { if (held) await blocker.query('select pg_advisory_unlock(273604,4)') } finally { blocker.release() }
      if (saving) await Promise.allSettled([saving])
      if (triggerCreated) await database.pool.query('drop trigger fil04_pause_receipt on management_command_receipts; drop function fil04_pause_receipt()')
    }
  }, 15_000)

  it('lets an admitted download finish at expiry but rejects subsequent reads', async () => {
    const who = await owner(), stored = await seed(who)
    const admitted = await service.download(who.principal, target(who), pins(stored))
    try {
      await save(who, 3600, true)
      assert.equal(await cleanup.remove(await candidate(stored), () => physical.remove(stored.storageKey)), 'cleaned')
      const chunks: Buffer[] = []
      for await (const chunk of admitted.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      assert.deepEqual(Buffer.concat(chunks), content)
      await assert.rejects(service.download(who.principal, target(who), pins(stored)), { code: 'FILE_BYTES_UNAVAILABLE', status: 410 })
    } finally { admitted.stream.destroy() }
  })

  it('rejects a download whose verification overlaps expiry/unlink, closing the verified descriptor', async () => {
    const who = await owner(), stored = await seed(who), verified = deferred(), release = deferred()
    let stream: Awaited<ReturnType<FileByteStorage['download']>> | undefined
    class PausedBytes extends FileByteStorage {
      override async download(...args: Parameters<FileByteStorage['download']>) {
        const verifiedStream = await super.download(...args)
        stream = verifiedStream; verified.resolve(); await release.promise; return verifiedStream
      }
    }
    const paused = new TemporaryFileService(files, new PausedBytes(storageRoot, MAX_FILE_BYTES), authorization)
    const reading = paused.download(who.principal, target(who), pins(stored))
    void reading.catch(() => undefined)
    await verified.promise
    try {
      await save(who, 3600, true)
      await cleanup.remove(await candidate(stored), () => physical.remove(stored.storageKey))
    } finally { release.resolve() }
    await assert.rejects(reading, { code: 'FILE_BYTES_UNAVAILABLE', status: 410 })
    assert.equal(stream?.destroyed, true)
    await missing(stored)
  })
})
