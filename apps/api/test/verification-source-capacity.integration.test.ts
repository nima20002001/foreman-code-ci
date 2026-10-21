import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { JobDefinitionRecordSchema, ResolvedJobDefinitionSpecRecordSchema }
  from '@foreman-code/contracts/job-verification'
import { JobVerificationProfileSchema } from '@foreman-code/contracts/job-verification-runtime'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresSourceReservations } from '../src/modules/sources/reservations.js'
import { sourceStorageLimits } from '../src/modules/sources/storageCapacity.js'
import { sourceStorageCapacityFixture } from './helpers/sourceStorageCapacityFixture.js'
import { agent3Database } from './helpers/wave25Agent3.js'
import { verificationCapacityFixture } from './helpers/verificationCapacityFixture.js'
import { verificationFixture } from './helpers/jobVerificationFixture.js'

let database: Awaited<ReturnType<typeof agent3Database>> | undefined
afterEach(async () => { await database?.close(); database = undefined })

// Real reservation/history SQL. The runtime metadata fixture makes no physical qualification claim.
it.each([['main', 4], ['device', 2]] as const)(
  'retains the qualified %s source allowance for %i large concurrent preparations without enlarging capture storage',
  async (host, count) => {
    database = await agent3Database()
    const pool = database.pool
    const profile = verificationCapacityFixture(host)
    const writer = await new PostgresAccessService(pool).issue({ name: 'Source capacity fixture', audience: 'operator',
      expiresAt: new Date(Date.now() + 3_600_000), grants: [{ actions: ['jobs:start'], scope: {} }] })
    await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
      [profile.workspaceId, JSON.stringify({ id: profile.workspaceId, name: 'Verification source capacity' })])
    const source = profile.root.source
    await pool.query(`insert into source_approvals
      (approved_source_id,snapshot_id,workspace_id,owner_principal_id,requested_by,command_id,input_hash,state,origin,request)
      values($1,$2,$3,$4,$4,$5,$6,'approved','{}','{}')`,
    [source.approvedSourceId, source.snapshotId, profile.workspaceId, writer.principal.id, randomUUID(), 'a'.repeat(64)])
    await pool.query(`insert into source_snapshots(snapshot_id,approved_source_id,workspace_id,manifest_digest,record)
      values($1,$2,$3,$4,'{}')`, [source.snapshotId, source.approvedSourceId, profile.workspaceId, source.manifestDigest])
    await pool.query(`insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision)
      values($1,$2,$3,1)`, [profile.root.binding.rootId, profile.workspaceId, randomUUID()])
    await pool.query(`insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record)
      values($1,1,$2,$3,$4::jsonb)`,
    [profile.root.binding.rootId, profile.workspaceId, source.snapshotId, JSON.stringify(profile.root)])
    await pool.query(`insert into job_runtime_profiles(id,workspace_id,revision,root_id,binding_revision,record)
      values($1,$2,1,$3,1,$4::jsonb)`,
    [profile.id, profile.workspaceId, profile.root.binding.rootId, JSON.stringify(profile)])
    const saved = JobVerificationProfileSchema.parse({ ...profile, status: 'unqualified', measurement: null })
    await pool.query('insert into job_runtime_profile_versions(profile_id,revision,record) values($1,1,$2::jsonb)',
      [profile.id, JSON.stringify(saved)])
    const measurement = profile.measurement!
    await pool.query(`insert into job_runtime_qualification_approvals
      (id,qualification_id,profile_id,profile_revision,workspace_id,record,measurement,requested_by)
      values($1,$2,$3,1,$4,$5::jsonb,$6::jsonb,$7)`,
    [measurement.identity.approvalId, measurement.identity.qualificationId, profile.id, profile.workspaceId,
      JSON.stringify({ status: 'complete' }), JSON.stringify(measurement), writer.principal.id])
    const facts = verificationFixture()
    const spec = ResolvedJobDefinitionSpecRecordSchema.parse({ ...facts.spec,
      policy: { ...facts.spec.policy, isolationPolicyId: profile.id, isolationPolicyRevision: profile.revision } })
    const definition = JobDefinitionRecordSchema.parse({ schemaVersion: 2, id: randomUUID(), versionId: randomUUID(),
      workspaceId: profile.workspaceId, name: 'Large source verification', revision: 1, spec,
      createdAt: profile.createdAt, updatedAt: profile.updatedAt })
    await pool.query(`insert into job_definitions(id,workspace_id,revision,version_id,record,updated_by)
      values($1,$2,1,$3,$4::jsonb,$5)`,
    [definition.id, profile.workspaceId, definition.versionId, JSON.stringify(definition), writer.principal.id])
    await pool.query(`insert into job_definition_versions(id,definition_id,workspace_id,revision,record)
      values($1,$2,$3,1,$4::jsonb)`,
    [definition.versionId, definition.id, profile.workspaceId, JSON.stringify(definition)])
    const scopeId = `${profile.root.binding.mainId}:${host}:source-capacity`
    const reservedBytes = 128 * 2 ** 20 * 3 + 4096 * 8192 + 2 ** 20
    const readCapacity = async () => sourceStorageCapacityFixture({ availableBytes: 100 * 2 ** 30,
      totalBytes: 100 * 2 ** 30 })
    const limits = sourceStorageLimits(await readCapacity())
    const sourceReservations = new PostgresSourceReservations(readCapacity)
    const captures = await sourceReservations.reserve(pool, { scopeId, ownerKind: 'capture', ownerId: randomUUID(),
      reservedBytes: limits.bytes - 1 })
    await sourceReservations.retain(pool, captures, 'retained')
    // Agent worktrees on the same computer fill their own pool; they never occupy its CI slots.
    for (let index = 0; index < limits.materializations; index++) {
      const agent = await sourceReservations.reserve(pool, { scopeId, ownerKind: 'materialization', ownerId: randomUUID(),
        reservedBytes: 0 })
      await sourceReservations.retain(pool, agent, 'owned')
    }
    await expect(sourceReservations.reserve(pool, { scopeId, ownerKind: 'materialization', ownerId: randomUUID(),
      reservedBytes: 0 })).rejects.toMatchObject({ code: 'SOURCE_CAPACITY' })
    const reservations = []
    for (let index = 0; index <= count; index++) {
      const operationId = randomUUID()
      await pool.query(`insert into job_computer_selections
        (execution_id,workspace_id,definition_version_id,attempt_id,operation_id,host_key,spec,limits,selection,source_scope,source_bytes)
        values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,'{}',$9,$10)`,
      [randomUUID(), profile.workspaceId, definition.versionId, randomUUID(), operationId, scopeId,
        JSON.stringify(spec), JSON.stringify(profile.spec.resources.limits), scopeId, reservedBytes])
      const request = { scopeId, ownerKind: 'materialization' as const, ownerId: operationId, reservedBytes }
      if (index === count) {
        await expect(sourceReservations.reserve(pool, request)).rejects.toMatchObject({ code: 'SOURCE_CAPACITY' })
      } else {
        const reserved = await sourceReservations.reserve(pool, request)
        await sourceReservations.retain(pool, reserved, 'owned')
        reservations.push(reserved)
      }
    }
    expect(reservations).toHaveLength(count)
    await expect(sourceReservations.reserve(pool, { scopeId, ownerKind: 'capture', ownerId: randomUUID(), reservedBytes: 2 }))
      .rejects.toMatchObject({ code: 'SOURCE_CAPACITY' })
    const restarted = new PostgresSourceReservations()
    expect(await restarted.reserve(pool, reservations[0]!)).toEqual(reservations[0])
    const stored = (await pool.query<{ state: string; reserved_bytes: string }>(
      "select state,reserved_bytes from source_storage_reservations where scope_id=$1 and owner_id=any($2::text[])",
      [scopeId, reservations.map(reservation => reservation.ownerId)])).rows
    expect(stored).toHaveLength(count)
    expect(stored.every(row => row.state === 'owned' && Number(row.reserved_bytes) === reservedBytes)).toBe(true)
    const history = (await pool.query<{ record: typeof saved }>(
      'select record from job_runtime_profile_versions where profile_id=$1 and revision=1', [profile.id])).rows[0]!.record
    expect(history.measurement).toBeNull()
    expect(history.status).toBe('unqualified')
  }, 60_000)
