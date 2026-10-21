// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearRevisionedFormPersistence, useRevisionedForm, type Snapshot } from './revisionedForm'
import { FieldValidationError } from './fieldValidation'

afterEach(() => { cleanup(); clearRevisionedFormPersistence() })
describe('PR17 revisioned settings feedback', () => {
  it('reports a saved revision without replacing newer edits', async () => {
    const { result } = renderHook(() => useRevisionedForm({ value: { model: 'base' }, revision: 1 }, 'saved-feedback'))
    await waitFor(() => expect(result.current.draft).toEqual({ model: 'base' }))
    act(() => result.current.setDraft({ model: 'submitted' }))
    let resolve!: (value: Snapshot<{ model: string }>) => void
    const perform = vi.fn(() => new Promise<Snapshot<{ model: string }>>((done) => { resolve = done }))
    let saving!: Promise<boolean>
    act(() => { saving = result.current.save(perform) })
    act(() => result.current.setDraft({ model: 'newer' }))
    act(() => result.current.reset())
    expect(result.current.draft).toEqual({ model: 'newer' })
    await act(async () => { resolve({ value: { model: 'submitted' }, revision: 2 }); await saving })
    expect(result.current.savedRevision).toBe(2)
    expect(result.current.isDirty).toBe(true)
    expect(result.current.draft).toEqual({ model: 'newer' })
  })
  it('reapplies only explicit local edits to current defaults without saving automatically', async () => {
    const { result, rerender } = renderHook(({ incoming }) => useRevisionedForm(incoming, 'reapply-feedback'), {
      initialProps: { incoming: { value: { model: 'base', effort: 'low' }, revision: 1 } },
    })
    await waitFor(() => expect(result.current.draft?.model).toBe('base'))
    act(() => result.current.setDraft({ model: 'mine', effort: 'low' }))
    rerender({ incoming: { value: { model: 'theirs', effort: 'high' }, revision: 2 } })
    await waitFor(() => expect(result.current.conflicted).toBe(true))
    expect(result.current.serverChanges.map((change) => change.path)).toEqual(['model', 'effort'])
    act(() => result.current.reapply())
    expect(result.current.draft).toEqual({ model: 'mine', effort: 'high' })
    expect(result.current.baseRevision).toBe(2)
    expect(result.current.isDirty).toBe(true)
    expect(result.current.savedRevision).toBeUndefined()
  })
  it('keeps validation paths and does not send an invalid draft', async () => {
    const { result } = renderHook(() => useRevisionedForm({ value: { model: 'base' }, revision: 1 }, 'validation-feedback'))
    await waitFor(() => expect(result.current.draft).toBeDefined())
    act(() => result.current.setDraft({ model: '' }))
    const perform = vi.fn()
    await act(async () => { await result.current.save(perform, () => { throw new FieldValidationError([{ path: ['model'], message: 'Enter a model.' }]) }) })
    expect(perform).not.toHaveBeenCalled()
    expect(result.current.issues).toEqual([{ path: ['model'], message: 'Enter a model.' }])
    expect(result.current.error).toBe('Review the marked fields before saving.')
    act(() => result.current.reset())
    expect(result.current.draft).toEqual({ model: 'base' })
    expect(result.current.issues).toBeUndefined()
  })
})
