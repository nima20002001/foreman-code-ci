import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { CurrentWorkflowReadResultSchema } from '@foreman-code/contracts/wave25'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { BuildComputerStatusSchema } from '@foreman-code/contracts/build-computers'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { applyApplicationMigrations, migrations } from '../src/infrastructure/migrations.js'
import { agentCiActivityMigration } from '../src/infrastructure/agentCiActivityMigration.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCiPreparationRepository } from '../src/modules/jobs/ciPreparationRepository.js'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { BuildComputerSettings, readBuildComputerPreference } from '../src/modules/settings/buildComputers.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { ciMigrationFixture } from './helpers/ciMigrationFixture.js'
import { builder, mainId } from './helpers/ciPreparationFixture.js'
import { graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'

const ledger = async (database: Awaited<ReturnType<typeof currentDatabase>>) =>
  (await database.pool.query('select version,applied_at from application_migrations order by version')).rows

async function migrateConcurrently(database: Awaited<ReturnType<typeof currentDatabase>>) {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL!,
    // A fresh migration batch can outlast ordinary fixture query deadlines.
    options: `-c search_path=${database.schema} -c statement_timeout=90000 -c lock_timeout=60000` })
  try {
    await Promise.all([applyApplicationMigrations(pool), applyApplicationMigrations(pool)])
  } finally {
    await pool.end()
  }
}

function createPreparation(database: Awaited<ReturnType<typeof currentDatabase>>,
  record: ReturnType<Awaited<ReturnType<typeof ciMigrationFixture>>['record']>) {
  const repository = new PostgresCiPreparationRepository(database.pool)
  return withExclusiveGraphConnection(database.pool,
    connection => connection.transaction(sql => repository.create(sql, record)))
}

describe.skipIf(!postgresEnabled)('CI migration integrity through fresh and historical databases', () => {
  it('authors a workflow without location stamps while retaining the historical CI schema under test', async () => {
    const database = await currentDatabase({ beforeMigration: 285905 })
    try {
      const seeded = await ciMigrationFixture(database)
      try {
        const workflow = seeded.workflow
        const reader = await workflow.credential([{ actions: ['workflows:read', 'graph:read'],
          scope: { workspaceIds: [seeded.workspaceId] } }])
        const read = async () => {
          const reply = await graphRpc(workflow.app, reader.token, 'tools/call', {
            name: 'workflow_saved_get_v3', arguments: {
              workspaceId: seeded.workspaceId, workflowId: workflow.scope.workflowId,
            },
          })
          expect(reply.result?.isError).not.toBe(true)
          return CurrentWorkflowReadResultSchema.parse(graphRpcValue(reply.result))
        }
        expect((await read()).version).toEqual(workflow.version)
        const denied = await graphRpc(workflow.app, reader.token, 'tools/call', {
          name: 'workflow_save_v3', arguments: {
            workspaceId: seeded.workspaceId, workflowId: workflow.scope.workflowId,
            commandId: randomUUID(), executionSemanticsVersion: 3,
            expectedRevision: workflow.accepted.snapshot.workflow.revision,
            expectedWorkflowVersionId: workflow.version.id,
            expectedAgentConfigurationVersionIds: workflow.version.agentConfigurationVersionIds,
            graph: workflow.version.definition,
          },
        })
        expect(denied.result?.isError).toBe(true)
        expect(graphRpcValue(denied.result)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
        await expect(database.pool.query('select * from ci_runtime_preparations'))
          .rejects.toMatchObject({ code: '42P01' })
        const before = await seeded.facts()
        await applyApplicationMigrations(database.pool)
        expect(await seeded.facts()).toEqual(before)
        expect((await read()).version).toEqual(workflow.version)
      } finally {
        await seeded.workflow.app.close()
      }
    } finally {
      await database.close()
    }
  }, 120_000)

  it('serializes fresh migration callers and makes repeated startup a data-preserving operation', async () => {
    const database = await currentDatabase({ beforeMigration: migrations[0].version })
    try {
      await migrateConcurrently(database)
      expect((await ledger(database)).map(row => row.version))
        .toEqual(migrations.map(migration => migration.version).sort((left, right) => left - right))
      const seeded = await ciMigrationFixture(database)
      try {
        const original = seeded.record(seeded.main)
        await createPreparation(database, original)
        const before = await seeded.facts()
        const applied = await ledger(database)
        await migrateConcurrently(database)
        expect(await ledger(database)).toEqual(applied)
        expect(await seeded.facts()).toEqual(before)
        expect(await new PostgresCiPreparationRepository(database.pool).get(original.id)).toEqual(original)
      } finally {
        await seeded.workflow.app.close()
      }
    } finally {
      await database.close()
    }
  }, 120_000)

  it.each([
    { name: 'before preparation storage', version: 285905, roles: true, preparations: false, release: false },
    { name: 'before priority conversion', version: 2026100860, roles: true, preparations: true, release: false },
    { name: 'before Main preparation identities', version: 2026100902, roles: false, preparations: true, release: false },
    { name: 'released CI schema', version: 286015, roles: false, preparations: true, release: true },
  ])('upgrades $name without changing saved workflow, Run, or preparation facts', async scenario => {
    const database = await currentDatabase({ beforeMigration: scenario.version })
    try {
      if (scenario.release) {
        // The released schema includes activity backfill but predates source-capacity waiting.
        await withTransaction(database.pool, async client => {
          await client.query(agentCiActivityMigration.sql)
          await client.query('insert into application_migrations(version) values($1)', [agentCiActivityMigration.version])
        })
      }
      const seeded = await ciMigrationFixture(database)
      try {
        await seeded.preferences(scenario.roles)
        const original = seeded.record()
        if (scenario.preparations) await createPreparation(database, original)
        const before = await seeded.facts()
        await applyApplicationMigrations(database.pool)
        expect(await seeded.facts()).toEqual(before)
        const repository = new PostgresCiPreparationRepository(database.pool)
        if (scenario.preparations) expect(await repository.get(original.id)).toEqual(original)
        else await createPreparation(database, original)
        const onMain = seeded.record(seeded.main)
        await createPreparation(database, onMain)
        expect(await repository.get(onMain.id)).toEqual(onMain)
        expect((await repository.pending()).map(value => value.id).sort())
          .toEqual([original.id, onMain.id].sort())
        expect(await readBuildComputerPreference(database.pool, seeded.target(seeded.main)))
          .toMatchObject({ buildPriority: scenario.roles ? 100 : 10,
            revision: scenario.roles ? 8 : 7, buildAllowancePercent: 60, buildEnabled: true })
        expect(await readBuildComputerPreference(database.pool, seeded.target()))
          .toMatchObject({ buildPriority: scenario.roles ? 99 : 90,
            revision: scenario.roles ? 8 : 7, buildAllowancePercent: 60, buildEnabled: true })
        const applied = await ledger(database)
        await applyApplicationMigrations(database.pool)
        expect(await ledger(database)).toEqual(applied)
        expect(await seeded.facts()).toEqual(before)
        expect(await repository.get(original.id)).toEqual(original)
        expect(await repository.get(onMain.id)).toEqual(onMain)
      } finally {
        await seeded.workflow.app.close()
      }
    } finally {
      await database.close()
    }
  }, 120_000)

  it.each(['SQL', 'ledger'] as const)(
    'rolls back schema and ledger together after late %s failure, then retries the same upgrade', async fault => {
      const database = await currentDatabase({ beforeMigration: 2026100902 })
      try {
        const seeded = await ciMigrationFixture(database)
        try {
          const original = seeded.record()
          await createPreparation(database, original)
          const before = await seeded.facts()
          const applied = await ledger(database)
          if (fault === 'SQL') {
            await database.pool.query('create table ci_enrollment_computers(fixture_marker boolean)')
          } else {
            await database.pool.query(`create function reject_fixture_migration() returns trigger language plpgsql as $$
              begin
                if NEW.version=2026100905 then raise exception 'Injected ledger failure'; end if;
                return NEW;
              end $$;
              create trigger reject_fixture_migration before insert on application_migrations
                for each row execute function reject_fixture_migration()`)
          }
          await expect(applyApplicationMigrations(database.pool))
            .rejects.toMatchObject(fault === 'SQL' ? { cause: { code: '42P07' } } : { code: 'P0001' })
          expect(await ledger(database)).toEqual(applied)
          expect(await seeded.facts()).toEqual(before)
          expect((await database.pool.query(`select to_regclass('ci_enrollment_workspaces') as table_name`)).rows)
            .toEqual([{ table_name: null }])
          await expect(createPreparation(database, seeded.record(seeded.main))).rejects.toMatchObject({ code: '23503' })
          expect(await new PostgresCiPreparationRepository(database.pool).get(original.id)).toEqual(original)
          if (fault === 'SQL') await database.pool.query('drop table ci_enrollment_computers')
          else await database.pool.query('drop trigger reject_fixture_migration on application_migrations')
          await applyApplicationMigrations(database.pool)
          expect((await ledger(database)).map(row => row.version))
            .toEqual(migrations.map(migration => migration.version).sort((left, right) => left - right))
          const onMain = seeded.record(seeded.main)
          await createPreparation(database, onMain)
          expect(await new PostgresCiPreparationRepository(database.pool).get(onMain.id)).toEqual(onMain)
          expect(await seeded.facts()).toEqual(before)
        } finally {
          await seeded.workflow.app.close()
        }
      } finally {
        await database.close()
      }
    }, 120_000)

  it('retains workspace/principal references, command uniqueness, and active ownership in the final schema', async () => {
    const database = await currentDatabase()
    try {
      const seeded = await ciMigrationFixture(database)
      try {
        const original = seeded.record(seeded.main)
        await createPreparation(database, original)
        await expect(createPreparation(database, seeded.record(seeded.main)))
          .rejects.toMatchObject({ code: 'CI_RUNTIME_BUSY' })
        const missingWorkspace = seeded.record()
        await expect(createPreparation(database, { ...missingWorkspace,
          input: { ...missingWorkspace.input, workspaceId: 'missing-workspace' } })).rejects.toMatchObject({
          code: '23503', constraint: 'ci_runtime_preparations_workspace_id_fkey',
        })
        const missingPrincipal = seeded.record()
        await expect(createPreparation(database, { ...missingPrincipal,
          principal: { ...missingPrincipal.principal, id: 'missing-principal' } })).rejects.toMatchObject({
          code: '23503', constraint: 'ci_runtime_preparations_principal_id_fkey',
        })
        const repository = new PostgresCiPreparationRepository(database.pool)
        const finished = { ...original, status: { ...original.status, state: 'failed' as const, message: 'Finished' } }
        await withExclusiveGraphConnection(database.pool,
          connection => connection.transaction(sql => repository.save(sql, finished)))
        await expect(createPreparation(database, seeded.record(seeded.main, original.input.commandId)))
          .rejects.toMatchObject({ code: '23505' })
        const replacement = seeded.record(seeded.main)
        await createPreparation(database, replacement)
        const device = seeded.record()
        await createPreparation(database, device)
        await database.pool.query('delete from device_registrations where id=$1', [builder])
        expect(await repository.get(device.id)).toEqual(device)
        expect(await repository.latestForDevice(mainId)).toEqual(replacement)
        expect(await repository.get(original.id)).toEqual(finished)
        expect((await repository.pending()).map(value => value.id).sort()).toEqual([replacement.id, device.id].sort())
      } finally {
        await seeded.workflow.app.close()
      }
    } finally {
      await database.close()
    }
  }, 120_000)

  it('uses migrated revisions for stale-write conflicts and preserves command retries', async () => {
    const database = await currentDatabase({ beforeMigration: 2026100860 })
    try {
      const seeded = await ciMigrationFixture(database)
      try {
        await seeded.preferences(true)
        await applyApplicationMigrations(database.pool)
        const settings = new BuildComputerSettings(database.pool, seeded.workflow.commands, async () => ({
          state: 'offline', reasons: ['Fixture computer is offline'], remoteExecutionEnabled: false,
        }))
        const access = new PostgresAccessService(database.pool)
        const writer = await access.issue({ name: 'Build settings author',
          audience: 'operator', expiresAt: new Date(Date.now() + 3_600_000),
          grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] })
        const reader = await access.issue({ name: 'Build settings reader', audience: 'operator',
          expiresAt: new Date(Date.now() + 3_600_000), grants: [{ actions: ['settings:read'], scope: {} }] })
        const app = buildApp({ readiness: { database: { ping: async () => undefined },
          checkpoints: { ping: async () => undefined } }, operator: { access,
          services: { commands: seeded.workflow.commands, buildComputers: settings } as unknown as OperatorServices } })
        const input = { target: seeded.target(), expectedRevision: 7, buildEnabled: true,
          buildPriority: 75, commandId: randomUUID() }
        const call = async (name: string, arguments_: unknown, token = writer.token) =>
          (await graphRpc(app, token, 'tools/call', { name, arguments: arguments_ })).result!
        try {
          expect((await call('build_computer_update', input, reader.token)).isError).toBe(true)
          const stale = await call('build_computer_update', input)
          expect(stale.isError).toBe(true)
          expect(graphRpcValue(stale)).toMatchObject({ error: { code: 'REVISION_CONFLICT' } })
          const accepted = { ...input, expectedRevision: 8, commandId: randomUUID() }
          const response = await call('build_computer_update', accepted)
          expect(response.isError).not.toBe(true)
          const result = BuildComputerStatusSchema.parse(decodeMcpToolResult(response))
          expect(result.preference).toMatchObject({ revision: 9, buildPriority: 75, buildAllowancePercent: 60 })
          expect(BuildComputerStatusSchema.parse(decodeMcpToolResult((await call('build_computer_update', accepted)))))
            .toEqual(result)
          expect(BuildComputerStatusSchema.parse(decodeMcpToolResult((await call('build_computer_get', {
            target: seeded.target(),
          }, reader.token))))).toEqual(result)
          expect((await settings.read(writer.principal, { target: seeded.target() })).preference)
            .toEqual(result.preference)
        } finally {
          await app.close()
        }
      } finally {
        await seeded.workflow.app.close()
      }
    } finally {
      await database.close()
    }
  }, 120_000)
})
