import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { AgentChatHeader } from './AgentChatHeader'

it('groups the title, context meter and close action in the chat navigation row', () => {
  const close = vi.fn()
  render(<AgentChatHeader name="Coder" state="Completed" onClose={close}
    controls={<button type="button">Context usage 25%</button>} />)
  const navigation = screen.getByRole('navigation', { name: 'Coder chat controls' })
  expect(within(navigation).getByRole('heading', { name: 'Coder' })).toBeVisible()
  expect(within(navigation).getByRole('button', { name: 'Context usage 25%' })).toBeVisible()
  fireEvent.click(within(navigation).getByRole('button', { name: 'Close Coder' }))
  expect(close).toHaveBeenCalledOnce()
  expect(screen.getByRole('status', { name: 'Agent state' })).toHaveTextContent('Completed')
  expect(screen.queryByText('Agent')).not.toBeInTheDocument()
})
