import { createMemoryHistory, createRouter } from '@tanstack/react-router'
import { expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { routeTree } from './router'
import { renderWithRouter } from '../test/renderWithRouter'
import { WorkspaceShell } from '../shared/ui/WorkspaceShell'

it.each(['jobs', 'jobs/execution-id', 'jobs/definitions/saved-id'])('redirects old %s links to their workspace', async path => {
  const router = createRouter({ routeTree,
    history: createMemoryHistory({ initialEntries: [`/workspaces/workspace-1/${path}`] }) })
  await router.load()
  expect(router.state.location.pathname).toBe('/workspaces/workspace-1')
  expect(router.history.length).toBe(1)
  router.history.destroy()
})

it('keeps workspace navigation without a human Jobs destination', async () => {
  const { queryClient } = renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)
  expect(await screen.findByRole('button', { name: 'Workflows' })).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'Jobs' })).toBeNull()
  queryClient.clear()
})
