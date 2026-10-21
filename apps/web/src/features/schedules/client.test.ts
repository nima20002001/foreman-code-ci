import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { scheduleOccurrenceId, type ScheduleSaveInput } from '@foreman-code/contracts/schedules'
import { server } from '../../mocks/server'
import { scheduleApi, schedulePath } from './client'

const scope = { workspaceId: 'workspace-test', workflowId: 'workflow-test' }
const input: ScheduleSaveInput = { ...scope, commandId: 'schedule-client-command', expectedRevision: 0,
  schedule: { mode: 'weekly', weekdays: [1], time: '09:00', timezone: 'UTC', enabled: true, policy: 'latest_saved' } }
const value = { ...scope, ...input.schedule, revision: 1, nextOccurrenceAt: '2099-08-24T09:00:00.000Z' }
const dueAt = '2099-08-17T09:00:00.000Z'
const rejected = {
  ...scope, id: scheduleOccurrenceId(scope.workflowId, dueAt), dueAt, scheduleRevision: 1,
  status: 'rejected', reason: 'workflow_not_executable',
}

describe('schedule HTTP client', () => {
  it('reads the latest occurrence through the shared client with bounded paging', async () => {
    server.use(http.get(`${schedulePath(scope)}/occurrences`, ({ request }) => {
      const query = new URL(request.url).searchParams
      expect(request.credentials).toBe('omit')
      expect(request.headers.has('authorization')).toBe(false)
      expect(query.get('limit')).toBe('1')
      expect(query.get('cursor')).toBe('cursor/with?reserved&values')
      return HttpResponse.json({ items: [rejected], pageInfo: { nextCursor: null } })
    }))
    expect(await scheduleApi.occurrences({ ...scope, limit: 1, cursor: 'cursor/with?reserved&values' }))
      .toEqual({ items: [rejected], pageInfo: { nextCursor: null } })
  })
  it.each([
    { ...rejected, workflowId: 'foreign-workflow', id: scheduleOccurrenceId('foreign-workflow', dueAt) },
    { ...rejected, workspaceId: 'foreign-workspace' },
  ])('rejects occurrence history from another scope', async (foreign) => {
    server.use(http.get(`${schedulePath(scope)}/occurrences`, () =>
      HttpResponse.json({ items: [foreign], pageInfo: { nextCursor: null } })))
    await expect(scheduleApi.occurrences({ ...scope, limit: 1 })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('rejects malformed occurrence history and preserves permission errors', async () => {
    server.use(http.get(`${schedulePath(scope)}/occurrences`, () =>
      HttpResponse.json({ items: [{ ...rejected, status: 'accepted' }], pageInfo: { nextCursor: null } })))
    await expect(scheduleApi.occurrences({ ...scope, limit: 1 })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    server.use(http.get(`${schedulePath(scope)}/occurrences`, () =>
      HttpResponse.json({ error: { code: 'ACCESS_DENIED', message: 'Denied.' } }, { status: 403 })))
    await expect(scheduleApi.occurrences({ ...scope, limit: 1 })).rejects.toMatchObject({ code: 'ACCESS_DENIED', status: 403 })
  })
  it('encodes both scope segments', () => {
    expect(schedulePath({ workspaceId: 'space/one', workflowId: 'flow?& two' }))
      .toBe('/api/management/workspaces/space%2Fone/workflows/flow%3F%26%20two/schedule')
  })
  it('reads absence without synthesizing a schedule', async () => {
    server.use(http.get(schedulePath(scope), ({ request }) => {
      expect(request.credentials).toBe('omit')
      expect(request.headers.has('authorization')).toBe(false)
      return HttpResponse.json({ schedule: null })
    }))
    expect(await scheduleApi.get(scope)).toEqual({ schedule: null })
  })
  it('sends the shared save envelope and validates persisted readback', async () => {
    server.use(http.put(schedulePath(scope), async ({ request }) => {
      expect(request.credentials).toBe('omit')
      expect(request.headers.has('authorization')).toBe(false)
      const { workspaceId, workflowId, ...body } = input; void workspaceId; void workflowId
      expect(await request.json()).toEqual(body)
      return HttpResponse.json({ value, replayed: false })
    }))
    expect(await scheduleApi.save(input)).toEqual({ value, replayed: false })
  })
  it('rejects a foreign-workflow read or successful save as an invalid response', async () => {
    const foreign = { ...value, workflowId: 'different-workflow' }
    server.use(http.get(schedulePath(scope), () => HttpResponse.json({ schedule: foreign })),
      http.put(schedulePath(scope), () => HttpResponse.json({ value: foreign, replayed: false })))
    await expect(scheduleApi.get(scope)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(scheduleApi.save(input)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('rejects malformed success and an enabled disable result', async () => {
    server.use(http.put(schedulePath(scope), () => HttpResponse.json({ ok: true })),
      http.post(`${schedulePath(scope)}/disable`, () => HttpResponse.json({ value, replayed: false })))
    await expect(scheduleApi.save(input)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(scheduleApi.disable({ ...scope, commandId: 'disable-command', expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('passes structured permission failures through the shared boundary', async () => {
    server.use(http.put(schedulePath(scope), () => HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Denied.' } }, { status: 403 })))
    await expect(scheduleApi.save(input)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
  })
})
