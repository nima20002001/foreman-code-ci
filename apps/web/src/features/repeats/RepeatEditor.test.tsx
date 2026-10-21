import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import { makeCurrentWorkflowFixture, type WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { RepeatEditor } from './RepeatEditor'

it('shows repeat guidance on demand while keeping validation and the cap target visible', async () => {
  function Editor() {
    const [graph, setGraph] = useState<WorkflowDefinitionV3>(() => makeCurrentWorkflowFixture('repeat-help').version.definition)
    return <RepeatEditor graph={graph} change={setGraph} />
  }
  render(<Editor />)
  const user = userEvent.setup()
  expect(screen.getByText('No repeats.')).toBeVisible()
  expect(screen.queryByText('Repeat a section up to a chosen limit.')).not.toBeInTheDocument()
  expect(screen.queryByText('Repeat help')).not.toBeInTheDocument()
  const hint = screen.getByRole('button', { name: 'About Repeats' })
  await user.hover(hint)
  expect(screen.getByRole('tooltip')).toHaveTextContent('Sections cannot overlap or nest.')
  await user.unhover(hint)
  await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  await user.click(screen.getByRole('button', { name: 'Add repeat' }))
  expect(screen.getByRole('spinbutton', { name: 'Maximum occurrences' })).toHaveValue(2)
  expect(screen.getByLabelText('Problems in repeat 1')).toBeVisible()
  expect(screen.getByText('At the cap')).toBeVisible()
  expect(screen.queryByText('Includes the first run through this section.')).not.toBeInTheDocument()
  await user.hover(screen.getByRole('button', { name: 'About Maximum occurrences' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent('Includes the first run through this section.')
})
