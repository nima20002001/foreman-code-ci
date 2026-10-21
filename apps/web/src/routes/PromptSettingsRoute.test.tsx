import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_AGENT_DEFAULTS } from '@foreman-code/contracts'
import {
  LocalHumanAccessSchema,
  PromptSettingUpdateInputSchema,
  type PromptSettingUpdateInput,
} from '@foreman-code/contracts/management'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { routeTree } from '../app/router'
import { clearRevisionedFormPersistence } from '../features/settings/revisionedForm'
import { server } from '../mocks/server'
import { settingsExperienceKeys } from '../shared/api/settingsExperience'
import { promptSettingsKey } from '../shared/api/promptSettings'

const clients: QueryClient[] = []
const histories: ReturnType<typeof createBrowserHistory>[] = []
const ownerAccess = LocalHumanAccessSchema.parse({ principal: {
  id: 'prompt-owner', name: 'Owner', expiresAt: '2099-01-01T00:00:00Z',
  grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }],
} })

function mount(path: string) {
  window.history.replaceState(null, '', path)
  const history = createBrowserHistory()
  histories.push(history)
  const router = createRouter({ routeTree, history })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { router, client }
}

async function expectAppAccessFailure(status: number, editor: HTMLElement) {
  if (status === 403) {
    expect(await screen.findByRole('heading', { name: 'Access unavailable' })).toBeVisible()
    expect(screen.queryByRole('textbox', { name: 'Initial prompt' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
  } else {
    const banner = await screen.findByRole('alert', { name: 'Server connection' })
    expect(banner).toBeVisible()
    expect(banner).toHaveTextContent('Connection interrupted.')
    expect(within(banner).getByRole('button', { name: 'Try again' })).toBeEnabled()
    expect(within(banner).queryByRole('button', { name: 'Close dialog' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Initial prompt' })).toBe(editor)
    expect(editor).toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()
  }
  expect(screen.queryByRole('button', { name: 'Save initial prompt' })).not.toBeInTheDocument()
}

beforeEach(() => {
  clearRevisionedFormPersistence()
  server.use(
    http.get('/api/management/settings/agents', () => HttpResponse.json({ revision: 1, versionId: null,
      value: { ...DEFAULT_AGENT_DEFAULTS, operator: { ...DEFAULT_AGENT_DEFAULTS.operator, uiEnabled: false } } })),
    http.get('/api/local-human', () => HttpResponse.json(ownerAccess)),
    http.get('/api/management/settings/system-prompt', () => HttpResponse.json({
      revision: 2, versionId: 'system-prompt-2', value: { text: 'Workflow and chat instructions' },
    })),
    http.get('/api/management/settings/operator-initial-prompt', () => HttpResponse.json({
      revision: 4, versionId: 'operator-prompt-4', value: { text: 'Operator instructions' },
    })),
  )
})

afterEach(() => {
  cleanup()
  clearRevisionedFormPersistence()
  for (const history of histories.splice(0)) history.destroy()
  for (const client of clients.splice(0)) client.clear()
})

it('opens the System prompt editor from Settings at a linkable route', async () => {
  const { router } = mount('/settings')
  const link = await screen.findByRole('link', { name: 'System prompt' })
  expect(link).toHaveAttribute('href', '/settings/system-prompt')
  await userEvent.click(link)
  expect(await screen.findByRole('textbox', { name: 'System prompt' }))
    .toHaveValue('Workflow and chat instructions')
  expect(router.state.location.pathname).toBe('/settings/system-prompt')
  const breadcrumbs = screen.getByRole('navigation', { name: 'Breadcrumbs' })
  expect(within(breadcrumbs).getAllByRole('listitem').map(item => item.textContent))
    .toEqual(['Settings', 'System prompt'])
  const settings = within(breadcrumbs).getByRole('link', { name: 'Go to Settings' })
  expect(settings).toHaveAttribute('href', '/settings')
  await userEvent.click(settings)
  await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
})

it.each(['', '&section=model', '&section=permissions'])(
  'names the Operator prompt and keeps breadcrumb navigation in its settings location: %s',
  async search => {
    const { router } = mount(`/settings/agents?role=operator${search}`)
    const user = userEvent.setup()
    expect(await screen.findByRole('textbox', { name: 'Initial prompt' })).toHaveValue('Operator instructions')
    const breadcrumbs = screen.getByRole('navigation', { name: 'Breadcrumbs' })
    expect(within(breadcrumbs).getAllByRole('listitem').map(item => item.textContent))
      .toEqual(['Settings', 'Agents', 'Operator', 'Initial prompt'])
    expect(breadcrumbs.querySelector('[aria-current="page"]')).toHaveTextContent('Initial prompt')
    expect(within(breadcrumbs).getByRole('link', { name: 'Go to Settings' })).toHaveAttribute('href', '/settings')
    const agents = within(breadcrumbs).getByRole('link', { name: 'Go to Agents' })
    expect(agents).toHaveAttribute('href', '/settings/agents')
    const operator = within(breadcrumbs).getByRole('link', { name: 'Go to Operator' })
    expect(operator).toHaveAttribute('href', '/settings/agents?role=operator')
    await user.click(operator)
    await waitFor(() => expect(router.state.location.search).toEqual({ role: 'operator' }))
    expect(screen.getByRole('textbox', { name: 'Initial prompt' })).toHaveValue('Operator instructions')
    await user.click(agents)
    expect(await screen.findByRole('button', { name: 'Edit Operator defaults' })).toBeVisible()
    expect(router.state.location.search).toEqual({})
  },
)

it.each(['', '&section=model', '&section=permissions'])(
  'returns from a direct Operator prompt link to Agents using Back: %s',
  async search => {
    const { router } = mount(`/settings/agents?role=operator${search}`)
    expect(await screen.findByRole('textbox', { name: 'Initial prompt' })).toHaveValue('Operator instructions')
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('button', { name: 'Edit Operator defaults' })).toBeVisible()
    expect(router.state.location.pathname).toBe('/settings/agents')
    expect(router.state.location.search).toEqual({})
  },
)

it('opens the Operator card by URL selection and protects edited text when returning to Agents', async () => {
  const { router } = mount('/settings/agents')
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Edit Operator defaults' }))
  const editor = await screen.findByRole('textbox', { name: 'Initial prompt' })
  await waitFor(() => expect(editor).not.toHaveAttribute('readonly'))
  expect(editor).toHaveValue('Operator instructions')
  expect(router.state.location.pathname).toBe('/settings/agents')
  expect(router.state.location.search).toMatchObject({ role: 'operator' })
  await user.type(editor, '\nUnsaved addition')
  await user.click(screen.getByRole('button', { name: 'Back to Agents' }))
  const dialog = await screen.findByRole('alertdialog', { name: 'Save changes before leaving?' })
  expect(editor).toHaveValue('Operator instructions\nUnsaved addition')
  expect(router.state.location.search).toMatchObject({ role: 'operator' })
  await user.click(within(dialog).getByRole('button', { name: 'Discard' }))
  expect(await screen.findByRole('button', { name: 'Edit Operator defaults' })).toBeVisible()
  expect(router.state.location.search).not.toHaveProperty('role')
})

it('reads the Operator initial prompt when opening its saved URL directly', async () => {
  const { router } = mount('/settings/agents?role=operator')
  expect(await screen.findByRole('textbox', { name: 'Initial prompt' })).toHaveValue('Operator instructions')
  expect(screen.getByText('Saved revision: 4')).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Back to Agents' }))
  expect(await screen.findByRole('button', { name: 'Edit Operator defaults' })).toBeVisible()
  expect(router.state.location.search).not.toHaveProperty('role')
})

it('keeps edited prompts guarded after the global update grant is revoked without allowing a save', async () => {
  let writes = 0
  server.use(http.put('/api/management/settings/operator-initial-prompt', () => {
    writes += 1
    return HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Updates are denied.' } }, { status: 403 })
  }))
  const { router, client } = mount('/settings/agents?role=operator')
  const user = userEvent.setup()
  const editor = await screen.findByRole('textbox', { name: 'Initial prompt' })
  await waitFor(() => expect(editor).not.toHaveAttribute('readonly'))
  await user.type(editor, '\nKeep these edits')
  server.use(http.get('/api/local-human', () => HttpResponse.json({ principal: { ...ownerAccess.principal,
    grants: [{ actions: ['settings:read'], scope: {} }] } })))
  await client.invalidateQueries({ queryKey: settingsExperienceKeys.access() })
  expect(await screen.findByText('You have read-only access to this prompt.')).toBeVisible()
  expect(editor).toHaveValue('Operator instructions\nKeep these edits')
  expect(screen.queryByRole('button', { name: 'Save initial prompt' })).not.toBeInTheDocument()
  const unload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unload)
  expect(unload.defaultPrevented).toBe(true)
  await user.click(screen.getByRole('button', { name: 'Settings' }))
  const dialog = await screen.findByRole('alertdialog', { name: 'Save changes before leaving?' })
  const save = within(dialog).getByRole('button', { name: 'Save' })
  expect(save).toBeDisabled()
  await user.click(save)
  expect(writes).toBe(0)
  expect(router.state.location.pathname).toBe('/settings/agents')
  await user.click(within(dialog).getByRole('button', { name: 'Discard' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
})

it.each([503, 403])('recovers edited prompts after a %s app access failure and restores navigation guards', async status => {
  const { router, client } = mount('/settings/agents?role=operator')
  const user = userEvent.setup()
  const editor = await screen.findByRole('textbox', { name: 'Initial prompt' })
  await waitFor(() => expect(editor).not.toHaveAttribute('readonly'))
  await user.type(editor, '\nKeep these edits')
  server.use(http.get('/api/local-human', () => HttpResponse.json({
    error: { code: 'ACCESS_UNAVAILABLE', message: 'Access check failed.' },
  }, { status })))
  await client.invalidateQueries({ queryKey: settingsExperienceKeys.access() })
  await expectAppAccessFailure(status, editor)
  server.use(http.get('/api/local-human', () => HttpResponse.json(ownerAccess)))
  await user.click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(screen.queryByRole('alert', { name: 'Server connection' })).not.toBeInTheDocument())
  expect(await screen.findByRole('textbox', { name: 'Initial prompt' }))
    .toHaveValue('Operator instructions\nKeep these edits')
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Initial prompt' })).not.toHaveAttribute('readonly'))
  const unload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unload)
  expect(unload.defaultPrevented).toBe(true)
  await user.click(screen.getByRole('button', { name: 'Settings' }))
  const dialog = await screen.findByRole('alertdialog', { name: 'Save changes before leaving?' })
  expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled()
  await user.click(within(dialog).getByRole('button', { name: 'Discard' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
})

it.each([503, 403])('retries the original uncertain prompt save after a %s app access failure', async status => {
  const writes: PromptSettingUpdateInput[] = []
  server.use(http.put('/api/management/settings/operator-initial-prompt', async ({ request }) => {
    const input = PromptSettingUpdateInputSchema.parse(await request.json())
    writes.push(input)
    if (writes.length === 1) {
      return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Save not confirmed.' } }, { status: 503 })
    }
    return HttpResponse.json({
      value: { revision: 5, versionId: 'operator-prompt-5', value: input.value }, replayed: true,
    })
  }))
  const { router, client } = mount('/settings/agents?role=operator')
  const user = userEvent.setup()
  const editor = await screen.findByRole('textbox', { name: 'Initial prompt' })
  await waitFor(() => expect(editor).not.toHaveAttribute('readonly'))
  await user.type(editor, '\nSubmitted edit')
  await user.click(screen.getByRole('button', { name: 'Save initial prompt' }))
  expect(await within(screen.getByRole('region', { name: 'Initial prompt settings' })).findByText('Save not confirmed')).toBeVisible()
  server.use(http.get('/api/local-human', () => HttpResponse.json({
    error: { code: 'ACCESS_UNAVAILABLE', message: 'Access check failed.' },
  }, { status })))
  await client.invalidateQueries({ queryKey: settingsExperienceKeys.access() })
  await expectAppAccessFailure(status, editor)
  server.use(http.get('/api/local-human', () => HttpResponse.json(ownerAccess)))
  await user.click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(screen.queryByRole('alert', { name: 'Server connection' })).not.toBeInTheDocument())
  expect(await screen.findByRole('textbox', { name: 'Initial prompt' }))
    .toHaveValue('Operator instructions\nSubmitted edit')
  expect(screen.getByRole('textbox', { name: 'Initial prompt' })).toBeDisabled()
  expect(within(screen.getByRole('region', { name: 'Initial prompt settings' })).getByText('Save not confirmed')).toBeVisible()
  const unload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unload)
  expect(unload.defaultPrevented).toBe(true)
  await user.click(screen.getByRole('button', { name: 'Settings' }))
  const dialog = await screen.findByRole('alertdialog', { name: 'Save changes before leaving?' })
  const retry = within(dialog).getByRole('button', { name: 'Retry original save' })
  expect(retry).toBeEnabled()
  expect(within(dialog).getByRole('button', { name: 'Discard' })).toBeDisabled()
  await user.click(retry)
  await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
  expect(writes).toHaveLength(2)
  expect(writes[1]).toEqual(writes[0])
})

it.each([false, true])('guards navigation and blocks saving after prompt denial (uncertain: %s)', async uncertain => {
  let writes = 0
  server.use(http.put('/api/management/settings/operator-initial-prompt', () => {
    writes += 1
    return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Save not confirmed.' } }, { status: 503 })
  }))
  const { router, client } = mount('/settings/agents?role=operator')
  const user = userEvent.setup()
  const editor = await screen.findByRole('textbox', { name: 'Initial prompt' })
  await waitFor(() => expect(editor).not.toHaveAttribute('readonly'))
  await user.type(editor, '\nProtected edit')
  if (uncertain) {
    await user.click(screen.getByRole('button', { name: 'Save initial prompt' }))
    expect(await within(screen.getByRole('region', { name: 'Initial prompt settings' })).findByText('Save not confirmed')).toBeVisible()
  }
  server.use(http.get('/api/management/settings/operator-initial-prompt', () => HttpResponse.json({
    error: { code: 'FORBIDDEN', message: 'Prompt access denied.' },
  }, { status: 403 })))
  await client.invalidateQueries({ queryKey: promptSettingsKey('operator-initial-prompt') })
  expect(await screen.findByText('Access unavailable')).toBeVisible()
  expect(screen.queryByRole('textbox', { name: 'Initial prompt' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Save initial prompt' })).not.toBeInTheDocument()
  const unload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unload)
  expect(unload.defaultPrevented).toBe(true)
  await user.click(screen.getByRole('button', { name: 'Settings' }))
  const dialog = await screen.findByRole('alertdialog', { name: 'Save changes before leaving?' })
  const save = within(dialog).getByRole('button', { name: uncertain ? 'Retry original save' : 'Save' })
  expect(save).toBeDisabled()
  if (uncertain) expect(within(dialog).getByRole('button', { name: 'Discard' })).toBeDisabled()
  else expect(within(dialog).getByRole('button', { name: 'Discard' })).toBeEnabled()
  await user.click(save)
  expect(writes).toBe(uncertain ? 1 : 0)
  expect(router.state.location.pathname).toBe('/settings/agents')
})
