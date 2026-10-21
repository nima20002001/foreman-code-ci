import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceDefaultsSettings } from './WorkspaceDefaultsSettings'
import { clearRevisionedFormPersistence } from './revisionedForm'
import { resetSettingsExperienceFixtures } from '../../shared/mocks/settingsExperienceHandlers'
import { server } from '../../mocks/server'
import { ToastProvider } from '../../shared/ui/nocturne'

vi.mock('@tanstack/react-router', () => ({ Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a> }))
const clients: QueryClient[]=[]
beforeEach(resetSettingsExperienceFixtures)
afterEach(()=>{cleanup();clearRevisionedFormPersistence();for(const client of clients.splice(0))client.clear()})
describe('Workspace defaults',()=>{
  it('saves creation suggestions through the shared API without showing a default root grant',async()=>{
    server.use(http.get('/api/management/harnesses/directories', () => HttpResponse.json({
      roots: [{ id: 'projects', label: 'Projects', path: '/projects' }], rootId: 'projects', path: '/projects',
      parent: null, directories: [], nextCursor: null,
    })))
    const client=new QueryClient({defaultOptions:{queries:{retry:false}}});clients.push(client)
    render(<QueryClientProvider client={client}><ToastProvider><WorkspaceDefaultsSettings /></ToastProvider></QueryClientProvider>)
    const user=userEvent.setup();const name=await screen.findByRole('textbox',{name:'Suggested workspace name'})
    await user.clear(name);await user.type(name,'New project')
    const description=screen.getByRole('textbox',{name:'Starting description'});await user.type(description,'A shared project workspace.')
    const location=screen.getByRole('button',{name:'Default location'});await user.click(location)
    await waitFor(()=>expect(screen.getByRole('button',{name:'Select location'})).toBeEnabled())
    await user.click(screen.getByRole('button',{name:'Select location'}))
    await user.click(screen.getByRole('button',{name:'Save workspace defaults'}))
    await waitFor(()=>expect(screen.getByRole('button',{name:'Save workspace defaults'})).toBeDisabled())
    expect(await screen.findByText('Changes saved to the server')).toBeVisible()
    const settings = within(screen.getByRole('region', { name: 'Workspace defaults' }))
    expect(settings.queryByText('Changes are saved to the server.')).not.toBeInTheDocument()
    const notifications = within(screen.getByRole('list', { name: 'Notifications' }))
    expect(notifications.getByText('Workspace defaults saved')).toBeVisible()
    expect(notifications.queryByText('Changes are saved to the server.')).not.toBeInTheDocument()
    expect(location.parentElement).toHaveTextContent('/projects')
    expect(name).toHaveValue('New project');expect(description).toHaveValue('A shared project workspace.')
    expect(screen.queryByLabelText(/Root path|Sandbox|Runner/)).not.toBeInTheDocument()
  })

  it('shows a save failure and keeps the unsaved edit', async () => {
    server.use(http.put('/api/management/settings/workspaces', () => HttpResponse.json({
      error: { code: 'SAVE_REJECTED', message: 'The server rejected the change.' },
    }, { status: 400 })))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
    render(<QueryClientProvider client={client}><ToastProvider><WorkspaceDefaultsSettings /></ToastProvider></QueryClientProvider>)
    const user = userEvent.setup()
    const name = await screen.findByRole('textbox', { name: 'Suggested workspace name' })
    await user.clear(name); await user.type(name, 'Unsaved project')
    await user.click(screen.getByRole('button', { name: 'Save workspace defaults' }))
    expect(await screen.findByText('Changes were not saved')).toBeVisible()
    expect(screen.getByText('Could not save workspace defaults')).toBeVisible()
    expect(screen.getByText(/The server rejected the change. Your edits are still here./)).toBeVisible()
    expect(name).toHaveValue('Unsaved project')
  })
})
