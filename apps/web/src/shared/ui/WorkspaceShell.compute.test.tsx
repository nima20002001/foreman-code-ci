import { act, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { renderWithRouter } from '../../test/renderWithRouter'
import { useNavigationUiStore } from '../../features/workspaces/navigationUiStore'
import { WorkspaceShell } from './WorkspaceShell'

afterEach(() => act(() => useNavigationUiStore.getState().setCollapsed(false)))

it.each([false, true])('places both harness logos with Settings, the memory board and theme controls, collapsed=%s', async collapsed => {
  act(() => useNavigationUiStore.getState().setCollapsed(collapsed))
  renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)
  const sidebar = await screen.findByRole('complementary', { name: 'Primary navigation' })
  const settings = within(sidebar).getByRole('button', { name: 'Settings' })
  const preferences = settings.parentElement!
  expect(within(preferences).getByRole('button', { name: /Switch to .* theme/ })).toBeInTheDocument()
  expect(await within(preferences).findByRole('button', { name: /^Claude:/ })).toBeVisible()
  expect(within(preferences).getByRole('button', { name: /^Codex:/ })).toBeVisible()
  expect(within(preferences).getByRole('button', { name: 'Workspace memory board' })).toBeVisible()
  expect(within(preferences).getAllByRole('button')).toHaveLength(5)
})
