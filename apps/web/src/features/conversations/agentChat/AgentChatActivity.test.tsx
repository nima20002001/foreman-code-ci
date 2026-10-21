import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentChatActivity } from './AgentChatActivity'

afterEach(cleanup)

it('renders tool details only after the activity is expanded', async () => {
  const onBrowse = vi.fn()
  render(<AgentChatActivity onBrowse={onBrowse} entry={{ kind: 'tool', title: 'pnpm build', status: 'completed',
    input: 'pnpm build', output: 'Built 42 files.', truncated: false }} />)
  expect(screen.queryByLabelText('Output')).not.toBeInTheDocument()
  await userEvent.click(screen.getByText('Ran pnpm build'))
  expect(onBrowse).toHaveBeenCalledOnce()
  expect(screen.getByLabelText('Output')).toHaveTextContent('Built 42 files.')
  expect(screen.getByLabelText('Input')).toBeVisible()
  await userEvent.click(screen.getByText('Ran pnpm build'))
  expect(screen.queryByLabelText('Output')).not.toBeInTheDocument()
})
