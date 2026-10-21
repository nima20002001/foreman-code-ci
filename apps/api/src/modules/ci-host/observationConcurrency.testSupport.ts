import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { CiRunRecordSchema } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { HostCiService, type CiCommits, type HostCiComputer, type HostCiEndpoint } from './service.js'

export function observationFixture(options: {
  cloud: number
  local: number
  poolSize: number
  beforeRead?: (runId: string) => Promise<void>
  beforeWrite?: () => Promise<void>
}) {
  const computers: HostCiComputer[] = Array.from({ length: options.cloud + options.local }, (_, index) => ({
    key: `executor-${index}`, label: `Executor ${index}`, priority: 0,
    hostRef: index < options.cloud
      ? { kind: 'cloud', mainId: 'main', provider: 'github', slot: index }
      : { kind: 'device', mainId: 'main', deviceId: `device-${index}` },
  }))
  const records = computers.map(computer => CiRunRecordSchema.parse({
    id: randomUUID(), groupId: randomUUID(), workspaceId: 'workspace', suite: 'lint', partition: null,
    repository: 'example/project', commit: 'a'.repeat(40), state: 'running',
    computer: { hostRef: computer.hostRef, label: computer.label }, step: 'lint',
    queuedAt: new Date().toISOString(), startedAt: new Date().toISOString(),
    finishedAt: null, exitCode: null, message: null,
    initiator: { principalId: 'operator', executionId: null },
  }))
  const query = async (sql: string, values?: unknown[]) => {
    if (sql.startsWith('update ci_runs')) {
      await options.beforeWrite?.()
      const index = records.findIndex(record => record.id === values?.[0])
      records[index] = CiRunRecordSchema.parse(JSON.parse(values![3] as string))
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes("'supersededBy' is not null") || sql.includes("state='queued'")
      || sql.includes("'gate'='true'")) return { rows: [] }
    if (sql.includes("state in ('starting','running')")) {
      return { rows: records.map((record, index) => ({ id: record.id, record, host_key: computers[index]!.key })) }
    }
    return { rows: records.filter(record => record.id === values?.[0] || record.groupId === values?.[0])
      .map(record => ({ record, log_tail: '' })) }
  }
  const pool = { options: { max: options.poolSize }, query } as unknown as pg.Pool
  const reads: string[] = []
  const endpoint: HostCiEndpoint = { computers: async () => computers, request: async (_computer, request) => {
    if (request.operation === 'status') return { operation: 'status', ready: true, reasons: [],
      cpuCount: 4, memoryBytes: 8 * 2 ** 30, runs: [], slotsUsed: 1, slotsTotal: 1 }
    if (request.operation !== 'read') throw new Error('Unexpected executor operation')
    reads.push(request.runId)
    await options.beforeRead?.(request.runId)
    const record = records.find(record => record.id === request.runId)!
    return { operation: 'read', run: { runId: record.id, state: 'running', step: 'checking',
      startedAt: record.startedAt!, finishedAt: null, exitCode: null, message: null, logBytes: 0 },
    text: '', nextOffset: 0 }
  } }
  const caller: ManagementPrincipal = { id: 'operator', name: 'Operator', audience: 'operator',
    grants: [], expiresAt: '2099-01-01T00:00:00Z', revokedAt: null }
  const service = new HostCiService(pool, {} as PostgresCommandCoordinator,
    { resolve: async () => ({ principal: caller, workspaceId: 'workspace' }) }, {} as CiCommits, endpoint)
  return { service, caller, records, reads,
    warm: () => service.computers(caller, { workspaceId: 'workspace' }) }
}
