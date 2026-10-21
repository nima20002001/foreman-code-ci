// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeCurrentWorkflowFixture, WorkflowDefinitionV3Schema, type WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import userEvent from '@testing-library/user-event'
import { IntervalFields } from './IntervalFields'
import { intervalLabel } from './intervalLabel'

afterEach(cleanup)

function mount() {
  const graphs: WorkflowDefinitionV3[] = []
  function Harness() {
    const [graph, setGraph] = useState<WorkflowDefinitionV3>(() => makeCurrentWorkflowFixture('interval-ui').version.definition)
    graphs.push(graph)
    return <IntervalFields node={graph.nodes[0]!} change={(update) => setGraph(update)} />
  }
  render(<Harness />)
  return { saved: () => WorkflowDefinitionV3Schema.parse(graphs.at(-1)).nodes[0]! }
}

describe('Agent loops in node settings', () => {
  it('is off by default, then saves the period the author chooses and clears it when turned off', async () => {
    const { saved } = mount()
    const toggle = screen.getByRole('switch', { name: /Loop while the workflow runs/ })
    expect(screen.queryByText(/Loops never hand off work or use maximum parallelism slots/)).not.toBeInTheDocument()
    const user = userEvent.setup()
    const hint = screen.getByRole('button', { name: 'About Loop while the workflow runs' })
    await user.hover(hint)
    expect(screen.getByRole('tooltip')).toHaveTextContent(/Loops never hand off work or use maximum parallelism slots/)
    await user.unhover(hint)
    expect(toggle).not.toBeChecked()
    expect(screen.queryByLabelText('Every')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Each loop')).not.toBeInTheDocument()
    expect(saved()).not.toHaveProperty('interval')

    fireEvent.click(toggle)
    expect(saved()).toMatchObject({ interval: { everySeconds: 60 } })
    expect(screen.getByLabelText('Every')).toHaveValue(1)
    expect(screen.getByLabelText('Unit')).toHaveValue('minutes')

    fireEvent.change(screen.getByLabelText('Every'), { target: { value: '5' } })
    expect(saved()).toMatchObject({ interval: { everySeconds: 300 } })
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'hours' } })
    expect(saved()).toMatchObject({ interval: { everySeconds: 18_000 } })

    // Out of range values stay visible as an error and never replace the saved period.
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'seconds' } })
    expect(screen.getByText('Choose between 10 seconds and 24 hours.')).toBeVisible()
    expect(saved()).toMatchObject({ interval: { everySeconds: 18_000 } })
    fireEvent.change(screen.getByLabelText('Every'), { target: { value: '30' } })
    expect(saved()).toMatchObject({ interval: { everySeconds: 30 } })

    // The loop prompt is saved trimmed with the period; an empty prompt uses the default Run check.
    fireEvent.change(screen.getByLabelText('Each loop'), { target: { value: ' Check the deploy log. ' } })
    expect(saved()).toMatchObject({ interval: { everySeconds: 30, prompt: 'Check the deploy log.' } })
    fireEvent.change(screen.getByLabelText('Every'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'minutes' } })
    expect(saved()).toMatchObject({ interval: { everySeconds: 120, prompt: 'Check the deploy log.' } })
    fireEvent.change(screen.getByLabelText('Each loop'), { target: { value: '  ' } })
    expect(saved()).toEqual(expect.objectContaining({ interval: { everySeconds: 120 } }))

    fireEvent.click(toggle)
    expect(saved()).not.toHaveProperty('interval')
    expect(screen.queryByLabelText('Every')).not.toBeInTheDocument()
  })

  it('names the period on the node card', () => {
    expect([30, 60, 300, 7200].map(intervalLabel)).toEqual(['Every 30 s', 'Every 1 min', 'Every 5 min', 'Every 2 h'])
  })
})
