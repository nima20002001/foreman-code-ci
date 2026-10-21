import { screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { renderWithRouter } from '../../test/renderWithRouter'
import { McpConnectionCard } from './McpConnectionCard'
import * as api from '../../shared/api/client'

it('identifies Claude and exposes the native-check limitation without a fallback request', async () => {
  const request = vi.spyOn(api, 'getScopedMcpDetection')
  renderWithRouter(<McpConnectionCard workspaceId="workspace" harness="claude" location={{ runnerId: 'runner-local', rootPath: '/actual/project' }} />)
  expect(await screen.findByRole('article', { name: 'Claude' })).toBeVisible()
  expect(screen.getByText('Claude workspace connection checks are not available here.')).toBeVisible()
  expect(screen.queryByText('Connected')).not.toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Configure Claude MCP' })).toHaveAttribute('href', '/settings/harnesses?harness=claude&section=connections')
  expect(screen.queryByRole('button', { name: /Check setup/ })).not.toBeInTheDocument()
  expect(request).not.toHaveBeenCalled()
})
