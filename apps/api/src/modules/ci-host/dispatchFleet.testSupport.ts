import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import { CiRunRecordSchema, type CiHostRequest, type CiHostStatus, type CiRunRecord } from '@foreman-code/contracts'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { CircleStandby } from './circleStandby.js'
import type { CiAuthority } from '../jobs/ciAuthority.js'
import { HostCiService, type CiCommits, type HostCiComputer, type HostCiEndpoint } from './service.js'

export function queuedTicket(overrides: Partial<CiRunRecord> = {}): CiRunRecord {
  return CiRunRecordSchema.parse({
    id: randomUUID(), workspaceId: 'workspace', groupId: randomUUID(), suite: 'build', part: null,
    scope: 'full', files: [], partition: null,
    repository: 'owner/repo', ciMirror: 'example/ci-mirror', commit: 'a'.repeat(40),
    state: 'queued', computer: null, step: null,
    exitCode: null, message: null, queuedAt: '2026-10-12T00:00:00.000Z', startedAt: null, finishedAt: null,
    initiator: { principalId: 'operator', executionId: null },
    ...overrides,
  })
}

export function readyStatus(overrides: Partial<CiHostStatus> = {}): CiHostStatus {
  return { operation: 'status', ready: true, reasons: [], cpuCount: 8, memoryBytes: 16 * 2 ** 30,
    runs: [], slotsTotal: 1, slotsUsed: 0, ...overrides }
}

/** A dispatchable fleet over an in-memory ticket table; the test controls each status read and start. */
export function dispatchFleet(computers: HostCiComputer[], records: CiRunRecord[], options: {
  status?: (computer: HostCiComputer) => Promise<CiHostStatus>
  publishMirror?: HostCiEndpoint['publishMirror']
  circleStandby?: CircleStandby
} = {}) {
  const started: { computer: HostCiComputer; request: Extract<CiHostRequest, { operation: 'start' }> }[] = []
  const pool = { options: { max: 10 }, query: async (sql: string, parameters?: unknown[]) => {
    if (sql.includes('ci_dispatch_claims')) return { rows: [], rowCount: 1 }
    if (sql.startsWith('select record from ci_runs where id=')) {
      return { rows: records.filter(record => record.id === parameters![0]).map(record => ({ record })) }
    }
    if (sql.startsWith('update ci_runs')) {
      const record = CiRunRecordSchema.parse(JSON.parse(parameters![3] as string))
      const previous = records.find(item => item.id === record.id)
      if (sql.includes("state='queued'") && (previous?.state !== 'queued'
        || JSON.stringify(previous) !== parameters![4])) return { rows: [], rowCount: 0 }
      records[records.findIndex(item => item.id === record.id)] = record
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('select distinct group_id')) return { rows: [] }
    if (sql.includes('where group_id=any')) return { rows: records.map(record => ({ record })) }
    if (sql.includes("state='queued'")) {
      return { rows: records.filter(record => record.state === 'queued').map(record => ({ record, durations: null })) }
    }
    if (sql.includes("'gate'='true'")) return { rows: [] }
    if (sql.includes("state in ('passed','failed')")) return { rows: [] }
    return { rows: records.filter(record => ['starting', 'running'].includes(record.state))
      .map(record => ({ id: record.id, record, host_key: computers.find(computer =>
        isDeepStrictEqual(computer.hostRef, record.computer?.hostRef))?.key ?? computers[0]!.key })) }
  }, connect: async () => ({ query: pool.query, release: () => {} }) } as unknown as pg.Pool
  const endpoint: HostCiEndpoint = {
    computers: async () => computers,
    request: async (computer, request) => {
      if (request.operation === 'status') return options.status ? options.status(computer) : readyStatus()
      if (request.operation !== 'start') throw new Error('Unexpected fixture request')
      started.push({ computer, request })
      return { operation: 'start', run: { runId: request.runId, state: 'running', step: 'build',
        exitCode: null, startedAt: '2026-10-12T00:00:01.000Z', finishedAt: null, logBytes: 0, message: null } }
    },
  }
  if (options.publishMirror) endpoint.publishMirror = options.publishMirror
  const service = new HostCiService(pool, {} as PostgresCommandCoordinator, {} as CiAuthority, {} as CiCommits, endpoint,
    undefined, options.circleStandby ? { circleStandby: options.circleStandby } : {})
  return { service, started, endpoint }
}
