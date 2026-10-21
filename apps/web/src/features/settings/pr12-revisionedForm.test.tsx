import { act, renderHook, waitFor, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRevisionedFormPersistence, useRevisionedForm } from './revisionedForm'
import { beginSessionChange, finishSessionChange } from '../../shared/api/sessionBoundary'
import { rejectableDeferred } from '../../test/deferred'

interface Value { name: string }
const initial = { value: { name: 'original' }, revision: 1 }
function mount() { return renderHook(() => useRevisionedForm<Value>(initial, 'pr12-test')) }
beforeEach(clearRevisionedFormPersistence)
afterEach(() => { cleanup(); clearRevisionedFormPersistence() })

describe('PR12 shared settings saves', () => {
  it('delivers an acknowledgment to a remounted form and retains newer edits', async () => {
    const pending = rejectableDeferred<{ value: Value; revision: number }>()
    const first = mount()
    await waitFor(() => expect(first.result.current.draft).toEqual(initial.value))
    act(() => first.result.current.setDraft({ name: 'submitted' }))
    let work!: Promise<boolean>
    act(() => { work = first.result.current.save(() => pending.promise) })
    first.unmount()
    const second = mount()
    expect(second.result.current.isSaving).toBe(true)
    expect(second.result.current.draft?.name).toBe('submitted')
    act(() => second.result.current.setDraft({ name: 'newer' }))
    await act(async () => { pending.resolve({ value: { name: 'submitted' }, revision: 2 }); await work })
    expect(second.result.current.baseRevision).toBe(2)
    expect(second.result.current.draft?.name).toBe('newer')
    expect(second.result.current.isDirty).toBe(true)
    expect(second.result.current.conflicted).toBe(false)
  })
  it('retries the original command and payload after navigation and a lost response', async () => {
    const first = mount()
    await waitFor(() => expect(first.result.current.draft).toBeDefined())
    act(() => first.result.current.setDraft({ name: 'sent' }))
    const lost = vi.fn(async (request: unknown) => { void request; throw new Error('response lost') })
    await act(async () => { await first.result.current.save(lost) })
    expect(first.result.current.uncertain).toBe(true)
    const originalRequest = lost.mock.calls[0]![0]
    first.unmount()
    const second = mount()
    act(() => second.result.current.setDraft({ name: 'edited after failure' }))
    const retry = vi.fn(async (request: unknown) => { void request; return { value: { name: 'sent' }, revision: 2 } })
    await act(async () => { await second.result.current.save(retry) })
    expect(retry.mock.calls[0]![0]).toEqual(originalRequest)
    expect(second.result.current.draft?.name).toBe('edited after failure')
    expect(second.result.current.baseRevision).toBe(2)
    expect(second.result.current.uncertain).toBe(false)
  })
  it('blocks duplicate sends across two mounted instances', async () => {
    const first = mount(); const second = mount()
    await waitFor(() => expect(first.result.current.draft).toBeDefined())
    const pending = rejectableDeferred<{ value: Value; revision: number }>()
    const perform = vi.fn(() => pending.promise)
    let one!: Promise<boolean>; let two!: Promise<boolean>
    act(() => { one = first.result.current.save(perform); two = second.result.current.save(perform) })
    expect(perform).toHaveBeenCalledTimes(1)
    expect(await two).toBe(false)
    await act(async () => { pending.resolve(initial); await one })
  })
  it('releases a definitively rejected command, preserving the dirty draft', async () => {
    const form = mount()
    await waitFor(() => expect(form.result.current.draft).toBeDefined())
    act(() => form.result.current.setDraft({ name: 'mine' }))
    const rejected = Object.assign(new Error('stale'), { code: 'REVISION_CONFLICT', status: 409 })
    await act(async () => { await form.result.current.save(async () => { throw rejected }) })
    expect(form.result.current.uncertain).toBe(false)
    expect(form.result.current.error).toBe('stale')
    expect(form.result.current.draft?.name).toBe('mine')
  })
  it('never lets old acknowledgments repopulate cleared or changed-access forms', async () => {
    const form = mount()
    await waitFor(() => expect(form.result.current.draft).toBeDefined())
    const pending = rejectableDeferred<{ value: Value; revision: number }>()
    let work!: Promise<boolean>
    act(() => { work = form.result.current.save(() => pending.promise) })
    act(() => { beginSessionChange(); clearRevisionedFormPersistence(); finishSessionChange() })
    await act(async () => { pending.resolve({ value: { name: 'secret old data' }, revision: 10 }); expect(await work).toBe(false) })
    const fresh = mount()
    await waitFor(() => expect(fresh.result.current.draft).toEqual(initial.value))
  })
  it('keeps a dirty base on refetch, then adopts the newest snapshot after reverting', async () => {
    const form = renderHook(({ revision, name }) => useRevisionedForm({ value: { name }, revision }, 'revert'), { initialProps: { revision: 1, name: 'a' } })
    await waitFor(() => expect(form.result.current.draft?.name).toBe('a'))
    act(() => form.result.current.setDraft({ name: 'mine' }))
    form.rerender({ revision: 2, name: 'external' })
    await waitFor(() => expect(form.result.current.conflicted).toBe(true))
    act(() => form.result.current.setDraft({ name: 'a' }))
    await waitFor(() => expect(form.result.current.draft?.name).toBe('external'))
    expect(form.result.current.baseRevision).toBe(2)
  })
})
