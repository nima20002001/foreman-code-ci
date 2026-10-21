import { useState, type ComponentProps } from 'react'
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { boundLocationKeys } from '../../shared/api/workspaceBoundLocation'
import { useBoundLocationDraftStore } from './workspaceBoundLocationDraftStore'
import { ScopedMcpDetectionSchema, type AgentHarness, type McpDetection } from '@foreman-code/contracts'
import { ManagedWorkspaceSchema } from '@foreman-code/contracts/management'

import * as api from '../../shared/api/client'
import { queryKeys } from '../../shared/api/query'
import { renderWithRouter } from '../../test/renderWithRouter'
import { McpDetectionSettings } from './McpDetectionSettings'
import { deferred } from '../../test/deferred'

// Keep the real Query observers, auth latch, router and Nocturne controls. Mock
// only the existing HTTP-client boundary, not the component's request lifecycle.
vi.mock('../../shared/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/api/client')>()
  return { ...actual, getScopedMcpDetection: vi.fn(), getManagedWorkspace: vi.fn(), listManagedWorkspaces: vi.fn() }
})

// jsdom has no layout/scroll implementation; keep the real Combobox behavior.
beforeEach(() => { HTMLElement.prototype.scrollIntoView ??= vi.fn() })

const checkedAt = '2026-09-16T00:00:00.000Z'
const clients: QueryClient[] = []
const getDetection = vi.mocked(api.getScopedMcpDetection)
const getWorkspace = vi.mocked(api.getManagedWorkspace)
const listWorkspaces = vi.mocked(api.listManagedWorkspaces)

function workspace(id = 'workspace-1', rootPath = '/srv/project') {
  return ManagedWorkspaceSchema.parse({
    workspace: { id, name: `Workspace ${id}`, description: '' }, revision: 1, archivedAt: null,
    executionLocation: { runnerId: 'runner-local', rootPath }, locationRevision: 1,
    locationValidation: { status: 'ready', checkedAt },
  })
}
function detection(harness: AgentHarness = 'codex', state: McpDetection['state'] = 'connected', workingDirectory = '/srv/project') {
  return ScopedMcpDetectionSchema.parse({
    runnerId: 'runner-local', workingDirectory, providerVersion: '0.154.0', nativeFilters: {},
    detection: { harness, serverName: 'graphql', state, checkedAt,
      endpointMatches: state === 'not_detected' || state === 'check_failed' ? null : true,
      credentialEnvironmentVariable: 'FOREMAN_CODE_APP_MCP_TOKEN' },
  })
}
function client() {
  const value = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
  clients.push(value)
  value.setQueryData(queryKeys.managedWorkspace('workspace-1'), workspace())
  return value
}
function seedConnections(value: QueryClient, state: McpDetection['state'] = 'connected') {
  for (const harness of ['codex'] as const) value.setQueryData(queryKeys.mcpDetection('workspace-1', harness), detection(harness, state))
}
function mount(value: QueryClient, initial: ComponentProps<typeof McpDetectionSettings> = { workspaceId: 'workspace-1' }) {
  let update: (next: ComponentProps<typeof McpDetectionSettings>) => void = () => { throw new Error('Panel has not mounted') }
  function Host() {
    const [props, setProps] = useState(initial)
    update = setProps
    return <QueryClientProvider client={value}><McpDetectionSettings {...props} /></QueryClientProvider>
  }
  const rendered = renderWithRouter(<Host />)
  clients.push(rendered.queryClient)
  return { ...rendered, update: (next: ComponentProps<typeof McpDetectionSettings>) => act(() => update(next)) }
}

beforeEach(() => {
  vi.resetAllMocks()
  useBoundLocationDraftStore.getState().reset()
  server.use(http.get('/api/management/workspaces/:workspaceId/root-policies', ({ params }) => HttpResponse.json({
    workspaceId: params.workspaceId, readiness: 'metadata-only', policies: [], allowlists: [],
  })))
  getDetection.mockImplementation(async (_id, harness) => detection(harness))
  getWorkspace.mockImplementation(async (id) => workspace(id))
  listWorkspaces.mockResolvedValue({ items: [workspace()], pageInfo: { nextCursor: null } })
})
afterEach(() => {
  cleanup()
  for (const value of clients.splice(0)) value.clear()
  onlineManager.setOnline(true)
  vi.restoreAllMocks()
})

describe('Workspace App MCP hierarchy', () => {
  it('uses the current workspace automatically, without a list request or another selection', async () => {
    const value = client()
    mount(value)
    expect(await screen.findByRole('heading', { name: 'App connections' })).toBeVisible()
    await waitFor(() => expect(screen.getAllByText('Connected')).toHaveLength(1))
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(listWorkspaces).not.toHaveBeenCalled()
    expect(getDetection.mock.calls.map(([id, harness]) => [id, harness])).toEqual([
      ['workspace-1', 'codex'],
    ])
    expect(screen.queryByRole('button', { name: /save|confirm/i })).not.toBeInTheDocument()
  })

  it('leaves workspace selection in the unscoped harness preview only', async () => {
    const value = client()
    const user = userEvent.setup()
    mount(value, { harness: 'codex' })
    const picker = await screen.findByRole('combobox', { name: 'Workspace' })
    expect(getDetection).not.toHaveBeenCalled()
    await user.click(picker)
    await user.click(await screen.findByRole('option', { name: /Workspace workspace-1/ }))
    expect(await screen.findByText('Connected')).toBeVisible()
    expect(screen.queryByRole('article', { name: 'Claude' })).not.toBeInTheDocument()
    expect(getDetection.mock.calls.every(([, harness]) => harness === 'codex')).toBe(true)
  })

  it('preserves the provider report and filters, without putting raw diagnostics in the main view', async () => {
    const value = client()
    const user = userEvent.setup()
    value.setQueryData(queryKeys.mcpDetection('workspace-1', 'codex'), detection())
    const failed = detection('codex', 'check_failed')
    failed.detection.detail = 'CLI unavailable'
    failed.nativeFilters = { enabledTools: ['read_workspace'], disabledTools: ['write_workspace'], diagnostics: ['Inspector timed out'] }
    value.setQueryData(queryKeys.mcpDetection('workspace-1', 'codex'), failed)
    mount(value)
    expect(await screen.findByText('Check failed')).toBeVisible()
    expect(screen.getByText('CLI unavailable')).not.toBeVisible()
    const card = screen.getByRole('article', { name: 'Codex' })
    await user.click(within(card).getByText('Details'))
    for (const text of ['CLI unavailable', 'runner-local', '/srv/project', 'read_workspace', 'write_workspace', 'Inspector timed out']) {
      expect(within(card).getByText(text)).toBeVisible()
    }
  })

  it.each([
    ['not_detected', 'Not set up'], ['misconfigured', 'Needs attention'],
    ['status_unavailable', 'Setup found'], ['connected', 'Connected'],
    ['disabled', 'Turned off'], ['authentication_required', 'Sign-in required'],
    ['broken', 'Cannot connect'], ['check_failed', 'Check failed'],
  ] as const)('keeps the %s state distinct', async (state, label) => {
    const value = client()
    seedConnections(value, state)
    mount(value)
    expect((await screen.findAllByText(label))).toHaveLength(1)
  })

  it('explains that matching setup still needs a live run to verify the App MCP call', async () => {
    const value = client()
    seedConnections(value, 'status_unavailable')
    mount(value)
    expect((await screen.findAllByText('Setup found'))).toHaveLength(1)
    expect(screen.getAllByText('Native settings match. To verify live use, run a workflow that calls a Foreman Code MCP tool, then check its completed tool activity in Runs.')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Check setup for Codex' })).toBeEnabled()
  })

  it('checks again in place and blocks duplicate requests', async () => {
    const value = client()
    seedConnections(value)
    const pending = deferred<ReturnType<typeof detection>>()
    getDetection.mockReturnValue(pending.promise)
    const user = userEvent.setup()
    mount(value)
    const button = await screen.findByRole('button', { name: 'Check setup for Codex' })
    await user.dblClick(button)
    expect(button).toBeDisabled()
    expect(getDetection).toHaveBeenCalledTimes(1)
    expect(button).toBeDisabled()
    await act(async () => pending.resolve(detection('codex', 'broken')))
    await waitFor(() => expect(button).toBeEnabled())
    expect(screen.getByText('Cannot connect')).toBeVisible()
  })

  it('keeps the last report on a network failure but never labels it as a current check', async () => {
    const value = client()
    seedConnections(value)
    getDetection.mockRejectedValue(new Error('Connection timed out'))
    const user = userEvent.setup()
    mount(value, { workspaceId: 'workspace-1', harness: 'codex' })
    await user.click(await screen.findByRole('button', { name: 'Check setup for Codex' }))
    expect(await screen.findByText('Last known: Connected')).toBeVisible()
    expect(screen.queryByText('Connected', { exact: true })).not.toBeInTheDocument()
    expect(screen.getByText('Couldn’t update. Showing the last check.')).toBeVisible()
    await user.click(screen.getByText('Details'))
    expect(screen.getByText('Connection timed out')).toBeVisible()
    expect(screen.getByText('/srv/project')).toBeVisible()
  })

  it('keeps the provider card and retry available when a check fails', async () => {
    const value = client()
    getDetection.mockImplementation(async (_id, harness) => {
      if (harness === 'codex') throw new Error('Codex check unavailable')
      return detection(harness)
    })
    mount(value)
    expect(await screen.findByText('Check failed')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Check setup for Codex' })).toBeEnabled()
  })

  it('makes Details keyboard reachable without an icon-only mystery control', async () => {
    const value = client()
    seedConnections(value)
    const user = userEvent.setup()
    mount(value, { workspaceId: 'workspace-1', harness: 'codex' })
    const check = await screen.findByRole('button', { name: 'Check setup for Codex' })
    await user.tab()
    expect(check).toHaveFocus()
    await user.tab()
    expect(screen.getByText('Details').closest('summary')).toHaveFocus()
  })

  it('shows waiting, rather than an endless active check, when offline', async () => {
    const value = client()
    onlineManager.setOnline(false)
    mount(value, { workspaceId: 'workspace-1', harness: 'codex' })
    expect(await screen.findByText('Waiting for connection')).toBeVisible()
    expect(getDetection).not.toHaveBeenCalled()
  })
})

describe('Workspace App MCP scope and access', () => {
  it('opens the folder picker directly, and does not check providers before a folder exists', async () => {
    const value = client()
    value.setQueryData(queryKeys.managedWorkspace('workspace-1'), {
      ...workspace(), executionLocation: null, locationValidation: { status: 'unconfigured' },
    })
    value.setQueryData(boundLocationKeys.read('workspace-1'), { evidence: 'unconfigured', workspaceId: 'workspace-1', locationRevision: 1, executionLocation: null })
    mount(value)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Choose workspace folder' }))
    expect(await screen.findByRole('dialog', { name: 'Execution folder' })).toBeVisible()
    expect(getDetection).not.toHaveBeenCalled()
  })

  it('offers access recovery, not an inaccessible setup form, for a restricted folder', async () => {
    const value = client()
    value.setQueryData(queryKeys.managedWorkspace('workspace-1'), {
      ...workspace(), executionLocation: null, locationValidation: { status: 'restricted' },
    })
    mount(value)
    expect(await screen.findByText('Folder access is restricted')).toBeVisible()
    expect(screen.queryByRole('link', { name: /folder/i })).not.toBeInTheDocument()
    expect(getDetection).not.toHaveBeenCalled()
  })

  it('keeps unavailable-folder diagnosis accessible without treating it as an unconfigured workspace', async () => {
    const value = client()
    value.setQueryData(queryKeys.managedWorkspace('workspace-1'), {
      ...workspace(), locationValidation: { status: 'unavailable', checkedAt, error: { code: 'FOLDER_MISSING', message: 'The folder was removed.' } },
    })
    value.setQueryData(boundLocationKeys.read('workspace-1'), { evidence: 'legacy_missing', workspaceId: 'workspace-1',
      locationRevision: 1, executionLocation: workspace().executionLocation })
    mount(value)
    expect(await screen.findByRole('button', { name: 'Choose workspace folder' })).toBeVisible()
    expect(await screen.findByText('The folder was removed.')).toBeVisible()
    expect(screen.getAllByText('The folder was removed.')).toHaveLength(1)
    expect(screen.getByText('/srv/project')).toBeVisible()
    expect(screen.queryByText('No execution folder has been configured.')).not.toBeInTheDocument()
    expect(getDetection).not.toHaveBeenCalled()
  })

  it('automatically rechecks a changed folder instead of showing cached healthy evidence from the old folder', async () => {
    const value = client()
    value.setQueryData(queryKeys.managedWorkspace('workspace-1'), workspace('workspace-1', '/srv/new'))
    value.setQueryData(queryKeys.mcpDetection('workspace-1', 'codex'), detection())
    const pending = deferred<ReturnType<typeof detection>>()
    getDetection.mockReturnValue(pending.promise)
    mount(value, { workspaceId: 'workspace-1', harness: 'codex' })
    await waitFor(() => expect(getDetection).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
    expect(screen.queryByText('/srv/project')).not.toBeInTheDocument()
    await act(async () => pending.resolve(detection('codex', 'connected', '/srv/new')))
  })

  it('does not carry a previous workspace’s report across navigation', async () => {
    const value = client()
    seedConnections(value)
    value.setQueryData(queryKeys.managedWorkspace('workspace-2'), workspace('workspace-2', '/srv/second'))
    const pending = deferred<ReturnType<typeof detection>>()
    getDetection.mockReturnValue(pending.promise)
    const view = mount(value, { workspaceId: 'workspace-1', harness: 'codex' })
    expect(await screen.findByRole('heading', { name: 'App connections' })).toBeVisible()
    view.update({ workspaceId: 'workspace-2', harness: 'codex' })
    await waitFor(() => expect(getDetection).toHaveBeenCalled())
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
    expect(screen.queryByText('/srv/project')).not.toBeInTheDocument()
    await act(async () => pending.resolve(detection('codex', 'broken', '/srv/second')))
    expect(await screen.findByText('Cannot connect')).toBeVisible()
  })

  it.each([401, 403])('hides cached connection details when access is denied with %s', async (status) => {
    const value = client()
    seedConnections(value)
    getDetection.mockRejectedValue(new api.ApiError({ code: status === 401 ? 'AUTH_REQUIRED' : 'FORBIDDEN', message: 'Access denied' }, status))
    const user = userEvent.setup()
    mount(value, { workspaceId: 'workspace-1', harness: 'codex' })
    await user.click(await screen.findByRole('button', { name: 'Check setup for Codex' }))
    expect(await screen.findByText('Connection access is unavailable')).toBeVisible()
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
    expect(screen.queryByText('/srv/project')).not.toBeInTheDocument()
    expect(screen.queryByText('Details')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument()
  })

  it('does not reveal an old report after a denial followed by a network error', async () => {
    const value = client()
    seedConnections(value)
    getDetection.mockRejectedValueOnce(new api.ApiError({ code: 'FORBIDDEN', message: 'Denied' }, 403))
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValueOnce(detection())
    const user = userEvent.setup()
    mount(value, { workspaceId: 'workspace-1', harness: 'codex' })
    await user.click(await screen.findByRole('button', { name: 'Check setup for Codex' }))
    expect(await screen.findByText('Connection access is unavailable')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Check setup for Codex' }))
    await waitFor(() => expect(getDetection).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check setup for Codex' })).toBeEnabled())
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
    expect(screen.queryByText('/srv/project')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Check setup for Codex' }))
  })
})
