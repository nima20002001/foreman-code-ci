import { createRef } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceLocationCard } from './WorkspaceLocationCard'

const path = '/home/user/.local/share/graphql/workspaces/New workspace(1)'
afterEach(cleanup)

it('activates the compact picker only from its displayed path, not the row or folder icon', async () => {
  const user = userEvent.setup()
  const onChoose = vi.fn()
  render(<WorkspaceLocationCard label="Execution location" path={path} presentation="compact" onChoose={onChoose} />)
  const trigger = screen.getByRole('button', { name: 'Execution location' })
  const row = trigger.parentElement!
  await user.click(row)
  await user.click(row.querySelector('svg')!)
  expect(onChoose).not.toHaveBeenCalled()
  await user.click(screen.getByText(path))
  expect(onChoose).toHaveBeenCalledOnce()
  expect(trigger).toHaveAttribute('aria-description', path)
  expect(trigger).toHaveAttribute('title', path)
})

it('keeps the path keyboard accessible and exposes its trigger for focus return', async () => {
  const user = userEvent.setup()
  const onChoose = vi.fn()
  const triggerRef = createRef<HTMLButtonElement>()
  render(<WorkspaceLocationCard label="Execution location" path={path} presentation="compact" triggerRef={triggerRef} onChoose={onChoose} />)
  await user.tab()
  expect(triggerRef.current).toHaveFocus()
  await user.keyboard('{Enter}')
  await user.keyboard(' ')
  expect(onChoose).toHaveBeenCalledTimes(2)
})

it('keeps disabled compact locations passive for clicks and keyboard navigation', async () => {
  const user = userEvent.setup()
  const onChoose = vi.fn()
  render(<WorkspaceLocationCard label="Execution location" path={path} presentation="compact" disabled onChoose={onChoose} />)
  const trigger = screen.getByRole('button', { name: 'Execution location' })
  expect(trigger).toBeDisabled()
  await user.click(screen.getByText(path))
  await user.tab()
  expect(trigger).not.toHaveFocus()
  await user.keyboard('{Enter} ')
  expect(onChoose).not.toHaveBeenCalled()
})
