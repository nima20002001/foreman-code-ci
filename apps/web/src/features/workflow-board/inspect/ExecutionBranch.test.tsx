import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { RunExecutionSummary } from '@foreman-code/contracts/wave25'
import { ExecutionBranch } from './ExecutionBranch'

const base = { executionId: 'execution-1', workflowNodeId: 'coder', agentId: 'coder', agentConfigurationVersionId: 'coder-v1',
  attempt: 1, state: 'running', createdAt: '2026-10-07T00:00:00.000Z', acceptedResultAvailable: false } as RunExecutionSummary

it('shows the branch an Agent works on and nothing when its workspace has no repository', () => {
  const { rerender } = render(<ExecutionBranch execution={{ ...base,
    worktree: { repository: 'octo/site', branch: 'foreman/review/coder-1a2b3c4d' } } as RunExecutionSummary} />)
  expect(screen.getByText('foreman/review/coder-1a2b3c4d')).toBeInTheDocument()
  expect(screen.getByText(/octo\/site/)).toBeInTheDocument()
  rerender(<ExecutionBranch execution={base} />)
  expect(screen.queryByText(/Branch/)).toBeNull()
})
