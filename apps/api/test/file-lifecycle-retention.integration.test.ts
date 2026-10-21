import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { FilePageSchema, MAX_FILE_BYTES, TemporaryFileSchema, temporaryFileExpiresAt } from '@foreman-code/contracts/files'
import type { StoredFile } from '../src/modules/files/repository.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { FileRetentionService } from '../src/modules/files/retention.js'
import { FileByteStorage } from '../src/modules/files/storage.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { absent, allocate, base, candidate, collect, contentUrl, fil14Database, headers, historical, hour, markdown, owner, pins, reread, save, sweep, target, waitFor, type Fil14Database, type Owner, type Runtime } from './helpers/fil14Lifecycle.js'
import { deferred } from './helpers/deferred.js'

/** Real DB time and independent PostgreSQL sessions; no fake Date/SQL model.
 * The tiny trigger below is confined to the disposable schema and pauses only the
 * chosen retention command AFTER its changes and BEFORE receipt insertion/COMMIT. */
describe.skipIf(!postgresEnabled)('FIL-14 retention, expiry and sweeper lifecycle verification', () => {
  let database: Fil14Database, runtime: Runtime
  beforeAll(async () => { database = await fil14Database(); runtime = await database.open() }, 60_000)
  afterAll(async () => { await database?.close() })

  it('persists retention saves in the fixture database for independent service readback', async () => {
    const who = await owner(runtime)
    const saved = await save(runtime, who, 7200)
    const persistedRetention = new FileRetentionService(database.pool, new PostgresCommandCoordinator(database.pool))

    const persisted = await persistedRetention.get(who.principal, 'http')
    assert.deepEqual(persisted.preference, saved.value.preference)

    const restarted = await database.open()
    try {
      assert.deepEqual((await restarted.retention.get(who.principal, 'http')).preference, persisted.preference)
    } finally {
      await restarted.close()
    }
  })

  async function pausedSave(who: Owner, durationSeconds: number, work: (pending: {
    result: ReturnType<FileRetentionService['save']>; release: () => Promise<void>
  }) => Promise<void>) {
    const { preference } = await runtime.retention.get(who.principal, 'http')
    const commandId = randomUUID(), blocker = await database.pool.connect()
    let held = false, installed = false, result: ReturnType<FileRetentionService['save']> | undefined
    const release = async () => {
      if (!held) return
      const unlocked = await blocker.query<{ ok: boolean }>('select pg_advisory_unlock(hashtextextended($1,273614)) as ok', [commandId])
      assert.equal(unlocked.rows[0]!.ok, true); held = false
    }
    try {
      await database.pool.query(`create function fil14_pause_retention() returns trigger language plpgsql as $$
        begin if new.operation='file_retention_save' and new.command_id=TG_ARGV[0] then
          perform pg_advisory_xact_lock(hashtextextended(new.command_id,273614));
        end if; return new; end $$;
        create trigger fil14_pause_retention before insert on management_command_receipts
        for each row execute function fil14_pause_retention('${commandId}');`)
      installed = true
      await blocker.query('select pg_advisory_lock(hashtextextended($1,273614))', [commandId]); held = true
      const pid = (await blocker.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      result = runtime.retention.save(who.principal, 'http', { commandId, expectedRevision: preference.revision,
        durationSeconds, applyToExisting: true })
      void result.catch(() => undefined)
      await waitFor(async () => (await database.pool.query<{ waiting: boolean }>(`select exists(
        select 1 from pg_stat_activity where datname=current_database()
          and $1::int=any(pg_blocking_pids(pid)) and wait_event_type='Lock') as waiting`, [pid])).rows[0]!.waiting,
      'Real retention command did not reach its pre-COMMIT barrier')
      await work({ result, release })
    } finally {
      try { await release() } finally {
        blocker.release(held)
        if (result) await Promise.allSettled([result])
        if (installed) await database.pool.query('drop trigger fil14_pause_retention on management_command_receipts; drop function fil14_pause_retention()')
      }
    }
  }

  for (const durationSeconds of [604800, 7200]) {
    it(`${durationSeconds}-second retention: allocation snapshot and original creation time survive preference changes/restart`, async () => {
      const who = await owner(runtime)
      const initialPreference = (await runtime.retention.get(who.principal, 'http')).preference
      assert.equal(initialPreference.durationSeconds, 604800)
      assert.equal(initialPreference.revision, 0)
      const absentPreference = await runtime.pool.query('select 1 from file_retention_preferences where owner_principal_id=$1', [who.principal.id])
      assert.equal(absentPreference.rowCount, 0, 'Default readback must not write a preference')
      if (durationSeconds !== 604800) await save(runtime, who, durationSeconds)
      const requestId = randomUUID(), value = await allocate(runtime, who, requestId)
      const file = TemporaryFileSchema.parse(value.file)
      assert.equal(file.retentionDurationSeconds, durationSeconds)
      assert.equal(file.expiresAt, temporaryFileExpiresAt(file.createdAt, durationSeconds))
      await save(runtime, who, 3600, false)
      const restarted = await database.open()
      try {
        assert.deepEqual(await allocate(restarted, who, requestId), value, 'Receipt replay cannot slide expiry or resnapshot preference')
        const next = TemporaryFileSchema.parse((await allocate(restarted, who, randomUUID())).file)
        assert.equal(next.retentionDurationSeconds, 3600)
        assert.deepEqual((await reread(restarted, value)).value.revision, value.revision)
        await sweep(restarted)
        assert.deepEqual((await reread(restarted, value)).value, value, 'Future-only save must not shorten old files')
      } finally { await restarted.close() }
    })
  }

  it('shortens first while sweeping: uncommitted expiry grants no deletion, committed expiry produces readable tombstones', async () => {
    const who = await owner(runtime), stored = await historical(runtime, who)
    const reference = await historical(runtime, who, { reference: 'workspace_reference', ageHours: 365 * 24 })
    const preview = await runtime.retention.preview(who.principal, 'http', { durationSeconds: 3600 })
    assert.equal(preview.expireNowCount, 1)
    await pausedSave(who, 3600, async ({ result, release }) => {
      assert.deepEqual((await reread(runtime, stored.value)).value, stored.value, 'MVCC reads must see the pre-save version')
      assert.deepEqual(await runtime.cleanup.findByStorageKeys([stored.storageKey]), [])
      await sweep(runtime, 1)
      assert.deepEqual(await readFile(join(database.root, 'objects', stored.storageKey)), markdown.bytes)
      await release()
      const saved = await result
      assert.equal(saved.value.updatedFileCount, 1); assert.equal(saved.value.expiredNowCount, 1)
    })
    const shortened = TemporaryFileSchema.parse((await reread(runtime, stored.value)).value.file)
    assert.equal(shortened.expiresAt, temporaryFileExpiresAt(stored.value.file.createdAt, 3600))
    await sweep(runtime, 1); await absent(database.root, stored)
    const tombstone = await runtime.app.inject({ method: 'GET', url: base(who), headers: headers(who) })
    assert.equal(tombstone.statusCode, 200, tombstone.body)
    const listed = FilePageSchema.parse(tombstone.json()).items
    assert.equal(listed.length, 1, 'References must not appear in the Operator chat list')
    assert.equal(listed[0]!.file.state, 'expired')
    assert.deepEqual(listed[0]!.revision, stored.value.revision)
    assert.equal(listed[0]!.file.createdAt, stored.value.file.createdAt)
    assert.deepEqual(await reread(runtime, reference.value), reference)
    assert.deepEqual(await readFile(join(database.root, 'objects', reference.storageKey)), markdown.bytes)
    const extension = await save(runtime, who, 31536000, true)
    assert.equal(extension.value.updatedFileCount, 0)
    assert.equal((await reread(runtime, stored.value)).value.file.state, 'expired')
    assert.equal((await runtime.app.inject({ method: 'GET', url: contentUrl(who, stored.value), headers: headers(who) })).statusCode, 410)
  }, 15_000)

  it('an extension that starts live and commits after the old deadline fences both stale expiry and retention revision', async () => {
    const who = await owner(runtime)
    await save(runtime, who, 3600)
    const now = (await runtime.pool.query<{ at: Date }>('select clock_timestamp() as at')).rows[0]!.at
    const stored = await historical(runtime, who, { seconds: 3600,
      createdAt: new Date(now.getTime() - hour + 3000).toISOString() })
    const old = TemporaryFileSchema.parse(stored.value.file)
    await pausedSave(who, 7200, async ({ result, release }) => {
      // Wait for the DATABASE deadline, not a guessed JavaScript wall-clock delay.
      await database.pool.query("select pg_sleep(greatest(0,extract(epoch from $1::timestamptz-clock_timestamp()))+0.01)", [old.expiresAt])
      const stale = await candidate(runtime, stored)
      assert.equal(stale.retentionRevision, 1)
      assert.equal(await runtime.cleanup.remove(stale, async () => { assert.fail('Owner lock ignored before extension COMMIT') }), 'busy')
      await release()
      assert.equal((await result).value.updatedFileCount, 1, 'Must exercise an extension selected while still live')
      assert.equal(await runtime.cleanup.remove(stale, async () => { assert.fail('Stale discovery deleted the extended bytes') }), 'stale')
      const extended = TemporaryFileSchema.parse((await reread(runtime, stored.value)).value.file)
      assert.equal(extended.state, 'ready'); assert.equal(extended.retentionDurationSeconds, 7200)
      assert.equal(extended.createdAt, old.createdAt)
      assert.equal(extended.expiresAt, temporaryFileExpiresAt(old.createdAt, 7200))
      assert.deepEqual(await runtime.cleanup.findByStorageKeys([stored.storageKey]), [])
      await sweep(runtime, 1)
      assert.deepEqual(await readFile(join(database.root, 'objects', stored.storageKey)), markdown.bytes)
      assert.deepEqual((await reread(runtime, stored.value)).value.revision, stored.value.revision)
    })
  }, 20_000)

  for (const durationSeconds of [3600, 31536000]) {
    it(`sweeper wins the owner lock: concurrent ${durationSeconds}-second apply cannot revive committed expiry`, async () => {
      const who = await owner(runtime), stored = await historical(runtime, who, { ageHours: 8 * 24 })
      const selected = await candidate(runtime, stored), entered = deferred(), release = deferred()
      const cleaning = runtime.cleanup.remove(selected, async () => {
        entered.resolve(); await release.promise
        return runtime.physical.remove(stored.storageKey)
      })
      void cleaning.catch(() => undefined)
      let saving: ReturnType<FileRetentionService['save']> | undefined
      try {
        await Promise.race([entered.promise, cleaning.then(() => assert.fail('Cleanup never reached guarded unlink'))])
        assert.equal((await reread(runtime, stored.value)).value.file.state, 'expired', 'Tombstone is durable before unlink')
        saving = runtime.retention.save(who.principal, 'http', { commandId: randomUUID(), expectedRevision: 0,
          durationSeconds, applyToExisting: true })
        void saving.catch(() => undefined)
        await waitFor(async () => (await database.pool.query<{ waiting: boolean }>(`select exists(
          select 1 from pg_stat_activity where application_name=$1 and wait_event_type='Lock'
            and cardinality(pg_blocking_pids(pid))>0) as waiting`, [runtime.applicationName])).rows[0]!.waiting,
        'Retention save did not block behind guarded cleanup')
        release.resolve()
        assert.equal(await cleaning, 'cleaned')
        const saved = await saving
        assert.equal(saved.value.updatedFileCount, 0); assert.equal(saved.value.expiredNowCount, 0)
        await absent(database.root, stored)
        assert.equal((await reread(runtime, stored.value)).value.file.state, 'expired')
        assert.deepEqual((await reread(runtime, stored.value)).value.revision, stored.value.revision)
      } finally {
        release.resolve()
        await Promise.allSettled(saving ? [cleaning, saving] : [cleaning])
      }
    }, 15_000)
  }

  it('future-only preference revision changes invalidate discovery even when expiry itself did not change', async () => {
    const who = await owner(runtime), stored = await historical(runtime, who, { ageHours: 8 * 24 })
    const stale = await candidate(runtime, stored)
    assert.equal(stale.retentionRevision, 0)
    await save(runtime, who, 31536000, false)
    assert.equal(await runtime.cleanup.remove(stale, async () => { assert.fail('Old preference revision authorized deletion') }), 'stale')
    assert.deepEqual(await readFile(join(database.root, 'objects', stored.storageKey)), markdown.bytes)
    const fresh = await candidate(runtime, stored)
    assert.equal(fresh.expiresAt, stale.expiresAt); assert.equal(fresh.retentionRevision, 1)
    assert.equal(await runtime.cleanup.remove(fresh, () => runtime.physical.remove(stored.storageKey)), 'cleaned')
    await absent(database.root, stored)
  })

  it('never resurrects overdue pending/ready or stored expired/removed files on extension, before or after physical cleanup', async () => {
    const who = await owner(runtime), unchanged: StoredFile[] = []
    for (const state of ['pending', 'ready', 'expired', 'removed'] as const) {
      unchanged.push(await historical(runtime, who, { state, ageHours: 8 * 24, stagingOnly: state === 'pending' }))
    }
    const extension = await save(runtime, who, 31536000, true)
    assert.equal(extension.value.updatedFileCount, 0)
    for (const stored of unchanged) assert.deepEqual(await reread(runtime, stored.value), stored)
    const before = await runtime.app.inject({ method: 'GET', url: base(who), headers: headers(who) })
    assert.equal(before.statusCode, 200, before.body)
    const states = FilePageSchema.parse(before.json()).items.map((value) => value.file.state).sort()
    assert.deepEqual(states, ['expired', 'expired', 'expired', 'removed'])
    await sweep(runtime, 1)
    for (const stored of unchanged) {
      await absent(database.root, stored)
      const value = (await reread(runtime, stored.value)).value
      assert.equal(value.file.state, stored.value.file.state === 'removed' ? 'removed' : 'expired')
      assert.deepEqual(value.revision, stored.value.revision)
    }
    assert.equal((await save(runtime, who, 604800, true)).value.updatedFileCount, 0)
  })

  it('preserves both permanent scopes, including removed references, across retention changes, restart and shared-inode cleanup', async () => {
    const who = await owner(runtime), references: StoredFile[] = []
    for (const reference of ['workspace_reference', 'workflow_reference'] as const) {
      for (const state of ['ready', 'removed'] as const) {
        references.push(await historical(runtime, who, { reference, state, ageHours: 366 * 24 }))
      }
    }
    const temporary = await historical(runtime, who, { ageHours: 8 * 24 })
    await unlink(join(database.root, 'objects', temporary.storageKey))
    await link(join(database.root, 'objects', references[0]!.storageKey), join(database.root, 'objects', temporary.storageKey))
    for (const reference of references) {
      // Even pending publication residue belonging to references is outside temporary cleanup.
      await writeFile(join(database.root, 'staging', reference.storageKey, `${randomUUID()}.part`), 'permanent residue', { mode: 0o600 })
    }
    await save(runtime, who, 3600, true); await save(runtime, who, 31536000, true)
    const restarted = await database.open()
    try {
      await sweep(restarted, 1); await absent(database.root, temporary)
      for (const reference of references) {
        assert.deepEqual(await reread(restarted, reference.value), reference)
        assert.equal('expiresAt' in reference.value.file, false)
        assert.equal('retentionDurationSeconds' in reference.value.file, false)
        assert.deepEqual(await restarted.cleanup.findByStorageKeys([reference.storageKey]), [])
        assert.deepEqual(await readFile(join(database.root, 'objects', reference.storageKey)), markdown.bytes)
        const residue = await readdir(join(database.root, 'staging', reference.storageKey))
        assert.equal(residue.length, 1); assert.match(residue[0]!, /\.part$/)
        const direct = await restarted.bytes.download(reference.storageKey, reference.value.revision)
        assert.deepEqual(await collect(direct), markdown.bytes, 'Unlinking a temporary hard link must not truncate the permanent inode')
      }
    } finally { await restarted.close() }
  })

  it('an admitted download finishes after expiry/unlink while every new HTTP request is denied', async () => {
    const who = await owner(runtime), stored = await historical(runtime, who)
    const admitted = await runtime.service.download(who.principal, target(who), pins(stored.value))
    try {
      await save(runtime, who, 3600, true)
      await sweep(runtime, 1); await absent(database.root, stored)
      assert.deepEqual(await collect(admitted.stream), markdown.bytes)
      const downloaded = await runtime.app.inject({ method: 'GET', url: contentUrl(who, stored.value), headers: headers(who) })
      assert.equal(downloaded.statusCode, 410, downloaded.body)
      assert.equal(downloaded.json().error.code, 'FILE_BYTES_UNAVAILABLE')
    } finally { admitted.stream.destroy() }
  })

  it('expiry between descriptor verification and admission rejects the HTTP download and closes the descriptor', async () => {
    const who = await owner(runtime), stored = await historical(runtime, who), verified = deferred(), release = deferred()
    let captured: Awaited<ReturnType<FileByteStorage['download']>> | undefined
    class PausedBytes extends FileByteStorage {
      override async download(...args: Parameters<FileByteStorage['download']>) {
        const stream = await super.download(...args)
        captured = stream; verified.resolve(); await release.promise
        return stream
      }
    }
    const paused = await database.open({ bytes: new PausedBytes(database.root, MAX_FILE_BYTES) })
    // Calling .then starts injection now rather than leaving a lazy injection builder.
    const request = paused.app.inject({ method: 'GET', url: contentUrl(who, stored.value), headers: headers(who) }).then((reply) => reply)
    void request.catch(() => undefined)
    try {
      await Promise.race([verified.promise, request.then(() => assert.fail('Download skipped the verification barrier'))])
      await save(runtime, who, 3600, true)
      await sweep(runtime, 1)
      release.resolve()
      const denied = await request
      assert.equal(denied.statusCode, 410, denied.body)
      assert.equal(denied.json().error.code, 'FILE_BYTES_UNAVAILABLE')
      assert.equal(captured?.destroyed, true)
      await waitFor(async () => captured?.closed === true, 'Rejected download did not close its file descriptor')
      await absent(database.root, stored)
    } finally {
      release.resolve(); await Promise.allSettled([request]); captured?.destroy(); await paused.close()
    }
  })

  it('catches up after downtime and a failed unlink, including late .part residue and empty allocation directories', async () => {
    const who = await owner(runtime), stored = await historical(runtime, who, { ageHours: 8 * 24 })
    const pending = await historical(runtime, who, { ageHours: 8 * 24, state: 'pending', stagingOnly: true })
    await assert.rejects(runtime.cleanup.remove(await candidate(runtime, stored), async () => {
      throw Object.assign(new Error('FIL-14 disk failure before unlink'), { code: 'EIO' })
    }), { code: 'EIO' })
    assert.equal((await reread(runtime, stored.value)).value.file.state, 'expired')
    assert.deepEqual(await readFile(join(database.root, 'objects', stored.storageKey)), markdown.bytes)
    await writeFile(join(database.root, 'staging', pending.storageKey, `${randomUUID()}.part`), 'interrupted body', { mode: 0o600 })
    const restarted = await database.open()
    try {
      await sweep(restarted, 1)
      for (const file of [stored, pending]) {
        await absent(database.root, file)
        assert.equal((await reread(restarted, file.value)).value.file.state, 'expired')
        assert.deepEqual((await reread(restarted, file.value)).value.revision, file.value.revision)
      }
      // A previously admitted receiver can reach mkdir after the first pass. Restart/disk
      // discovery must find this even though there is no pending/ready SQL row anymore.
      await mkdir(join(database.root, 'staging', stored.storageKey), { mode: 0o700 })
      await writeFile(join(database.root, 'staging', stored.storageKey, `${randomUUID()}.part`), 'late attempt', { mode: 0o600 })
      await mkdir(join(database.root, 'staging', pending.storageKey), { mode: 0o700 })
      await sweep(restarted, 1); await absent(database.root, stored); await absent(database.root, pending)
      await sweep(restarted, 1) // Repeated cleanup is safe and does not destroy tombstones.
      const listed = await restarted.app.inject({ method: 'GET', url: base(who), headers: headers(who) })
      assert.equal(listed.statusCode, 200, listed.body)
      assert.equal(FilePageSchema.parse(listed.json()).items.length, 2)
    } finally { await restarted.close() }
  })
})
