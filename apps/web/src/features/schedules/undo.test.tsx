import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { ScheduleSaveInputSchema, type ScheduleSaveInput, type WorkflowSchedule } from '@foreman-code/contracts/schedules'
import { server } from '../../mocks/server'
import { deferred } from '../../test/deferred'
import { boardScope, executeBoardAction, pendingBoardAction, popBoardAction, useBoardUndo } from '../workflow-board/boardUndo'
import { schedulePath } from './client'
import { useScheduleCommand } from './queries'
import { recordScheduleUndo } from './undo'
import { fixture } from '../graph/nextDraft/core.cases'
import { nextDraftKey } from '../graph/nextDraft/state'
import { useGraphDraftStore } from '../graph/store'
import { useDraftEditorHistory } from '../graph/nextDraft/useDraftEditorHistory'
import type { DraftEditorCore } from '../graph/nextDraft/useDraftEditorCore'
import type { useGraphEditIntent } from '../graph/nextDraft/useGraphEditIntent'

const scope = { workspaceId: 'schedule-workspace', workflowId: 'schedule-workflow' }
const historyScope = boardScope(scope.workspaceId, scope.workflowId)
const previous: WorkflowSchedule = { ...scope, mode: 'weekly', weekdays: [1], time: '09:00', timezone: 'UTC',
  enabled: true, policy: 'latest_saved', revision: 1, nextOccurrenceAt: null }
const next = { ...previous, time: '10:00', revision: 2 }
let persisted: WorkflowSchedule
let inputs: ScheduleSaveInput[]

beforeEach(() => {
  useBoardUndo.setState({ actions: {}, redo: {}, changes: {}, depth: {}, notice: undefined, pending: {}, scheduleRevisions: {} })
  persisted = next
  inputs = []
  server.use(http.get(schedulePath(scope), () => HttpResponse.json({ schedule: persisted })),
    http.put(schedulePath(scope), async ({ request }) => {
      const input = ScheduleSaveInputSchema.parse({ ...scope, ...await request.json() as object })
      inputs.push(input)
      if (input.expectedRevision !== persisted.revision) {
        return HttpResponse.json({ error: { code: 'REVISION_CONFLICT', message: 'Schedule changed.' } }, { status: 409 })
      }
      persisted = { ...scope, ...input.schedule, revision: persisted.revision + 1, nextOccurrenceAt: null }
      return HttpResponse.json({ value: persisted, replayed: false })
    }))
})

function owner() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const hook = renderHook(() => useScheduleCommand(scope), { wrapper })
  recordScheduleUndo(scope, previous, next, client)
  return { ...hook, client, close: () => { hook.unmount(); client.clear() } }
}

it('preserves a newer schedule when Undo conflicts', async () => {
  const view = owner()
  try {
    persisted = { ...next, enabled: false, revision: 3 }
    const action = pendingBoardAction(historyScope, 0)!
    await expect(action.undo()).rejects.toThrow(/Schedule changed/)
    expect(persisted).toMatchObject({ enabled: false, revision: 3, time: '10:00' })
    expect(pendingBoardAction(historyScope, 0)).toBe(action)
  } finally { view.close() }
})

it('keeps Redo in place after a definite schedule rejection', async () => {
  const view = owner()
  try {
    const action = pendingBoardAction(historyScope, 0)!
    await action.undo()
    popBoardAction(historyScope, action)
    server.use(http.put(schedulePath(scope), () => HttpResponse.json({ error: {
      code: 'REVISION_CONFLICT', message: 'Schedule changed.' }, }, { status: 409 })))
    await expect(executeBoardAction(historyScope, 'redo', 0)).rejects.toThrow(/Schedule changed/)
    expect(useBoardUndo.getState().redo[historyScope]).toHaveLength(1)
    expect(useBoardUndo.getState().actions[historyScope]).toHaveLength(0)
  } finally { view.close() }
})

it('replays an unconfirmed Redo before moving either history stack', async () => {
  const view = owner()
  try {
    await executeBoardAction(historyScope, 'undo', 0)
    const reply = deferred<void>()
    const reached = deferred<void>()
    let committed: WorkflowSchedule | undefined
    server.use(http.put(schedulePath(scope), async ({ request }) => {
      const input = ScheduleSaveInputSchema.parse({ ...scope, ...await request.json() as object })
      inputs.push(input)
      if (committed) return HttpResponse.json({ value: committed, replayed: true })
      committed = { ...scope, ...input.schedule, revision: persisted.revision + 1, nextOccurrenceAt: null }
      persisted = committed
      reached.resolve()
      await reply.promise
      return HttpResponse.error()
    }))
    const first = executeBoardAction(historyScope, 'redo', 0)
    const failure = expect(first).rejects.toThrow()
    await reached.promise
    expect(useBoardUndo.getState().redo[historyScope]).toHaveLength(1)
    expect(useBoardUndo.getState().actions[historyScope]).toHaveLength(0)
    await expect(executeBoardAction(historyScope, 'redo', 0)).resolves.toBe(false)
    await act(async () => {
      expect(await view.result.current.submit({ kind: 'save', input: { ...scope, schedule: previous,
        expectedRevision: persisted.revision } })).toBeUndefined()
    })
    reply.resolve()
    await failure
    await waitFor(() => expect(view.result.current.unconfirmed).toBe(true))
    await act(async () => {
      expect(await view.result.current.submit({ kind: 'save', input: { ...scope, schedule: previous,
        expectedRevision: persisted.revision } })).toBeUndefined()
      expect(await executeBoardAction(historyScope, 'redo', 0)).toBe(true)
    })
    expect(inputs.at(-1)).toEqual(inputs.at(-2))
    expect(persisted.revision).toBe(4)
    expect(useBoardUndo.getState().redo[historyScope]).toHaveLength(0)
    expect(useBoardUndo.getState().actions[historyScope]).toHaveLength(1)
  } finally { view.close() }
})

it('tracks revision changes across the user’s own consecutive Undo and Redo operations', async () => {
  const view = owner()
  try {
    const latest = { ...next, time: '11:00', revision: 3 }
    persisted = latest
    recordScheduleUndo(scope, next, latest, view.client)
    await executeBoardAction(historyScope, 'undo', 0)
    await executeBoardAction(historyScope, 'undo', 0)
    expect(persisted).toMatchObject({ time: '09:00', revision: 5 })
    await executeBoardAction(historyScope, 'redo', 0)
    await executeBoardAction(historyScope, 'redo', 0)
    expect(persisted).toMatchObject({ time: '11:00', revision: 7 })
  } finally { view.close() }
})


function boardHistory(client: QueryClient) {
  const context = fixture()
  const key = nextDraftKey(scope.workspaceId, scope.workflowId)
  useGraphDraftStore.getState().installNextDraft(key, context)
  const report = vi.fn()
  const core = { prepare: async (action: () => unknown) => action(), canvas: { current: null },
    layout: { mutate: vi.fn() }, report } as unknown as DraftEditorCore
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const hook = renderHook(() => {
    const schedule = useScheduleCommand(scope)
    return useDraftEditorHistory({ draftKey: key, undoScope: historyScope, board: null,
      editIntent: { locked: false } as ReturnType<typeof useGraphEditIntent>,
      core, saveBusy: false, starting: false, schedule })
  }, { wrapper })
  return { ...hook, report, unmount: () => { hook.unmount(); useGraphDraftStore.getState().dropNextDraft(key) } }
}

it('keeps Board Redo available when its actual schedule callback is rejected', async () => {
  const view = owner()
  const history = boardHistory(view.client)
  try {
    const action = pendingBoardAction(historyScope, 0)!
    await action.undo()
    popBoardAction(historyScope, action)
    server.use(http.put(schedulePath(scope), () => HttpResponse.json({ error: {
      code: 'REVISION_CONFLICT', message: 'Schedule changed.' } }, { status: 409 })))
    act(() => history.result.current('redo'))
    await waitFor(() => expect(history.report).toHaveBeenCalled())
    expect(useBoardUndo.getState().redo[historyScope]).toHaveLength(1)
    expect(useBoardUndo.getState().actions[historyScope]).toHaveLength(0)
  } finally { history.unmount(); view.close() }
})

it('owns the Board’s actual schedule Redo until its lost reply is reconciled', async () => {
  const view = owner()
  const history = boardHistory(view.client)
  const reached = deferred<void>()
  const release = deferred<void>()
  try {
    const action = pendingBoardAction(historyScope, 0)!
    await action.undo()
    popBoardAction(historyScope, action)
    let accepted: WorkflowSchedule | undefined
    let original: ScheduleSaveInput | undefined
    server.use(http.put(schedulePath(scope), async ({ request }) => {
      const input = ScheduleSaveInputSchema.parse({ ...scope, ...await request.json() as object })
      inputs.push(input)
      if (accepted) {
        expect(input).toEqual(original)
        return HttpResponse.json({ value: accepted, replayed: true })
      }
      original = input
      accepted = { ...scope, ...input.schedule, revision: persisted.revision + 1, nextOccurrenceAt: null }
      persisted = accepted
      reached.resolve()
      await release.promise
      return HttpResponse.error()
    }))
    act(() => history.result.current('redo'))
    await reached.promise
    expect(useBoardUndo.getState().redo[historyScope]).toHaveLength(1)
    expect(useBoardUndo.getState().actions[historyScope]).toHaveLength(0)
    await waitFor(() => expect(view.result.current.pending).toBe(true))
    act(() => history.result.current('redo'))
    expect(await view.result.current.submit({ kind: 'save', input: { ...scope,
      expectedRevision: persisted.revision, schedule: previous } })).toBeUndefined()
    release.resolve()
    await waitFor(() => expect(view.result.current.unconfirmed).toBe(true))
    expect(useBoardUndo.getState().redo[historyScope]).toHaveLength(1)
    act(() => history.result.current('redo'))
    await waitFor(() => expect(useBoardUndo.getState().redo[historyScope]).toHaveLength(0))
    expect(inputs.at(-1)).toEqual(inputs.at(-2))
    expect(persisted.revision).toBe(4)
    expect(useBoardUndo.getState().actions[historyScope]).toHaveLength(1)
  } finally { release.resolve(); history.unmount(); view.close() }
})


it('stops consecutive Undo at an external edit between two local schedule changes', async () => {
  const view = owner()
  try {
    const external = { ...next, enabled: false, revision: 3 }
    const local = { ...external, time: '11:00', revision: 4 }
    persisted = local
    recordScheduleUndo(scope, external, local, view.client)
    await expect(executeBoardAction(historyScope, 'undo', 0)).resolves.toBe(true)
    expect(persisted).toMatchObject({ enabled: false, time: '10:00', revision: 5 })
    const earlier = pendingBoardAction(historyScope, 0)
    await expect(executeBoardAction(historyScope, 'undo', 0)).rejects.toThrow(/Schedule changed/)
    expect(persisted).toMatchObject({ enabled: false, time: '10:00', revision: 5 })
    expect(inputs).toHaveLength(1)
    expect(pendingBoardAction(historyScope, 0)).toBe(earlier)
  } finally { view.close() }
})

it('allows the newer action’s Redo after Undo stops at an external schedule edit', async () => {
  const view = owner()
  try {
    const earlier = pendingBoardAction(historyScope, 0)!
    const external = { ...next, enabled: false, revision: 3 }
    const local = { ...external, time: '11:00', revision: 4 }
    persisted = local
    recordScheduleUndo(scope, external, local, view.client)
    await expect(executeBoardAction(historyScope, 'undo', 0)).resolves.toBe(true)
    expect(persisted).toMatchObject({ enabled: false, time: '10:00', revision: 5 })
    expect(pendingBoardAction(historyScope, 0)).toBe(earlier)
    await expect(executeBoardAction(historyScope, 'undo', 0)).rejects.toThrow(/Schedule changed/)
    expect(pendingBoardAction(historyScope, 0)).toBe(earlier)
    expect(useBoardUndo.getState().redo[historyScope]).toHaveLength(1)
    expect(inputs).toHaveLength(1)
    await expect(executeBoardAction(historyScope, 'redo', 0)).resolves.toBe(true)
    expect(persisted).toMatchObject({ enabled: false, time: '11:00', revision: 6 })
    expect(inputs.map(input => input.expectedRevision)).toEqual([4, 5])
    expect(useBoardUndo.getState().redo[historyScope]).toHaveLength(0)
  } finally { view.close() }
})
