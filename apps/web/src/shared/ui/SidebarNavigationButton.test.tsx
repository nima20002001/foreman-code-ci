import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithRouter } from '../../test/renderWithRouter'
import { SidebarNavigationButton } from './SidebarNavigationButton'

afterEach(() => vi.restoreAllMocks())

describe('SidebarNavigationButton', () => {
  it.each(['click', 'Enter', 'Space'])('navigates through the router on %s', async activation => {
    const user = userEvent.setup()
    const { router } = renderWithRouter(<SidebarNavigationButton to="/settings">Settings</SidebarNavigationButton>)
    const button = await screen.findByRole('button', { name: 'Settings' })
    expect(button).toHaveAttribute('type', 'button')
    expect(button).not.toHaveAttribute('href')
    if (activation === 'click') await user.click(button)
    else {
      button.focus()
      await user.keyboard(activation === 'Enter' ? '{Enter}' : ' ')
    }
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
  })

  it.each(['ctrlKey', 'metaKey', 'middle'])('opens the resolved route in a new tab on %s', async activation => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const { router } = renderWithRouter(
      <SidebarNavigationButton to="/workspaces/$workspaceId" params={{ workspaceId: 'workspace-example' }}
        search={{ workflowId: 'workflow-example' }}>Workflow</SidebarNavigationButton>,
    )
    const button = await screen.findByRole('button', { name: 'Workflow' })
    if (activation === 'middle') fireEvent(button, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    else fireEvent.click(button, { [activation]: true })
    expect(open).toHaveBeenCalledExactlyOnceWith(
      '/workspaces/workspace-example?workflowId=workflow-example', '_blank', 'noopener',
    )
    expect(router.state.location.pathname).toBe('/')
    fireEvent(button, new MouseEvent('auxclick', { bubbles: true, button: 2 }))
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('preserves hover and focus prefetch and keyboard focus order', async () => {
    const user = userEvent.setup()
    const hover = vi.fn()
    const focus = vi.fn()
    const { router } = renderWithRouter(<>
      <SidebarNavigationButton to="/settings" preload="intent" preloadDelay={0}
        onMouseEnter={hover} onFocus={focus}>Settings</SidebarNavigationButton>
      <SidebarNavigationButton to="/workspaces">Workspaces</SidebarNavigationButton>
    </>)
    const button = await screen.findByRole('button', { name: 'Settings' })
    const preload = vi.spyOn(router, 'preloadRoute')
    await user.hover(button)
    await waitFor(() => expect(preload).toHaveBeenCalledWith(expect.objectContaining({ to: '/settings' })))
    expect(hover).toHaveBeenCalledTimes(1)
    preload.mockClear()
    await user.tab()
    expect(button).toHaveFocus()
    expect(focus).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(preload).toHaveBeenCalledWith(expect.objectContaining({ to: '/settings' })))
    await user.tab()
    expect(screen.getByRole('button', { name: 'Workspaces' })).toHaveFocus()
  })

  it('keeps aria-current for the active route', async () => {
    renderWithRouter(<SidebarNavigationButton to="/" activeOptions={{ exact: true }}>Home</SidebarNavigationButton>)
    expect(await screen.findByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page')
  })
})
