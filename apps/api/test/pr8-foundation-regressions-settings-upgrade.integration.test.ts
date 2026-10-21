import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { describe, expect, it } from 'vitest'

async function database<T>(perform: (pool: pg.Pool) => Promise<T>, beforeMigration?: (pool: pg.Pool) => Promise<void>): Promise<T> {
  if (!beforeMigration) {
    const db = await agent3Database()
    try {
      return await perform(db.pool)
    } finally {
      await db.close()
    }
  }
  const connectionString = process.env.TEST_DATABASE_URL!
  const schema = `foundation_upgrade_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString })
  await createFixtureSchema(admin, schema)
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  try {
    await beforeMigration(pool)
    await applyApplicationMigrations(pool)
    return await perform(pool)
  } finally {
    await pool.end()
    await dropFixtureSchema(admin, schema)
    await admin.end()
  }
}

describe.skipIf(!postgresEnabled)('PostgreSQL settings atomicity and upgrades', () => {
  it('copies stored Operator defaults, hashes accepted normalized data and rolls writes back with failed receipts', async () => database(async (pool) => {
    const defaults = new PostgresFoundationSettingsRepository(pool)
    const templates = structuredClone(DEFAULT_AGENT_DEFAULTS)
    templates.operator.harness = { ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'operator-first' }
    await defaults.updateAgentDefaults(templates, 0)
    const operators = new PostgresOperatorRepository(pool)
    const first = await operators.ensure()
    expect(first.configuration.harness.model).toBe('operator-first')
    templates.operator.harness.model = 'operator-later'
    await defaults.updateAgentDefaults(templates, 1)
    expect((await operators.ensure()).configuration).toEqual(first.configuration)
    const raw = { ...DEFAULT_HARNESS_DEFAULTS.codex, model: '  normalized-model  ' }
    const accepted = await operators.update(raw, first.configuration.id)
    const equivalent = Object.fromEntries(Object.entries({ ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'normalized-model' }).reverse()) as typeof raw
    const normalized = await operators.update(equivalent, accepted.configuration.id)
    expect(normalized.configuration.contentHash).toBe(accepted.configuration.contentHash)
    expect(normalized.configuration.harness.model).toBe('normalized-model')
    const access = new PostgresAccessService(pool)
    const { principal } = await access.issue({ name:'owner', audience:'operator', grants:[], expiresAt:new Date(Date.now()+60_000) })
    const commands = new PostgresCommandCoordinator(pool)
    await pool.query(`create function reject_receipt() returns trigger language plpgsql as $$
      begin raise exception 'injected receipt failure'; end $$;
      create trigger fail_receipt before insert on management_command_receipts for each row execute function reject_receipt()`)
    const command = {
      principal, source:'http' as const, operation:'foundation.update', commandId:randomUUID(), targetKey:'settings', payload:{},
      perform: async (client: pg.PoolClient) => ({
        defaults:await defaults.updateWorkflowDefaults({ approvalHandler:'user' },0,client),
        operator:await operators.update({ ...DEFAULT_HARNESS_DEFAULTS.codex, model:'receipt-model' },normalized.configuration.id,client),
      }),
    }
    await expect(commands.execute(command)).rejects.toThrow('injected receipt failure')
    expect((await defaults.getWorkflowDefaults()).revision).toBe(0)
    expect((await operators.ensure()).configuration.id).toBe(normalized.configuration.id)
    expect((await pool.query('select * from management_command_receipts')).rowCount).toBe(0)
    await pool.query('drop trigger fail_receipt on management_command_receipts')
    const saved = await commands.execute(command)
    expect(saved.replayed).toBe(false)
    const replayed = await commands.execute(command)
    expect(replayed).toEqual({ ...saved,replayed:true })
    expect((await defaults.getWorkflowDefaults()).revision).toBe(1)
  }), 30_000)

  it('returns a controlled authentication error for a genuine pre-migration worker row', async () => {
    const token = 'old-worker-token'
    await database(async (pool) => {
      const access = new PostgresAccessService(pool)
      await expect(access.authenticate(token,'worker')).rejects.toMatchObject({ code:'AUTH_WORKER_SUBJECT_REQUIRED',status:401 })
      expect((await pool.query("select agent_id from management_principals where id='old-worker'")).rows[0].agent_id).toBeNull()
    }, async (pool) => {
      await pool.query(`create table management_principals (
        id text primary key,name text not null,audience text not null,token_hash text not null unique,
        grants jsonb not null,expires_at timestamptz not null,revoked_at timestamptz,created_at timestamptz not null default now())`)
      await pool.query(`insert into management_principals(id,name,audience,token_hash,grants,expires_at)
        values('old-worker','Old worker','worker',$1,'[]'::jsonb,now()+interval '1 hour')`,[createHash('sha256').update(token).digest('hex')])
    })
  }, 30_000)
})
