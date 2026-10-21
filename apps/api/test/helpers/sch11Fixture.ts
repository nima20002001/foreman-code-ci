import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import pg from 'pg'
import type { ManagementGrant } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import type { ScheduleConfiguration, ScheduleOccurrence } from '@foreman-code/contracts/schedules'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { repeatStartPublication } from '../../src/modules/run-graph/repeatStartPublication.js'
import { admitRepeatRun } from '../../src/modules/runs/repeatStartAdmission.js'
import { PostgresScheduleDispatcher, type ScheduledStart } from '../../src/modules/schedules/postgresDispatcher.js'
import { WorkflowScheduleService } from '../../src/modules/schedules/service.js'
import { WorkflowManagementService } from '../../src/modules/workflows/management.js'
import { LOCAL_RUNNER_ID, WorkspaceLocationService } from '../../src/modules/workspaces/location.js'
import { agent3Database, seedAgent3 } from './wave25Agent3.js'
import { sch11Once } from './sch11ClockCases.js'

export type Sch11Database = Awaited<ReturnType<typeof agent3Database>>
export const sch11Actions: ManagementGrant['actions'] = [
  'workflows:create', 'workflows:read', 'workflows:update', 'graph:read', 'graph:edit', 'graph:save',
  'agents:read', 'workspace_locations:read', 'skills:read', 'harnesses:update',
  'runs:start', 'runs:read', 'capabilities:read',
]

/** Uses the existing loopback/test-name guard, registered migrations and real
 * current-workflow authoring. No direct Run inserts, fake canonical receipts,
 * provider processes, production DB fallback, auth bypass or migration shim. */
export async function sch11Fixture(database: Sch11Database, initialNow = '2030-01-07T09:00:00.000Z',
  initialFixture = makeCurrentWorkflowFixture(randomUUID())) {
  const projectRoot = join(database.directory, 'projects'), runtimeRoot = join(database.directory, 'runtime')
  const directory = join(projectRoot, randomUUID())
  await Promise.all([
    mkdir(directory, { recursive: true, mode: 0o700 }),
    mkdir(runtimeRoot, { recursive: true, mode: 0o700 }),
  ])
  const fixture = await seedAgent3(database.pool, directory, initialFixture, { run: false })
  const scope = { workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId }
  const identity = await stat(directory, { bigint: true })
  await database.pool.query('update workspaces set execution_location_identity=$2::jsonb where id=$1',
    [scope.workspaceId, JSON.stringify({ device: String(identity.dev), inode: String(identity.ino) })])
  const time = { now: initialNow }
  const clock = () => new Date(time.now)
  const access = new PostgresAccessService(database.pool)
  const commands = new PostgresCommandCoordinator(database.pool)
  const workflows = new WorkflowManagementService(database.pool, commands)
  const service = new WorkflowScheduleService(database.pool, commands, clock)
  const locations = new WorkspaceLocationService(database.pool, commands, runtimeRoot, LOCAL_RUNNER_ID)
  const issue = (actions: ManagementGrant['actions'], workspaceId = scope.workspaceId) => access.issue({
    name: 'SCH-11 synthetic human', audience: 'operator', expiresAt: new Date(Date.now() + 3_600_000),
    grants: [{ actions, scope: { workspaceIds: [workspaceId] } }],
  })
  const writer = await issue(sch11Actions)
  const reader = await issue(['workflows:read', 'capabilities:read'])
  const command = (expectedRevision = 1) => ({ ...scope, commandId: randomUUID(), expectedRevision })
  const startUsing = (pool = database.pool): ScheduledStart => async (principal, input, schedule) => {
    await admitRepeatRun(pool, locations, principal, 'schedule', input, repeatStartPublication, { schedule })
  }
  const dispatcher = (start = startUsing(), pool = database.pool) => new PostgresScheduleDispatcher(pool, start, clock)
  const save = async (schedule: ScheduleConfiguration = sch11Once, expectedRevision = 0) =>
    (await service.save(writer.principal, 'http', { ...command(expectedRevision), schedule })).value
  const current = async () => (await service.get(reader.principal, scope)).schedule
  const history = async () => {
    const facts: ScheduleOccurrence[] = []
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const page = await service.recentOccurrences(reader.principal, { ...scope, limit: 100, ...(cursor ? { cursor } : {}) })
      facts.push(...page.items)
      cursor = page.pageInfo.nextCursor ?? undefined
      if (cursor && seen.has(cursor)) throw new Error('Occurrence history repeated a cursor')
      if (cursor) seen.add(cursor)
      if (seen.size > 1_000) throw new Error('Unexpectedly unbounded SCH-11 history')
    } while (cursor)
    return facts
  }
  const countRuns = async () => Number((await database.pool.query<{ count: string }>(
    'select count(*)::text as count from runs where workflow_id=$1', [scope.workflowId])).rows[0]!.count)
  return { database, fixture, scope, time, clock, projectRoot, runtimeRoot, access, commands, workflows,
    service, locations, writer, reader, issue, command, startUsing, dispatcher, save, current, history, countRuns }
}
export type Sch11Fixture = Awaited<ReturnType<typeof sch11Fixture>>

/** A second real session, with a recognizable name for lock-order assertions.
 * Called only after agent3Database validated TEST_DATABASE_URL. */
export function sch11Pool(database: Sch11Database) {
  const name = `sch11_${randomUUID().replaceAll('-', '')}`
  const pool = new pg.Pool({ connectionString: database.databaseUrl, max: 1,
    application_name: name,
    options: `-c search_path=${database.schema} -c statement_timeout=15000 -c lock_timeout=10000` })
  return { pool, name }
}

/** Wait for an observed lock dependency, never a sleep that merely assumes it.
 * The deadline is a failure watchdog, not a scheduler clock or race oracle. */
export async function sch11Blocked(pool: pg.Pool, waiterPid: number, holderPid: number) {
  const deadline = performance.now() + 5_000
  do {
    const row = (await pool.query<{ pids: number[] }>('select pg_blocking_pids($1) as pids', [waiterPid])).rows[0]!
    if (row.pids.includes(holderPid)) return
    await setImmediate()
  } while (performance.now() < deadline)
  throw new Error(`Expected test SQL session ${waiterPid} to wait on ${holderPid}`)
}

/** Domain state must remain byte-for-byte equivalent after denied commands.
 * Diagnostic failed/denied audits are deliberately allowed; successful audits,
 * command receipts, authorities, captures, Runs and occurrence cursors are not. */
export async function sch11DomainState(f: Sch11Fixture) {
  const query = async (sql: string, values: string[] = [f.scope.workflowId]) =>
    (await f.database.pool.query<{ value: unknown }>(sql, values)).rows.map((row) => row.value)
  return {
    slot: await query('select to_jsonb(t) as value from workflow_schedules t where workflow_id=$1'),
    scheduleAuthority: await query('select to_jsonb(t) as value from workflow_schedule_authorities t where workflow_id=$1'),
    occurrences: await query('select to_jsonb(t) as value from workflow_schedule_occurrences t where workflow_id=$1 order by due_at'),
    runs: await query('select to_jsonb(t) as value from runs t where workflow_id=$1 order by id'),
    snapshots: await query('select to_jsonb(t) as value from run_board_snapshots t where workflow_id=$1 order by run_id'),
    runAuthority: await query(`select to_jsonb(t) as value from run_authority_principals t
      where run_id in (select id from runs where workflow_id=$1) order by run_id,principal_id`),
    graphHeads: await query(`select to_jsonb(t) as value from run_graph_heads t
      where run_id in (select id from runs where workflow_id=$1) order by run_id`),
    receipts: await query(`select to_jsonb(t) as value from management_command_receipts t
      where (operation like 'workflow.schedule.%' and target_key=$1)
        or (operation='run.start' and result->>'workflowId'=$2)
      order by principal_id,operation,command_id`, [JSON.stringify(['workflow-schedule', f.scope.workspaceId, f.scope.workflowId]), f.scope.workflowId]),
    successes: await query(`select to_jsonb(t) as value from management_audit t where outcome='succeeded'
      and (target_key=$1 or target_key like $2) order by sequence`,
    [JSON.stringify(['workflow-schedule', f.scope.workspaceId, f.scope.workflowId]), `workflow:${f.scope.workflowId}:version:%`]),
  }
}
