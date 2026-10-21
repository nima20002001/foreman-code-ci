import { beforeEach, expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { Wave25WorkerCredentialService } from '../src/modules/interactions/wave25/credentials.js'
import { lockActiveWorkerPrincipal } from '../src/modules/access/workerLifecycle.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { workerCredentialBudgetFixture } from './helpers/workerCredentialBudgetFixture.js'
import { deferred } from './helpers/deferred.js'
import { readUntil } from './helpers/observableCondition.js'

const f = workerCredentialBudgetFixture()

beforeEach(async () => {
  const starting = HarnessExecutionSchema.parse({ ...f.execution, state: 'starting' })
  await f.pool.query('update harness_executions set record=$2::jsonb where id=$1',
    [starting.id, JSON.stringify(starting)])
})

async function worker() {
  const credentials = new Wave25WorkerCredentialService(f.pool, f.access, 60_000)
  const issued = await credentials.issueForExecution(f.execution.id)
  const principal = await f.access.authenticate(issued.environment.variables.GRAPHQL_MCP_TOKEN!, 'worker')
  return { credentials, issued, principal }
}

it('validates the same live worker concurrently without an exclusive Run or execution lock', async () => {
  const w = await worker()
  await withTransaction(f.pool, async first => {
    expect(await lockActiveWorkerPrincipal(first, w.principal)).toEqual(w.principal)
    await withTransaction(f.pool, async second => {
      await second.query("set local lock_timeout='500ms'")
      expect(await lockActiveWorkerPrincipal(second, w.principal)).toEqual(w.principal)
    })
  })
  await w.credentials.revoke(w.issued)
  await expect(withTransaction(f.pool, sql => lockActiveWorkerPrincipal(sql, w.principal)))
    .rejects.toMatchObject({ code: 'AUTH_REVOKED' })
})

it('holds the lifecycle fence until validation finishes and denies the worker after closure', async () => {
  const w = await worker()
  const release = deferred()
  const locked = deferred()
  const validation = withTransaction(f.pool, async sql => {
    await lockActiveWorkerPrincipal(sql, w.principal)
    locked.resolve()
    await release.promise
  })
  const validationResult = Promise.allSettled([validation])
  let closure: Promise<unknown> | undefined
  let closureResult: Promise<unknown> | undefined
  try {
    await locked.promise
    closure = f.pool.query('update runs set worker_credentials_closed_at=clock_timestamp() where id=$1',
      [f.execution.runId])
    closureResult = Promise.allSettled([closure])
    await readUntil(async () => (await f.pool.query<{ waiting: boolean }>(
      'select exists(select 1 from pg_stat_activity where cardinality(pg_blocking_pids(pid))>0 and datname=current_database()) as waiting',
    )).rows[0]!.waiting, value => value, { timeoutMs: 1500, description: 'worker closure waiting for validation' })
    release.resolve()
    await validation
    await closure
    await expect(withTransaction(f.pool, sql => lockActiveWorkerPrincipal(sql, w.principal)))
      .rejects.toMatchObject({ code: 'AUTH_REVOKED' })
  } finally {
    release.resolve()
    await validationResult
    await closureResult
  }
})
