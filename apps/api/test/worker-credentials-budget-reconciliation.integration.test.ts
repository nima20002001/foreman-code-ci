import { beforeEach, expect, it } from 'vitest'
import pg from 'pg'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { Wave25WorkerCredentialService } from '../src/modules/interactions/wave25/credentials.js'
import { workerCredentialBudgetFixture } from './helpers/workerCredentialBudgetFixture.js'

const fixture = workerCredentialBudgetFixture()
let schema: typeof fixture.schema
let pool: typeof fixture.pool
let execution: typeof fixture.execution
let access: typeof fixture.access
let credentials: typeof fixture.credentials
const connectionString = process.env.TEST_DATABASE_URL!

beforeEach(() => {
  ({ schema, pool, execution, access, credentials } = fixture)
})

for (const lockedRow of ['run', 'execution', 'principal', 'binding'] as const) {
  it(`defers credential reconciliation while the ${lockedRow} is busy, then revokes on the next sweep`, async () => {
    const issued = await credentials.issueForExecution(execution.id)
    await pool.query('update runs set worker_credentials_closed_at=now() where id=$1', [execution.runId])
    const sweepPool = new pg.Pool({ connectionString,
      options: `-c search_path=${schema} -c statement_timeout=500` })
    const reconciler = new Wave25WorkerCredentialService(sweepPool, new PostgresAccessService(sweepPool))
    const blocker = await pool.connect()
    const revoked = async () => (await pool.query(`select p.revoked_at is not null as principal_revoked,
      b.revoked_at is not null as binding_revoked from management_principals p
      join worker_credential_bindings b on b.principal_id=p.id where p.id=$1`, [issued.principalId])).rows[0]
    try {
      await blocker.query('begin')
      if (lockedRow === 'run') {
        await blocker.query('select id from runs where id=$1 for update', [execution.runId])
      } else if (lockedRow === 'execution') {
        await blocker.query('select id from harness_executions where id=$1 for update', [execution.id])
      } else if (lockedRow === 'principal') {
        await blocker.query('select id from management_principals where id=$1 for update', [issued.principalId])
      } else {
        await blocker.query('select principal_id from worker_credential_bindings where principal_id=$1 for update',
          [issued.principalId])
      }
      await expect(reconciler.reconcileTerminalCredentials()).resolves.toBeUndefined()
      expect(await revoked()).toEqual({ principal_revoked: false, binding_revoked: false })
      // Deferral never makes a stopped execution's token usable.
      await expect(access.authenticate(issued.environment.variables.GRAPHQL_MCP_TOKEN!, 'worker'))
        .rejects.toMatchObject({ code: 'AUTH_REVOKED' })
      await blocker.query('rollback')
      await reconciler.reconcileTerminalCredentials()
      expect(await revoked()).toEqual({ principal_revoked: true, binding_revoked: true })
    } finally {
      await blocker.query('rollback')
      blocker.release()
      await sweepPool.end()
    }
  })
}
