import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fixture } from './core.cases'
import { draftOperations, setWorkConnectionLimit } from './model'
import { WorkConnectionLimitEditor } from './WorkConnectionLimitEditor'

describe('work connection limit staging', () => {
  it('edits the one work relationship through a staged relationship.put without changing the saved base', () => {
    const context = fixture()
    context.draft.graph.handoffs = { contractVersion: 1 }
    const staged = setWorkConnectionLimit(context.draft.graph, 'execution-1', 3)
    expect(staged.edges[0]?.maxWorkHandoffsPerRun).toBe(3)
    expect(context.draft.graph.edges[0]?.maxWorkHandoffsPerRun).toBeUndefined()
    expect(draftOperations(context, staged).filter((operation) => operation.type === 'relationship.put'))
      .toEqual([{ type: 'relationship.put', relationship: staged.edges[0] }])
    expect(setWorkConnectionLimit(staged, 'execution-1').edges[0]?.maxWorkHandoffsPerRun).toBeUndefined()
    expect(() => setWorkConnectionLimit(context.draft.graph, 'missing', 3)).toThrow()
  })

  it('offers blank as unlimited and rejects invalid values before applying', async () => {
    const user = userEvent.setup(), onApply = vi.fn()
    function Form() {
      const [value, setValue] = useState<number | undefined>(3)
      return <WorkConnectionLimitEditor value={value} onApply={(next) => { onApply(next); setValue(next) }} />
    }
    render(<Form />)
    const input = screen.getByLabelText('Maximum work handoffs per Run')
    await user.clear(input)
    await user.type(input, '0')
    await user.click(screen.getByRole('button', { name: 'Apply to draft' }))
    expect(onApply).not.toHaveBeenCalled()
    expect(screen.getByText(/whole number/)).toBeInTheDocument()
    await user.clear(input)
    await user.click(screen.getByRole('button', { name: 'Apply to draft' }))
    expect(onApply).toHaveBeenCalledWith(undefined)
    await user.type(input, '3')
    await user.click(screen.getByRole('button', { name: 'Apply to draft' }))
    expect(onApply).toHaveBeenLastCalledWith(3)
  })
})
