import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { WorkflowName } from './WorkflowName'

describe('workflow name', () => {
  it('asks before applying a new name and discards it on request', async () => {
    const user = userEvent.setup(), onRename = vi.fn()
    render(<><WorkflowName name="Tasks" disabled={false} onRename={onRename} /><button>Elsewhere</button></>)
    await user.click(screen.getByRole('button', { name: 'Tasks' }))
    await user.clear(screen.getByRole('textbox', { name: 'Workflow name' }))
    await user.type(screen.getByRole('textbox', { name: 'Workflow name' }), 'Renamed')
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }))
    expect(onRename).not.toHaveBeenCalled()
    await user.click(await screen.findByRole('button', { name: 'Discard' }))
    expect(onRename).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Tasks' }))
    await user.clear(screen.getByRole('textbox', { name: 'Workflow name' }))
    await user.type(screen.getByRole('textbox', { name: 'Workflow name' }), 'Renamed{Enter}')
    expect(screen.getByText('Rename “Tasks” to “Renamed”?')).toBeVisible()
    expect(screen.queryByText('You can undo it with Ctrl+Z; Save keeps it.')).not.toBeInTheDocument()
    await user.hover(screen.getByRole('button', { name: 'About Rename' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent('You can undo it with Ctrl+Z; Save keeps it.')
    await user.click(await screen.findByRole('button', { name: 'Rename' }))
    expect(onRename).toHaveBeenCalledWith('Renamed')
  })
})
