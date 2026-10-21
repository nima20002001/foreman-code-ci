import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import { InfoHint } from './index'

it('reveals an accessible explanation on hover and keyboard focus without submitting its form', async () => {
  const user = userEvent.setup()
  let submissions = 0
  render(<form onSubmit={(event) => { event.preventDefault(); submissions++ }}>
    <InfoHint label="Reviewing orchestrator">The starting orchestrator reviews requests.</InfoHint>
  </form>)
  const hint = screen.getByRole('button', { name: 'About Reviewing orchestrator' })
  expect(screen.queryByText('The starting orchestrator reviews requests.')).not.toBeInTheDocument()
  await user.hover(hint)
  const tooltip = screen.getByRole('tooltip')
  expect(tooltip).toHaveTextContent('The starting orchestrator reviews requests.')
  expect(hint).toHaveAttribute('aria-describedby', tooltip.id)
  expect(hint).toHaveAccessibleDescription('The starting orchestrator reviews requests.')
  await user.unhover(hint)
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  await user.tab()
  expect(hint).toHaveFocus()
  expect(screen.getByRole('tooltip')).toHaveTextContent('The starting orchestrator reviews requests.')
  expect(hint).toHaveAccessibleDescription('The starting orchestrator reviews requests.')
  await user.keyboard('{Enter}')
  expect(submissions).toBe(0)
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
})
