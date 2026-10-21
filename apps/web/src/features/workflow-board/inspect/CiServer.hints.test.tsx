import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { CiServerDialog } from './CiServer'

it.each([true, false])('keeps the CI empty state and required action visible with Run selected: %s', async selected => {
  render(<CiServerDialog open onOpenChange={vi.fn()} jobs={[]} names={new Map()}
    truncated={false} error={false} loading={false}
    scope={selected ? { workspaceId: 'workspace-a', workflowId: 'workflow-a', runId: 'run-a',
      workflowVersionId: 'version-a', executionSemanticsVersion: 3 } : undefined} />)
  expect(screen.getByText(selected ? 'No CI jobs in this Run yet' : 'No Run selected')).toBeVisible()
  if (!selected) expect(screen.getByText('Start or select a Run.')).toBeVisible()
  expect(screen.queryByText(/when its Agents run CI|When an Agent runs CI/)).not.toBeInTheDocument()
  expect(screen.queryByText(/CI jobs (the Agents|that Agents)/)).not.toBeInTheDocument()
  await userEvent.hover(screen.getByRole('button', { name: 'About CI server' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent('Host CI, GitHub Actions or CircleCI.')
})
