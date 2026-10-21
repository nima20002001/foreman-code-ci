import { WorkflowExecutionPolicySchema } from '@foreman-code/contracts'
import { z } from 'zod'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError } from '../../../shared/api/client'
import { WorkflowSaveError } from './WorkflowSaveError'

afterEach(cleanup)
it('lists separate fixes and preserves their field targets', async () => {
  const openField = vi.fn()
  render(<WorkflowSaveError pending={false} openField={openField} error={new ApiError({
    code: 'GRAPH_INVALID', message: 'Fix the workflow settings below.', details: { issues: [
      { code: 'ORCHESTRATOR_REQUIRED', path: ['approval', 'designatedOrchestratorAgentId'], message: 'Choose a reviewing orchestrator.' },
      { code: 'EXECUTION_LIMIT_TOO_LOW', path: ['executionPolicy', 'maxNodeExecutions'], message: 'Increase “Maximum node executions” to at least 3.', minimum: 3, actual: 1 },
    ] },
  }, 409)} />)
  expect(screen.getByText('Can’t save — fix 2 settings')).toBeVisible()
  const items = screen.getAllByRole('listitem'), user = userEvent.setup()
  await user.click(within(items[0]!).getByRole('button'))
  expect(openField).toHaveBeenLastCalledWith(['approval', 'designatedOrchestratorAgentId'])
  await user.click(within(items[1]!).getByRole('button'))
  expect(openField).toHaveBeenLastCalledWith(['executionPolicy', 'maxNodeExecutions'])
  expect(screen.queryByText('Fix the workflow settings below.')).not.toBeInTheDocument()
})
it.each([
  [new ApiError({ code: 'ACCESS_DENIED', message: 'Internal permission error' }, 403), false, 'You can’t save this workflow.'],
  [new ApiError({ code: 'REVISION_CONFLICT', message: 'Internal revision error' }, 409), false, 'The workflow changed.'],
  [new ApiError({ code: 'NETWORK_ERROR', message: 'Network failed' }, 0), true, 'Save not confirmed.'],
  [new ApiError({ code: 'INVALID_RESPONSE', message: 'Malformed response' }, 200), true, 'Save not confirmed.'],
] as const)('distinguishes save outcome %#', (error, pending, title) => {
  render(<WorkflowSaveError error={error} pending={pending} openField={vi.fn()} />)
  expect(screen.getByText(title)).toBeVisible()
  expect(screen.queryByText(error.message)).not.toBeInTheDocument()
})

it('explains empty local limit fields without dumping schema errors', () => {
  const result = z.object({ executionPolicy: WorkflowExecutionPolicySchema }).safeParse({
    executionPolicy: { maxParallelism: Number.NaN, maxNodeExecutions: 0 },
  })
  if (result.success) throw new Error('Expected invalid limits')
  render(<WorkflowSaveError error={result.error} pending={false} openField={vi.fn()} />)
  expect(screen.getByText('Can’t save — fix 2 settings')).toBeVisible()
  expect(screen.getByText('Enter a positive whole number for “Maximum parallelism”.')).toBeVisible()
  expect(screen.getByText('Enter a positive whole number for “Maximum node executions”.')).toBeVisible()
})

it('explains an invalid active-time budget and targets the workflow setting', async () => {
  const result = z.object({ executionPolicy: WorkflowExecutionPolicySchema }).safeParse({
    executionPolicy: { maxParallelism: 2, maxNodeExecutions: 8, agentActiveTimeoutMs: 0 },
  })
  if (result.success) throw new Error('Expected an invalid active-time budget')
  const openField = vi.fn()
  render(<WorkflowSaveError error={result.error} pending={false} openField={openField} />)
  expect(screen.getByText('Can’t save — fix 1 setting')).toBeVisible()
  expect(screen.getByText(/Enter an Agent active-time budget.*leave it blank for the server default/)).toBeVisible()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Fix setting' }))
  expect(openField).toHaveBeenCalledWith(['executionPolicy', 'agentActiveTimeoutMs'])
})
