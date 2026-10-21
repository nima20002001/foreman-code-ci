import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { CiRunRecordSchema, type CiHostRun, type CiPart, type CiSuite, type CiTestStatus } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { CiAuthority } from '../jobs/ciAuthority.js'
import type { CloudCi } from './cloud.js'
import { HostCiService, type CiCommits, type HostCiComputer } from './service.js'

/** Keeps Main's database boundary in memory while using the real cloud adapter and dispatcher. */
export function cloudService(cloud: CloudCi, run: CiHostRun, commit: string,
  selection: { suite?: CiSuite; part?: CiPart } = {}) {
  const computer: HostCiComputer = { key: `cloud:${cloud.provider.id}`, label: cloud.provider.label, priority: 0,
    hostRef: { kind: 'cloud', mainId: 'main', provider: cloud.provider.id, slot: 0 },
    userSystemd: { supported: true, reason: null } }
  let record = CiRunRecordSchema.parse({ id: run.runId, workspaceId: 'workspace', groupId: randomUUID(),
    suite: selection.suite ?? 'integration', part: selection.part ?? null,
    partition: null, scope: 'full', files: [], repository: 'octo/site', commit,
    state: run.state, computer: { hostRef: computer.hostRef, label: computer.label }, step: run.step,
    queuedAt: run.startedAt, startedAt: run.startedAt, finishedAt: run.finishedAt, exitCode: run.exitCode,
    message: run.message, initiator: { principalId: 'operator', executionId: null } })
  let testResults: unknown = null
  let logTail = ''
  const pool = { query: async (sql: string, parameters?: unknown[]) => {
    if (sql.startsWith('update ci_runs set test_results=')) {
      testResults = JSON.parse(parameters![1] as string)
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('update ci_runs set durations=')) return { rows: [], rowCount: 1 }
    if (sql.startsWith('update ci_runs')) {
      record = CiRunRecordSchema.parse(JSON.parse(parameters![3] as string))
      if (typeof parameters![5] === 'string') logTail = parameters![5]
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('supersededBy') || sql.includes("record->>'gate'='true'") || sql.includes('durations from ci_runs')) {
      return { rows: [] }
    }
    if (sql.includes('as group_id')) return { rows: [{ group_id: record.groupId, state: record.state }] }
    const active = ['starting', 'running'].includes(record.state)
    if (sql.includes("state='queued'") && record.state !== 'queued'
      || sql.includes("state in ('starting','running')") && !active
      || sql.includes("state in ('passed','failed')") && !['passed', 'failed'].includes(record.state)) return { rows: [] }
    return { rows: [{ id: record.id, record, host_key: active ? computer.key : null,
      log_tail: logTail, test_results: testResults, durations: null, position: 1 }] }
  } } as unknown as pg.Pool
  const principal: ManagementPrincipal = { id: 'operator', name: 'Operator', audience: 'operator',
    grants: [], expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
  const authority: CiAuthority = { resolve: async () => ({ principal, workspaceId: 'workspace' }) }
  const service = new HostCiService(pool, {} as PostgresCommandCoordinator, authority, {} as CiCommits,
    { computers: async () => [computer], request: async (_computer, request) => cloud.handle(request) })
  // A dispatch pass observes tickets in the background; wait for those observations to settle before the test reads.
  const dispatch = service.dispatch.bind(service)
  service.dispatch = async () => { await dispatch(); await service.drain() }
  return { service, read: (testStatus?: CiTestStatus[]) => service.get(principal,
    { workspaceId: 'workspace', ticketId: record.id, ...(testStatus ? { testStatus } : {}) }) }
}
