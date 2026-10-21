import { randomUUID } from 'node:crypto'
import { CiPreparationRecordSchema } from '../../src/modules/jobs/ciPreparationRepository.js'
import { buildComputerKey, buildComputerTarget } from '../../src/modules/settings/buildComputers.js'
import { workflowAuthoringMigration } from '../../src/infrastructure/workflowAuthoringMigration.js'
import { withTransaction } from '../../src/infrastructure/transaction.js'
import { graphFixture } from '../eng04-graph-composition-fixture.js'
import { currentDatabase } from './eng04CurrentDatabase.js'
import { commit, builder, mainId, preparationProfile, qualifiedPreparationProfile } from './ciPreparationFixture.js'

export async function ciMigrationFixture(database: Awaited<ReturnType<typeof currentDatabase>>) {
  // Current authoring is independent of the historical CI schema exercised by this fixture.
  await withTransaction(database.pool, async sql => {
    const applied = await sql.query('select 1 from application_migrations where version=$1',
      [workflowAuthoringMigration.version])
    if (applied.rowCount) return
    await sql.query(workflowAuthoringMigration.sql)
    await sql.query('insert into application_migrations(version) values($1)', [workflowAuthoringMigration.version])
  })
  const workflow = await graphFixture(database, { form: 'sequential' })
  try {
    await database.pool.query('update application_installation set id=$1 where singleton=true', [mainId])
    await database.pool.query(`insert into device_registrations
      (id,main_id,worker_installation_id,public_key,record) values($1,$2,$1,'fixture-key',$3::jsonb)`,
    [builder, mainId, JSON.stringify({ mainId, deviceId: builder, workerInstallationId: builder,
      publicKeyFingerprint: 'a'.repeat(64), keyRevision: 1, authorizationRevision: 1,
      status: 'paired', scopes: ['connect', 'heartbeat'] })])
    const workspaceId = workflow.scope.workspaceId
    const makeProfile = (deviceId: string | null) => {
      const profile = preparationProfile(deviceId ? 'device-profile' : 'main-profile',
        'Migration runtime', deviceId, randomUUID(), ['install', 'unit'])
      profile.workspaceId = workspaceId
      profile.root.binding.workspaceId = workspaceId
      return qualifiedPreparationProfile(profile)
    }
    const device = makeProfile(builder)
    const main = makeProfile(null)
    const record = (profile = device, commandId: string = randomUUID()) => {
      const now = new Date().toISOString()
      return CiPreparationRecordSchema.parse({ id: randomUUID(),
        input: { workspaceId, profileId: profile.id, commandId, commit },
        principal: workflow.writer.principal, source: 'mcp', profile,
        status: { profileId: profile.id, deviceId: profile.root.binding.deviceId ?? mainId,
          state: 'approving', commit, stage: null, message: null, profiles: [], startedAt: now, updatedAt: now } })
    }
    const target = (profile = device) => buildComputerTarget({ hostRef: profile.root.selection.hostRef,
      registration: profile.root.registration, mainInstallationId: mainId })
    const preferences = async (roles: boolean) => {
      for (const [profile, priority, role] of [[main, 10, 'primary'], [device, 90, 'backup']] as const) {
        const computer = target(profile)
        const columns = roles ? ',build_role' : ''
        const values = roles ? ',$6' : ''
        const parameters = [buildComputerKey(computer), JSON.stringify(computer), priority, 60,
          workflow.writer.principal.id]
        if (roles) parameters.push(role)
        await database.pool.query(`insert into build_computer_preferences
          (host_key,target,revision,build_enabled,build_priority,build_allowance_percent,updated_by${columns})
          values($1,$2::jsonb,7,true,$3,$4,$5${values})`, parameters)
      }
    }
    const facts = async () => ({
      versions: (await database.pool.query('select * from workflow_versions order by id')).rows,
      runs: (await database.pool.query('select * from runs order by id')).rows,
      configurations: (await database.pool.query('select * from agent_configuration_versions order by id')).rows,
      installation: (await database.pool.query('select * from application_installation')).rows,
    })
    return { workflow, workspaceId, device, main, record, target, preferences, facts }
  } catch (error) {
    await workflow.app.close()
    throw error
  }
}
