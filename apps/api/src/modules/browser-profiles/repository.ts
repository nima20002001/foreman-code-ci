import type pg from 'pg'
import { BrowserProfileSchema, BrowserProfileReplicaSchema, BrowserProfileSyncJobSchema, BrowserProfileSnapshotManifestSchema } from '@foreman-code/contracts/browser-profiles'
import { withTransaction, type SqlQuery } from '../../infrastructure/transaction.js'
import { browserInputHash } from './identity.js'
import type { BrowserProfileRepository, BrowserProfileTransaction, BrowserProfileReplica,
  BrowserProfileSyncJob, StoredProfile, ProfileCommand, ProfileHostIntent, BrowserProfileSnapshotManifest, BrowserReplicaFacts, BrowserCatalogRow, BrowserProfilePendingWork, BrowserSnapshotRetention, BrowserSnapshotIdentity } from './types.js'

class ProfileTransaction implements BrowserProfileTransaction {
  constructor(readonly sql: SqlQuery) {}

  private async dirty(profileId: string): Promise<void> {
    await this.sql.query(`insert into browser_profile_retention_dirty(profile_id) values($1)
      on conflict(profile_id) do update set revision=browser_profile_retention_dirty.revision+1`, [profileId])
  }

  async pendingWork(after: string | undefined, limit: number): Promise<BrowserProfilePendingWork[]> {
    return (await this.sql.query<BrowserProfilePendingWork>(`select * from (
      select 'i:'||id as key,'intent' as kind,id from browser_profile_intents where record->>'state' in ('queued','running') and record->>'operation'<>'sync'
      union all select 'j:'||id,'job',id from browser_profile_sync_jobs where record->>'state' in ('queued','running')
      union all select 'r:'||profile_id,'retention',profile_id from browser_profile_retention_dirty
      ) pending where ($1::text is null or key>$1) order by key limit $2`, [after ?? null, limit])).rows
  }

  async retention(profileId: string): Promise<BrowserSnapshotRetention> {
    const snapshots = new Map<string, BrowserSnapshotIdentity>(), operations = new Set<string>(), computers = new Set<string>()
    const add = (snapshot: BrowserSnapshotIdentity | null | undefined) => { if (snapshot) snapshots.set(snapshot.sha256, snapshot) }
    add((await this.publishedManifest(profileId))?.snapshot)
    for (const replica of await this.replicas(profileId)) {
      computers.add(replica.computerId); add(replica.desiredSnapshot); add(replica.receivedSnapshot); add(replica.appliedSnapshot)
    }
    const jobs = (await this.sql.query<{ record: unknown }>(`select record from browser_profile_sync_jobs
      where record->>'state' in ('queued','running') and record->'profiles' @> $1::jsonb`, [JSON.stringify([{ profileId }])])).rows
    for (const row of jobs) {
      const job = BrowserProfileSyncJobSchema.parse(row.record)
      operations.add(`${job.id}:export:${profileId}`)
      for (const source of job.profiles.filter(value => value.profileId === profileId)) { computers.add(source.sourceComputerId); add(source.manifest?.snapshot) }
      for (const target of job.targets.filter(value => value.profileId === profileId)) add(target.snapshot)
    }
    const owner = await this.exportOwner(profileId)
    if (owner) operations.add(`${owner}:export:${profileId}`)
    const revision = Number((await this.sql.query<{ revision: string }>('select revision from browser_profile_retention_dirty where profile_id=$1', [profileId])).rows[0]?.revision ?? 0)
    return { snapshots: [...snapshots.values()], operations: [...operations], computers: [...computers], revision }
  }

  async clearRetention(profileId: string, revision: number): Promise<void> {
    await this.sql.query('delete from browser_profile_retention_dirty where profile_id=$1 and revision=$2', [profileId, revision])
  }

  async profile(id: string): Promise<StoredProfile | undefined> {
    const row = (await this.sql.query<{ record: unknown; deleted: boolean }>(
      'select record, deleted from browser_profiles where id=$1', [id])).rows[0]
    return row ? { profile: BrowserProfileSchema.parse(row.record), deleted: row.deleted } : undefined
  }

  async putProfile({ profile, deleted }: StoredProfile): Promise<void> {
    const changed = await this.sql.query(`insert into browser_profiles(id,record,deleted) values($1,$2,$3)
      on conflict(id) do update set record=excluded.record, deleted=excluded.deleted
      where browser_profiles.record is distinct from excluded.record or browser_profiles.deleted is distinct from excluded.deleted`,
    [profile.id, BrowserProfileSchema.parse(profile), deleted])
    if (changed.rowCount) { await this.sql.query('update browser_catalog_revision set revision=revision+1 where singleton'); await this.dirty(profile.id) }
  }

  async profiles(after: string | undefined, limit: number): Promise<StoredProfile[]> {
    const result = await this.sql.query<{ record: unknown; deleted: boolean }>(
      'select record,deleted from browser_profiles where not deleted and ($1::text is null or id>$1) order by id limit $2',
      [after ?? null, limit])
    return result.rows.map(row => ({ profile: BrowserProfileSchema.parse(row.record), deleted: row.deleted }))
  }

  async replicaFacts(profileId: string, computerId: string): Promise<BrowserReplicaFacts> {
    const row = (await this.sql.query<{ present: boolean; presence_revision: string; current_intent: ProfileHostIntent | null }>(
      'select present,presence_revision,current_intent from browser_profile_presence where profile_id=$1 and computer_id=$2', [profileId, computerId])).rows[0]
    return row ? { present: row.present, presenceRevision: Number(row.presence_revision), currentIntent: row.current_intent }
      : { present: false, presenceRevision: 0, currentIntent: null }
  }

  async catalogRows(after: readonly [string, string] | undefined, computerIds: readonly string[], limit: number): Promise<BrowserCatalogRow[]> {
    const rows = (await this.sql.query<{ profile: unknown; replica: unknown | null; computer_id: string; present: boolean | null;
      presence_revision: string | null; current_intent: ProfileHostIntent | null }>(`select p.record as profile,r.record as replica,
      c.computer_id,f.present,f.presence_revision,f.current_intent
      from browser_profiles p cross join unnest($1::text[]) as c(computer_id)
      left join browser_profile_replicas r on r.profile_id=p.id and r.computer_id=c.computer_id
      left join browser_profile_presence f on f.profile_id=p.id and f.computer_id=c.computer_id
      where not p.deleted and ($2::text is null or (p.id,c.computer_id)>($2,$3))
      order by p.id,c.computer_id limit $4`, [computerIds, after?.[0] ?? null, after?.[1] ?? null, limit])).rows
    return rows.map(row => ({ profile: BrowserProfileSchema.parse(row.profile), replica: row.replica ? BrowserProfileReplicaSchema.parse(row.replica) : null,
      computerId: row.computer_id, facts: { present: row.present === true, presenceRevision: Number(row.presence_revision ?? 0), currentIntent: row.current_intent } }))
  }

  async replica(profileId: string, computerId: string): Promise<BrowserProfileReplica | undefined> {
    const row = (await this.sql.query<{ record: unknown }>(
      'select record from browser_profile_replicas where profile_id=$1 and computer_id=$2', [profileId, computerId])).rows[0]
    return row ? BrowserProfileReplicaSchema.parse(row.record) : undefined
  }

  async replicas(profileId: string): Promise<BrowserProfileReplica[]> {
    return (await this.sql.query<{ record: unknown }>(
      'select record from browser_profile_replicas where profile_id=$1 order by computer_id', [profileId])).rows
      .map(row => BrowserProfileReplicaSchema.parse(row.record))
  }

  async putReplica(replica: BrowserProfileReplica): Promise<void> {
    const changed = await this.sql.query(`insert into browser_profile_replicas(profile_id,computer_id,record) values($1,$2,$3)
      on conflict(profile_id,computer_id) do update set record=excluded.record
      where browser_profile_replicas.record is distinct from excluded.record`,
    [replica.profileId, replica.computerId, BrowserProfileReplicaSchema.parse(replica)])
    if (changed.rowCount) { await this.sql.query('update browser_catalog_revision set revision=revision+1 where singleton'); await this.dirty(replica.profileId) }
  }

  async job(id: string): Promise<BrowserProfileSyncJob | undefined> {
    const row = (await this.sql.query<{ record: unknown }>('select record from browser_profile_sync_jobs where id=$1', [id])).rows[0]
    return row ? BrowserProfileSyncJobSchema.parse(row.record) : undefined
  }

  async putJob(job: BrowserProfileSyncJob): Promise<void> {
    await this.sql.query(`insert into browser_profile_sync_jobs(id,record) values($1,$2)
      on conflict(id) do update set record=excluded.record`, [job.id, BrowserProfileSyncJobSchema.parse(job)])
    for (const profile of job.profiles) await this.dirty(profile.profileId)
  }

  async command(key: string): Promise<ProfileCommand | undefined> {
    const row = (await this.sql.query<{ input_hash: string; result: unknown }>(
      'select input_hash,result from browser_profile_commands where command_key=$1', [key])).rows[0]
    return row ? { hash: row.input_hash, result: row.result } : undefined
  }

  async putCommand(key: string, command: ProfileCommand): Promise<void> {
    await this.sql.query(`insert into browser_profile_commands(command_key,input_hash,result) values($1,$2,$3)
      on conflict(command_key) do update set result=excluded.result where browser_profile_commands.input_hash=excluded.input_hash`,
      [key, command.hash, command.result])
  }

  async intent(id: string): Promise<ProfileHostIntent | undefined> {
    return (await this.sql.query<{ record: ProfileHostIntent }>(
      'select record from browser_profile_intents where id=$1', [id])).rows[0]?.record
  }

  async putIntent(intent: ProfileHostIntent): Promise<void> {
    const previous = await this.intent(intent.id)
    const visible = (value: ProfileHostIntent) => { const record = { ...value }; delete record.claimId; delete record.claimUntil; return record }
    const semanticChange = !previous || browserInputHash(visible(previous)) !== browserInputHash(visible(intent))
    const changed = await this.sql.query(`insert into browser_profile_intents(id,profile_id,record) values($1,$2,$3)
      on conflict(id) do update set record=excluded.record where browser_profile_intents.record is distinct from excluded.record`, [intent.id, intent.profileId, intent])
    if (changed.rowCount) {
      await this.sql.query(`insert into browser_profile_presence(profile_id,computer_id,present,presence_revision,current_revision,current_intent)
        values($1,$2,$3,$4,$5,$6) on conflict(profile_id,computer_id) do update set
        present=case when $7 and browser_profile_presence.presence_revision<=$5 then $3 else browser_profile_presence.present end,
        presence_revision=case when $7 and browser_profile_presence.presence_revision<=$5 then $5 else browser_profile_presence.presence_revision end,
        current_revision=greatest(browser_profile_presence.current_revision,$5),
        current_intent=case when browser_profile_presence.current_revision<=$5 then $6 else browser_profile_presence.current_intent end`,
      [intent.profileId, intent.computerId, intent.state === 'completed' && intent.operation !== 'remove', intent.state === 'completed' ? intent.revision : 0,
        intent.revision, visible(intent), intent.state === 'completed'])
      if (semanticChange) {
        await this.sql.query('update browser_catalog_revision set revision=revision+1 where singleton')
        await this.dirty(intent.profileId)
      }
    }
  }

  async intents(profileId: string): Promise<ProfileHostIntent[]> {
    return (await this.sql.query<{ record: ProfileHostIntent }>(
      'select record from browser_profile_intents where profile_id=$1 order by id', [profileId])).rows.map(row => row.record)
  }

  async exportOwner(profileId: string): Promise<string | undefined> {
    return (await this.sql.query<{ job_id: string }>(
      'select job_id from browser_profile_exports where profile_id=$1', [profileId])).rows[0]?.job_id
  }

  async setExportOwner(profileId: string, jobId: string | null): Promise<void> {
    if (jobId === null) {
      await this.sql.query('delete from browser_profile_exports where profile_id=$1', [profileId])
      return
    }
    await this.sql.query(`insert into browser_profile_exports(profile_id,job_id) values($1,$2)
      on conflict(profile_id) do update set job_id=excluded.job_id`, [profileId, jobId])
  }

  async catalogRevision(): Promise<number> {
    return Number((await this.sql.query<{ revision: string }>('select revision from browser_catalog_revision where singleton')).rows[0]!.revision)
  }

  async publishedManifest(profileId: string): Promise<BrowserProfileSnapshotManifest | undefined> {
    const row = (await this.sql.query<{ manifest: unknown }>('select manifest from browser_profile_publications where profile_id=$1', [profileId])).rows[0]
    return row ? BrowserProfileSnapshotManifestSchema.parse(row.manifest) : undefined
  }

  async putPublishedManifest(manifest: BrowserProfileSnapshotManifest): Promise<void> {
    await this.sql.query(`insert into browser_profile_publications(profile_id,manifest) values($1,$2)
      on conflict(profile_id) do update set manifest=excluded.manifest`, [manifest.snapshot.profileId, BrowserProfileSnapshotManifestSchema.parse(manifest)])
  }

  async jobInstallation(jobId: string, computerId: string): Promise<string | undefined> {
    return (await this.sql.query<{ installation_id: string }>('select installation_id from browser_profile_job_installations where job_id=$1 and computer_id=$2', [jobId, computerId])).rows[0]?.installation_id
  }

  async putJobInstallation(jobId: string, computerId: string, installationId: string): Promise<void> {
    await this.sql.query('insert into browser_profile_job_installations(job_id,computer_id,installation_id) values($1,$2,$3)', [jobId, computerId, installationId])
  }
}

export function createBrowserProfileRepository(pool: pg.Pool): BrowserProfileRepository {
  return {
    read: work => withTransaction(pool, sql => work(new ProfileTransaction(sql)), { isolation: 'repeatable read', readOnly: true }),
    transaction: (locks, work) => withTransaction(pool, async sql => {
      for (const key of [...new Set(locks)].sort()) {
        await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`browser:${key}`])
      }
      return work(new ProfileTransaction(sql))
    }),
  }
}
