import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { CiPreparationRecordSchema, PostgresCiPreparationRepository } from '../src/modules/jobs/ciPreparationRepository.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { verificationCapacityFixture } from './helpers/verificationCapacityFixture.js'

describe.skipIf(!postgresEnabled)('CI runtime preparations on Main', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  beforeAll(async () => { database = await agent3Database() }, 60000)
  afterAll(async () => { await database?.close() })

  it('persists Main under its installation id, one active preparation at a time', async () => {
    const mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const workspaceId = randomUUID()
    await database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
      [workspaceId, JSON.stringify({ id: workspaceId, name: 'Main CI' })])
    const principal = (await new PostgresAccessService(database.pool).issue({ name: 'Main CI owner', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ actions: ['job_definitions:read'], scope: { workspaceIds: [workspaceId] } }] })).principal
    const profile = { ...verificationCapacityFixture('main'), workspaceId }
    const record = (commandId: string) => CiPreparationRecordSchema.parse({ id: randomUUID(),
      input: { workspaceId, profileId: profile.id, commandId }, principal, source: 'mcp', profile,
      status: { profileId: profile.id, deviceId: mainId, state: 'approving', commit: null, stage: null, message: null,
        profiles: [], startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } })
    const repository = new PostgresCiPreparationRepository(database.pool)
    const first = record('main-first')
    await repository.create(database.pool, first)
    await expect(repository.create(database.pool, record('main-second'))).rejects.toMatchObject({ code: 'CI_RUNTIME_BUSY' })
    expect(await repository.latest(workspaceId, mainId)).toEqual(first)
    expect((await repository.pending()).map(value => value.id)).toContain(first.id)
  })
})
