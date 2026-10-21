import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import userEvent from '@testing-library/user-event'
import type { WorkflowExecutionPolicy } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { AgentActiveTimeField } from './AgentActiveTimeField'
import { LocalWorkflowFormSchema } from './localGraph'

afterEach(cleanup)

it('edits seconds, preserves other limits, and clears the override to inherit the default', async () => {
  const changes: WorkflowExecutionPolicy[] = []
  function Form() {
    const [policy, setPolicy] = useState<WorkflowExecutionPolicy>({ maxParallelism: 2, maxNodeExecutions: 8 })
    return <AgentActiveTimeField policy={policy} defaultMs={600_000}
      onChange={(next) => { changes.push(next); setPolicy(next) }} />
  }
  render(<Form />)
  const field = screen.getByRole('spinbutton', { name: 'Agent active-time budget (seconds)' })
  expect(field).toHaveValue(null)
  expect(screen.queryByText(/server default \(600 seconds\)/)).not.toBeInTheDocument()
  await userEvent.setup().hover(screen.getByRole('button', { name: 'About Agent active-time budget (seconds)' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent(/server default \(600 seconds\)/)
  fireEvent.change(field, { target: { value: '3600' } })
  expect(field).toHaveValue(3600)
  expect(changes.at(-1)).toEqual({ maxParallelism: 2, maxNodeExecutions: 8, agentActiveTimeoutMs: 3_600_000 })
  fireEvent.change(field, { target: { value: '1.005' } })
  expect(field).toHaveValue(1.005)
  expect(changes.at(-1)?.agentActiveTimeoutMs).toBe(1005)
  fireEvent.change(field, { target: { value: '' } })
  expect(changes.at(-1)).toEqual({ maxParallelism: 2, maxNodeExecutions: 8 })
})

it('describes default inheritance before capabilities finish loading', async () => {
  render(<AgentActiveTimeField policy={{ maxParallelism: 2, maxNodeExecutions: 8 }}
    defaultMs={undefined} onChange={() => {}} />)
  expect(screen.queryByText(/Leave blank to use the server default\./)).not.toBeInTheDocument()
  await userEvent.setup().hover(screen.getByRole('button', { name: 'About Agent active-time budget (seconds)' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent(/Leave blank to use the server default\./)
  expect(screen.getByRole('spinbutton', { name: 'Agent active-time budget (seconds)' })).toHaveValue(null)
})

it('restores a saved override and retains unfinished invalid values in local drafts', () => {
  const graph = makeCurrentWorkflowFixture('active-time-form').version.definition
  graph.executionPolicy!.agentActiveTimeoutMs = 3_600_000
  const restored = LocalWorkflowFormSchema.parse(JSON.parse(JSON.stringify(graph)))
  render(<AgentActiveTimeField policy={restored.executionPolicy!} defaultMs={300_000} onChange={() => {}} />)
  expect(screen.getByRole('spinbutton', { name: 'Agent active-time budget (seconds)' })).toHaveValue(3600)
  expect(LocalWorkflowFormSchema.parse({ ...graph, executionPolicy: {
    ...graph.executionPolicy, agentActiveTimeoutMs: 0,
  } }).executionPolicy?.agentActiveTimeoutMs).toBe(0)
})
