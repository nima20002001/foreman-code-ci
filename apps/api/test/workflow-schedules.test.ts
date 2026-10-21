import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { graphqlToolRoles } from '@foreman-code/contracts'
import { nextOccurrences, ScheduleConfigurationSchema, ScheduleOccurrenceSchema, scheduleOccurrenceId } from '@foreman-code/contracts/schedules'
import { DomainError } from '../src/modules/errors.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkflowScheduleService } from '../src/modules/schedules/service.js'
import { decodeScheduleCursor, DueCursorSchema, encodeScheduleCursor, OccurrenceCursorSchema } from '../src/modules/schedules/cursors.js'
import { ScheduleOccurrenceListInputSchema } from '../src/modules/schedules/transportSchemas.js'
import { workflowScheduleCapabilities, unavailableWorkflowScheduleToolCall, WORKFLOW_SCHEDULE_TOOLS } from '../src/mcp/operator/tools/workflowSchedules.js'
import type { OperatorRequestContext } from '../src/mcp/operator/types.js'

const scope = { workspaceId: 'schedule-unit-workspace', workflowId: 'schedule-unit-workflow' }
const settings = { timezone: 'UTC', enabled: true, policy: 'latest_saved' as const }
const weekly = { ...settings, mode: 'weekly' as const, weekdays: [1, 3], time: '10:00' }
const principal: ManagementPrincipal = {
  id: 'schedule-unit-principal', name: 'Synthetic schedule unit reader', audience: 'operator',
  grants: [{ actions: ['workflows:read'], scope: { workspaceIds: [scope.workspaceId] } }],
  expiresAt: '9999-12-31T00:00:00.000Z', revokedAt: null,
}

// These tests exercise pure boundaries only. The companion integration file uses real PostgreSQL and authentication.
describe('schedule persistence input boundaries', () => {
  it.each([
    ['weekly', weekly, '2030-01-07T10:00:00.000Z'],
    ['interval', { ...settings, mode: 'interval', every: 1, unit: 'minute', anchorAt: '2030-01-07T08:00:00Z' }, '2030-01-07T09:01:00.000Z'],
    ['once', { ...settings, mode: 'once', localDate: '2030-01-08', time: '10:00' }, '2030-01-08T10:00:00.000Z'],
  ])('uses the frozen %s recurrence', (_name, raw, next) => {
    expect(nextOccurrences(ScheduleConfigurationSchema.parse(raw), '2030-01-07T09:00:00.000Z', 1)).toEqual([next])
  })

  it.each([
    { ...weekly, timezone: 'Not/A_Zone' }, { ...weekly, timezone: 'EST' }, { ...weekly, timezone: '+05:00' },
    { ...weekly, weekdays: [] }, { ...weekly, weekdays: [1, 1] }, { ...weekly, weekdays: [0] },
    { ...weekly, weekdays: [8] }, { ...weekly, weekdays: [1.5] }, { ...weekly, time: '24:00' },
    { ...settings, mode: 'interval', every: 0, unit: 'minute', anchorAt: '2030-01-01T00:00:00Z' },
    { ...settings, mode: 'interval', every: 0.5, unit: 'hour', anchorAt: '2030-01-01T00:00:00Z' },
    { ...settings, mode: 'interval', every: 1, unit: 'day', anchorAt: '2030-01-01T00:00:00Z' },
    { ...settings, mode: 'once', localDate: '2030-02-30', time: '10:00' },
  ])('rejects invalid settings before connecting to SQL: %j', async (schedule) => {
    const connect = vi.fn()
    const service = new WorkflowScheduleService({ connect } as unknown as pg.Pool, {} as PostgresCommandCoordinator)
    await expect(service.save(principal, 'mcp', { ...scope, commandId: 'invalid-input', expectedRevision: 0, schedule }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    expect(connect).not.toHaveBeenCalled()
  })

  it('denies cross-workspace reads before database access', async () => {
    const connect = vi.fn()
    const service = new WorkflowScheduleService({ connect } as unknown as pg.Pool, {} as PostgresCommandCoordinator)
    await expect(service.get(principal, { ...scope, workspaceId: 'foreign' }))
      .rejects.toMatchObject({ code: 'ACCESS_DENIED', status: 403 })
    expect(connect).not.toHaveBeenCalled()
  })

  it('bounds paging without coercing JSON/MCP limits', () => {
    expect(ScheduleOccurrenceListInputSchema.parse(scope).limit).toBe(50)
    expect(ScheduleOccurrenceListInputSchema.parse({ ...scope, limit: 100 }).limit).toBe(100)
    for (const limit of [0, 101, 1.5, '2']) expect(ScheduleOccurrenceListInputSchema.safeParse({ ...scope, limit }).success).toBe(false)
  })

  it('canonicalizes occurrence identity and rejects contradictory outcome fields', () => {
    const dueAt = '2030-01-07T09:00:00.000Z'
    const id = scheduleOccurrenceId(scope.workflowId, dueAt)
    expect(scheduleOccurrenceId(scope.workflowId, '2030-01-07T14:00:00+05:00')).toBe(id)
    const occurrence = { ...scope, id, dueAt, scheduleRevision: 1, status: 'skipped', reason: 'overlap' }
    expect(ScheduleOccurrenceSchema.safeParse(occurrence).success).toBe(true)
    expect(ScheduleOccurrenceSchema.safeParse({ ...occurrence, runId: 'not-accepted' }).success).toBe(false)
    expect(ScheduleOccurrenceSchema.safeParse({ ...occurrence, status: 'accepted', reason: null }).success).toBe(false)
    expect(ScheduleOccurrenceSchema.safeParse({ ...occurrence, id: 'caller-chosen-id' }).success).toBe(false)
  })
})

describe('bounded scoped schedule cursors', () => {
  const value = { ...scope, kind: 'schedule-occurrences-v1', beforeDueAt: '2030-01-07T09:00:00.000Z' }
  it('round trips an explicit cursor kind and scope', () => {
    expect(decodeScheduleCursor(encodeScheduleCursor(value), OccurrenceCursorSchema)).toEqual(value)
  })
  it.each(['', '%not-base64', 'a'.repeat(4097), Buffer.from([0xff]).toString('base64url'),
    Buffer.from('not-json').toString('base64url')])('rejects malformed/oversized cursors', (cursor) => {
    expect(() => decodeScheduleCursor(cursor, OccurrenceCursorSchema)).toThrow(DomainError)
  })
  it('rejects padding, unknown keys and a different cursor kind', () => {
    expect(() => decodeScheduleCursor(encodeScheduleCursor(value) + '=', OccurrenceCursorSchema)).toThrow(DomainError)
    expect(() => decodeScheduleCursor(encodeScheduleCursor({ ...value, other: true }), OccurrenceCursorSchema)).toThrow(DomainError)
    expect(() => decodeScheduleCursor(encodeScheduleCursor(value), DueCursorSchema)).toThrow(DomainError)
  })
})

describe('schedule MCP grant discovery and direct-call denial', () => {
  function context() {
    const recordDenied = vi.fn().mockResolvedValue(undefined)
    return { recordDenied, value: { principal, services: {
      workflows: { schedules: {} }, commands: { recordDenied },
    } } as unknown as OperatorRequestContext }
  }
  it('exposes reads, not writes, and never grants worker roles schedule authority', () => {
    const { value } = context()
    expect(workflowScheduleCapabilities(value, scope).map((entry) => entry.name))
      .toEqual(['workflow_schedule_get', 'workflow_schedule_occurrences_list'])
    expect(workflowScheduleCapabilities(value, { ...scope, workspaceId: 'foreign' })).toEqual([])
    for (const name of WORKFLOW_SCHEDULE_TOOLS) expect(graphqlToolRoles(name)).toEqual(['operator'])
  })
  it('audits an explicit call to an unlisted write instead of returning an unknown tool', async () => {
    const { value, recordDenied } = context()
    const response = await unavailableWorkflowScheduleToolCall(value, {
      jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'workflow_schedule_save', arguments: {} },
    })
    expect(response?.result.isError).toBe(true)
    expect(response?.result.content).toEqual([expect.objectContaining({ type: 'text', text: expect.stringContaining('ACCESS_DENIED') })])
    expect(recordDenied).toHaveBeenCalledWith(principal.id, 'mcp', 'workflow_schedule_save', 'mcp:workflow_schedule_save')
  })
})
