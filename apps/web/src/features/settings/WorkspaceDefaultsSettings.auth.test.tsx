import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { DEFAULT_WORKSPACE_DEFAULTS } from '@foreman-code/contracts/management'
import type { ReactNode } from 'react'
import { server } from '../../mocks/server'
import { settingsExperienceKeys } from '../../shared/api/settingsExperience'
import { WorkspaceDefaultsSettings } from './WorkspaceDefaultsSettings'
import { clearRevisionedFormPersistence } from './revisionedForm'

vi.mock('@tanstack/react-router', async () => ({
  ...await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router'),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}))
const clients: QueryClient[] = []
const defaults = { value: DEFAULT_WORKSPACE_DEFAULTS, revision: 0, versionId: null }
function failure(status: number) { return HttpResponse.json({ error: { code: 'READ_FAILED', message: 'Request failed.' } }, { status }) }
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><WorkspaceDefaultsSettings /></QueryClientProvider>)
  return client
}
beforeEach(() => clearRevisionedFormPersistence())
afterEach(() => { cleanup(); clearRevisionedFormPersistence(); clients.splice(0).forEach((client) => client.clear()) })

describe('Workspace defaults API access states', () => {
  it.each([401, 403, 503])('distinguishes an initial %s response', async (status) => {
    server.use(http.get('*/api/management/settings/workspaces', () => failure(status)))
    mount()
    const title = [401, 403].includes(status) ? 'Access unavailable' : 'Workspace defaults are unavailable'
    expect(await screen.findByText(title)).toBeVisible()
    expect(screen.queryByLabelText('Suggested workspace name')).not.toBeInTheDocument()
  })
  it.each([401, 403])('hides a retained draft after a refresh returns %s', async (status) => {
    server.use(http.get('*/api/management/settings/workspaces', () => HttpResponse.json(defaults)))
    const client = mount()
    const user = userEvent.setup()
    const name = await screen.findByLabelText('Suggested workspace name')
    await user.clear(name); await user.type(name, 'Unsaved protected draft')
    server.use(http.get('*/api/management/settings/workspaces', () => failure(status)))
    await client.invalidateQueries({ queryKey: settingsExperienceKeys.workspaceDefaults() })
    expect(await screen.findByText('Access unavailable')).toBeVisible()
    expect(screen.queryByDisplayValue('Unsaved protected draft')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save workspace defaults' })).not.toBeInTheDocument()
    server.use(http.get('*/api/management/settings/workspaces', () => failure(503)))
    await client.invalidateQueries({ queryKey: settingsExperienceKeys.workspaceDefaults() })
    expect(screen.queryByDisplayValue('Unsaved protected draft')).not.toBeInTheDocument()
    expect(screen.getByText('Access unavailable')).toBeVisible()
  })
  it('keeps unsaved edits during a backend failure rather than sending the owner to sign-in', async () => {
    server.use(http.get('*/api/management/settings/workspaces', () => HttpResponse.json(defaults)))
    const client = mount()
    const user = userEvent.setup()
    const name = await screen.findByLabelText('Suggested workspace name')
    await user.clear(name); await user.type(name, 'Keep my draft')
    server.use(http.get('*/api/management/settings/workspaces', () => failure(503)))
    await client.invalidateQueries({ queryKey: settingsExperienceKeys.workspaceDefaults() })
    expect(await screen.findByText(/Could not refresh. Your edits are kept./)).toBeVisible()
    expect(screen.getByLabelText('Suggested workspace name')).toHaveValue('Keep my draft')
    expect(screen.queryByText('Sign in to continue')).not.toBeInTheDocument()
  })
  it('saves through the API client without login, but hides the form when a write loses permission', async () => {
    server.use(http.get('*/api/management/settings/workspaces', () => HttpResponse.json(defaults)),
      http.put('*/api/management/settings/workspaces', () => failure(403)))
    mount()
    const user = userEvent.setup()
    const name = await screen.findByLabelText('Suggested workspace name')
    await user.clear(name); await user.type(name, 'Rejected change')
    await user.click(screen.getByRole('button', { name: 'Save workspace defaults' }))
    expect(await screen.findByText('Access unavailable')).toBeVisible()
    expect(screen.queryByDisplayValue('Rejected change')).not.toBeInTheDocument()
  })
})
