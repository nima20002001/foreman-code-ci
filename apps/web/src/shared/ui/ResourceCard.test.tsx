import { createRef, useState } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { ResourceActionsMenu, ResourceCard, TrashIconButton } from './ResourceCard'

it('keeps opening and actions separate, including keyboard activation and supplied link attributes', async () => {
  const user = userEvent.setup()
  const remove = vi.fn()
  render(<ResourceCard name="Website" icon="folder" open={<a href="/website" target="_blank" rel="noopener" />}
    actions={<TrashIconButton target="folder Website" onClick={remove} />} />)
  const link = screen.getByRole('link', { name: 'Website' })
  const action = screen.getByRole('button', { name: 'Delete folder Website' })
  expect(link).toHaveAttribute('href', '/website')
  expect(link).toHaveAttribute('target', '_blank')
  expect(link).toHaveAttribute('title', 'Website')
  expect(link).not.toContainElement(action)
  await user.tab()
  expect(link).toHaveFocus()
  await user.tab()
  expect(action).toHaveFocus()
  await user.keyboard('{Enter}')
  expect(remove).toHaveBeenCalledOnce()
})

it('uses native controlled selection without exposing opening or deletion in selection mode', async () => {
  function SelectedCard() {
    const [checked, setChecked] = useState(false)
    return <ResourceCard name="Research" icon="workflow" open={<a href="/research" />}
      actions={<TrashIconButton target="Research" />} selection={{ checked, 'aria-label': 'Select Research', onChange: (event) => setChecked(event.target.checked) }} />
  }
  render(<SelectedCard />)
  const checkbox = screen.getByRole('checkbox', { name: 'Select Research' })
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  const user = userEvent.setup()
  await user.tab()
  expect(checkbox).toHaveFocus()
  await user.keyboard(' ')
  expect(checkbox).toBeChecked()
  expect(checkbox.closest('.resource-card')).toHaveClass('is-selected')
})

it('supports a caller-owned open action and its native disabled state', async () => {
  const open = vi.fn()
  const { rerender } = render(<ResourceCard name="Archive" icon="folder" open={<button type="button" onClick={open} disabled />} />)
  expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled()
  await userEvent.click(screen.getByRole('button', { name: 'Archive' }))
  expect(open).not.toHaveBeenCalled()
  rerender(<ResourceCard name="Archive" icon="folder" open={<button type="button" onClick={open} />} />)
  await userEvent.click(screen.getByRole('button', { name: 'Archive' }))
  expect(open).toHaveBeenCalledOnce()
})

it('keeps a compact hover checkbox keyboard reachable without activating the open action or card', async () => {
  const open = vi.fn()
  const cardClick = vi.fn()
  function HoverCard() {
    const [checked, setChecked] = useState(false)
    return <ResourceCard name="Website" icon="folder" onClick={cardClick} open={<button type="button" onClick={open} />}
      actions={<TrashIconButton target="Website" />} selection={{ mode: checked ? 'visible' : 'hover', checked,
        'aria-label': 'Select Website', onChange: (event) => setChecked(event.target.checked) }} />
  }
  render(<HoverCard />)
  const checkbox = screen.getByRole('checkbox', { name: 'Select Website' })
  const user = userEvent.setup()
  await user.tab()
  expect(checkbox).toHaveFocus()
  await user.keyboard(' ')
  expect(checkbox).toBeChecked()
  expect(open).not.toHaveBeenCalled()
  expect(cardClick).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Website' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Delete Website' })).toBeVisible()
  expect(checkbox.closest('.resource-card')).toHaveClass('is-selecting')
})

it('exposes protection and disables deletion with an accessible reason and caller descriptions', async () => {
  const remove = vi.fn()
  const ref = createRef<HTMLButtonElement>()
  render(<><p id="context">Runner folder</p><ResourceCard name="Shared" icon="folder"
    protection={{ label: 'Protected folder. In use by a workspace', reason: 'In use by a workspace' }}
    actions={<TrashIconButton ref={ref} target="folder Shared" disabledReason="In use by a workspace"
      aria-describedby="context" onClick={remove} />} /></>)
  const action = screen.getByRole('button', { name: 'Delete folder Shared' })
  expect(action).toBeDisabled()
  expect(action).toHaveAttribute('title', 'In use by a workspace')
  expect(action).toHaveAccessibleDescription('Runner folder In use by a workspace')
  expect(ref.current).toBe(action)
  expect(screen.getByRole('img', { name: 'Protected folder. In use by a workspace' })).toHaveAttribute('title', 'In use by a workspace')
  await userEvent.click(action)
  expect(remove).not.toHaveBeenCalled()
})

it('gives every card the same actions menu that opens, closes on Escape and outside presses, and respects disabled', async () => {
  const user = userEvent.setup()
  function Harness({ disabled = false }: { disabled?: boolean }) {
    const [open, setOpen] = useState(false)
    return <><ResourceCard name="Website" icon="folder" actions={<ResourceActionsMenu name="Website" open={open} onOpenChange={setOpen} disabled={disabled}>
      <button type="button">Rename</button>
    </ResourceActionsMenu>} /><p>Outside</p></>
  }
  const { unmount } = render(<Harness />)
  const trigger = screen.getByRole('button', { name: 'Open actions for Website' })
  await user.click(trigger)
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  expect(within(screen.getByRole('dialog', { name: 'Website actions' })).getByRole('button', { name: 'Rename' })).toBeVisible()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog', { name: 'Website actions' })).not.toBeInTheDocument()
  await user.click(trigger)
  await user.click(screen.getByText('Outside'))
  expect(screen.queryByRole('dialog', { name: 'Website actions' })).not.toBeInTheDocument()
  unmount()
  render(<Harness disabled />)
  expect(screen.getByRole('button', { name: 'Open actions for Website' })).toBeDisabled()
})
