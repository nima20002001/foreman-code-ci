import { Writable } from 'node:stream'
import pino from 'pino'
import { expect, it, vi } from 'vitest'
import { WorkflowScheduleSchema } from '@foreman-code/contracts/schedules'
import { buildApp } from '../src/app.js'
import type { PostgresAccessService } from '../src/modules/access/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { DeviceAccessError } from '../src/modules/devices/access.js'
import { WorkflowScheduleDispatcher } from '../src/modules/schedules/dispatcher.js'
import { scheduleDispatchLog, type ScheduleDispatchErrorReporter } from '../src/modules/schedules/dispatchErrors.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

const deviceFailures = [
  ['unauthorized', 'DEVICE_ACCESS_UNAUTHORIZED'],
  ['revoked', 'DEVICE_ACCESS_REVOKED'],
  ['expired', 'DEVICE_ACCESS_EXPIRED'],
  ['conflict', 'DEVICE_ACCESS_CONFLICT'],
  ['forbidden', 'DEVICE_ACCESS_FORBIDDEN'],
  ['wrong_main', 'DEVICE_ACCESS_WRONG_MAIN'],
] as const
const workflowFailures = [
  { code: 'WORKSPACE_LOCATION_TIMEOUT', error: new DomainError(
    'WORKSPACE_LOCATION_TIMEOUT', 'raw native output with workflow-secret', 504,
    { token: 'private-token', sql: 'SELECT secret' },
  ) },
  ...deviceFailures.map(([deviceCode, code]) => ({ code, error: Object.assign(new DeviceAccessError(deviceCode), {
    message: 'raw native output with workflow-secret', details: { token: 'private-token', sql: 'SELECT secret' },
  }) })),
]

it.each(workflowFailures)(
  'production callback logs safe $code scan/workflow causes and the attempted occurrence', async ({ code, error }) => {
  const lines: Record<string, unknown>[] = []
  const sink = new Writable({ write(chunk, _encoding, done) {
    lines.push(JSON.parse(String(chunk)) as Record<string, unknown>)
    done()
  } })
  let report!: ScheduleDispatchErrorReporter
  const services = { runs: {
    startScheduleDispatcher: (callback: ScheduleDispatchErrorReporter) => { report = callback },
    stopScheduleDispatcher: async () => {},
  } } as unknown as OperatorServices
  const app = buildApp({ logger: pino({ level: 'error' }, sink),
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access: {} as PostgresAccessService, services } })
  const schedule = WorkflowScheduleSchema.parse({ workspaceId: 'log-workspace', workflowId: 'log-workflow',
    revision: 1, mode: 'interval', every: 1, unit: 'minute', timezone: 'UTC',
    anchorAt: '2030-01-07T09:00:00.000Z', nextOccurrenceAt: '2030-01-07T10:00:00.000Z',
    enabled: true, policy: 'latest_saved' })
  let scan = 0
  let loop: WorkflowScheduleDispatcher | undefined
  try {
    await app.ready()
    vi.useFakeTimers()
    loop = new WorkflowScheduleDispatcher({
      listDueSchedules: async () => {
        if (scan++ === 0) throw Object.assign(new Error('password=scan-secret; SELECT private'), {
          code: '08006', detail: 'credentials and sensitive SQL',
        })
        return { items: [schedule], pageInfo: { nextCursor: null } }
      },
      dispatch: async (_schedule, _signal, onCandidate) => {
        onCandidate?.({ ...schedule, nextOccurrenceAt: '2030-01-07T10:01:00.000Z' })
        throw error
      },
    }, { reportError: report })
    loop.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await loop.stop()
    expect(lines).toEqual([
      expect.objectContaining({ code: '08006', cause: 'database_error', phase: 'scan' }),
      expect.objectContaining({ code, cause: 'application_error', phase: 'workflow',
        workspaceId: schedule.workspaceId, workflowId: schedule.workflowId, dueAt: '2030-01-07T10:01:00.000Z' }),
    ])
    expect(JSON.stringify(lines)).not.toMatch(/scan-secret|workflow-secret|private-token|SELECT|native output|credentials/)
  } finally { await loop?.stop(); vi.useRealTimers(); await app.close() }
})

it('classifies connection failures and rejects arbitrary messages/codes at the logging boundary', () => {
  expect(scheduleDispatchLog(Object.assign(new Error('private'), { code: 'ECONNREFUSED' })))
    .toMatchObject({ code: 'ECONNREFUSED', cause: 'connection_error' })
  for (const error of [new Error('token=private'), { code: 'Bearer private', detail: 'private SQL' },
    new DomainError('token=private', 'private', 500), new DomainError('revoked', 'private', 403),
    Object.assign(new DeviceAccessError('revoked'), { code: 'Bearer private' })]) {
    expect(scheduleDispatchLog(error)).toEqual({ code: 'INTERNAL_ERROR', cause: 'unexpected_error', phase: 'scan' })
  }
})
