/** Test-only child process. It executes real SCH-04/common Start code and can be
 * killed at two explicit transaction boundaries. Never imported by product code. */
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import pg from 'pg'
import { WorkflowScheduleSchema, type WorkflowSchedule } from '@foreman-code/contracts/schedules'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { repeatStartPublication } from '../../src/modules/run-graph/repeatStartPublication.js'
import { admitRepeatRun } from '../../src/modules/runs/repeatStartAdmission.js'
import { PostgresScheduleDispatcher } from '../../src/modules/schedules/postgresDispatcher.js'
import { LOCAL_RUNNER_ID, WorkspaceLocationService } from '../../src/modules/workspaces/location.js'
import { assertTestDatabase, ownedTestDatabaseUrl, ownedTestPath } from '../../../../scripts/test-resources.mjs'

export interface Sch11ChildInput {
  schema: string
  directory: string
  runtimeRoot: string
  projectRoot: string
  now: string
  observed: WorkflowSchedule
  mode: 'prepared' | 'mid-claim' | 'lost-start-ack'
}
export interface Sch11ChildMessage {
  kind: 'prepared' | 'mid-claim' | 'committed' | 'done' | 'error'
  runId?: string
  authorityId?: string
  pid?: number
  message?: string
}
function send(message: Sch11ChildMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    const sender = process.send
    if (!sender) { reject(new Error('SCH-11 child requires IPC')); return }
    sender.call(process, message, (error) => { if (error) reject(error); else resolve() })
  })
}
function releaseBarrier(): Promise<void> {
  return new Promise((resolve) => {
    const handler = (message: unknown) => {
      if (message === 'release') { process.off('message', handler); resolve() }
    }
    process.on('message', handler)
  })
}
async function run(input: Sch11ChildInput) {
  const url = ownedTestDatabaseUrl()
  const parsed = new URL(url)
  const fixtureDatabase = /^\/graphql_fixture_[a-f0-9]{32}$/.test(parsed.pathname)
  const isolatedSchema = /^wave25_a3_[a-f0-9]{32}$/.test(input.schema)
  if (!isolatedSchema && !(input.schema === 'public' && fixtureDatabase)) {
    throw new Error('Child requires an isolated fixture database or schema')
  }
  if (!['prepared', 'mid-claim', 'lost-start-ack'].includes(input.mode)) throw new Error('Unknown test boundary')
  const observed = WorkflowScheduleSchema.parse(input.observed)
  const directory = await realpath(ownedTestPath(input.directory))
  for (const root of [input.projectRoot, input.runtimeRoot]) {
    const path = relative(directory, await realpath(root))
    if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('Test roots escaped the fixture directory')
  }
  const pool = new pg.Pool({ connectionString: url, max: 4,
    application_name: `sch11_child_${process.pid}`,
    options: `-c search_path=${input.schema} -c statement_timeout=15000 -c lock_timeout=10000` })
  const locations = new WorkspaceLocationService(pool, new PostgresCommandCoordinator(pool),
    input.runtimeRoot, LOCAL_RUNNER_ID)
  try {
    await assertTestDatabase(pool, {
      directory: process.env.FOREMAN_CODE_TEST_ROOT!,
      token: process.env.FOREMAN_CODE_TEST_OWNER!,
      name: parsed.pathname.slice(1),
      databaseUrl: url,
    })
    const dispatcher = new PostgresScheduleDispatcher(pool, async (principal, request, guard) => {
      if (input.mode === 'prepared') {
        const released = releaseBarrier() // arm before notifying the parent
        await send({ kind: 'prepared' }); await released
      }
      const outcome = await admitRepeatRun(pool, locations, principal, 'schedule', request, repeatStartPublication, {
        schedule: input.mode !== 'mid-claim' ? guard : {
          ...guard, afterAcceptance: async (sql, value) => {
            await guard.afterAcceptance(sql, value)
            const pid = (await sql.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
            const released = releaseBarrier()
            // Run, capture, authority, receipt, fact and cursor are now staged,
            // but none is committed. Parent kills THIS dispatcher, not PostgreSQL.
            await send({ kind: 'mid-claim', pid, runId: value.id, authorityId: value.authorizationPrincipalId })
            await released
          },
        },
      })
      if (input.mode === 'lost-start-ack') {
        const released = releaseBarrier()
        // Fault-injection signal only, not an application acknowledgement. Kill
        // before returning from ScheduledStart; the common transaction committed.
        await send({ kind: 'committed', runId: outcome.value.id })
        await released
      }
    }, () => new Date(input.now))
    await dispatcher.dispatch(observed)
    await send({ kind: 'done' })
  } finally { await pool.end() }
}

if (process.send) {
  process.once('message', (input: Sch11ChildInput) => {
    void run(input).catch(async (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
      await send({ kind: 'error', message: error instanceof Error ? error.message : String(error) }).catch(() => {
        // ignore: The parent may have disconnected; stderr already reports the original failure.
      })
      process.exitCode = 1
    }).finally(() => { if (process.connected) process.disconnect?.() })
  })
}
