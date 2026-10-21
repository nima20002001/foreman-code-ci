import { StrictMode, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentBrowserPanel } from './AgentBrowserPanel'
import { BrowserSettingsFields } from './BrowserSettingsFields'
import { browserFilesFake, browserPortFake, browserRead, frame, subject } from './testFixtures'

beforeEach(() => { vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:fixture'), revokeObjectURL: vi.fn() })) })
afterEach(() => { vi.unstubAllGlobals() })

function panel(fake: ReturnType<typeof browserPortFake>, overrides = {}) {
  return <AgentBrowserPanel visible selection={{ authBoundary: 'login', visitKey: 'visit-1', subject,
    sessionId: 'session', tabId: 'tab', enabled: true, historical: false }} port={fake.port} files={browserFilesFake()}
    computerName="Main" profileName="Work" readOnly={false} onOpenSettings={vi.fn()}
    onSelectSession={vi.fn()} onSelectTab={vi.fn()} onCleanupError={vi.fn()} {...overrides} />
}

function mount(element: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>)
}

it('does no browser reads while hidden or disabled and does not launch work to display an empty selection', async () => {
  const fake = browserPortFake()
  mount(panel(fake, { visible: false }))
  expect(fake.port.readSession).not.toHaveBeenCalled()
  expect(fake.port.listSessions).not.toHaveBeenCalled()
  expect(fake.port.openView).not.toHaveBeenCalled()
})

it('keeps the view usable through StrictMode effect replay and sends page Tab and composition through the acknowledged controller', async () => {
  const fake = browserPortFake()
  mount(<StrictMode>{panel(fake)}</StrictMode>)
  await waitFor(() => expect(fake.port.openView).toHaveBeenCalled())
  act(() => fake.observer!.frame(frame()))
  await userEvent.click(screen.getByRole('button', { name: 'Take control' }))
  expect(await screen.findByText('User has control over the browser')).toBeVisible()
  const page = screen.getByRole('group', { name: 'Browser page' })
  fireEvent.keyDown(page, { key: 'Tab', code: 'Tab' })
  const keyboard = screen.getByRole('textbox', { name: 'Browser keyboard input' })
  fireEvent.compositionStart(keyboard, { data: '' })
  fireEvent.compositionUpdate(keyboard, { data: '文' })
  fireEvent.compositionEnd(keyboard, { data: '文字' })
  await waitFor(() => expect(fake.port.input).toHaveBeenCalled())
  const inputs = vi.mocked(fake.port.input).mock.calls.flatMap(call => call[5])
  expect(inputs).toContainEqual(expect.objectContaining({ kind: 'key', key: 'Tab' }))
  await waitFor(() => expect(vi.mocked(fake.port.input).mock.calls.flatMap(call => call[5]))
    .toContainEqual({ kind: 'composition', phase: 'end', text: '文字' }))
})

it('selects an explicit viewer tab without changing the agent’s selected tab', async () => {
  const read = browserRead()
  read.tabs.push({ ...read.tabs[0]!, id: 'second-lease', tabId: 'second', title: 'Other page' })
  const fake = browserPortFake(read), choose = vi.fn()
  mount(panel(fake, { onSelectTab: choose }))
  await waitFor(() => expect(fake.port.openView).toHaveBeenCalled())
  act(() => fake.observer!.frame(frame()))
  await userEvent.click(screen.getByRole('button', { name: 'Other page' }))
  await waitFor(() => expect(choose).toHaveBeenCalledWith('second'))
  expect((await fake.port.readSession('session', new AbortController().signal)).session.selectedTabId).toBe('tab')
})

it('keeps browser configuration in the caller’s draft without starting a browser or saving a workflow', async () => {
  const change = vi.fn()
  mount(<BrowserSettingsFields value={undefined} onChange={change} catalog={{ profiles: [], replicas: [], presentReplicas: [], pendingReplicas: [] }}
    computer={undefined} onManageProfiles={vi.fn()} />)
  await userEvent.click(screen.getByRole('checkbox', { name: 'Browser' }))
  expect(change).toHaveBeenCalledWith({ enabled: true })
  expect(screen.getByText(/Applies to the next run/)).toBeVisible()
})

it('selects the exact created viewer tab while preserving the agent’s selected tab', async () => {
  const fake = browserPortFake(), choose = vi.fn(), created = { ...browserRead().tabs[0]!, id: 'created-lease', tabId: 'created' }
  vi.mocked(fake.port.createTab).mockResolvedValue({ ...browserRead(), tabs: [...browserRead().tabs, created], createdTabId: 'created' })
  mount(panel(fake, { onSelectTab: choose }))
  await waitFor(() => expect(fake.port.openView).toHaveBeenCalled())
  act(() => fake.observer!.frame(frame()))
  await userEvent.click(screen.getByRole('button', { name: 'New tab' }))
  await waitFor(() => expect(choose).toHaveBeenCalledWith('created'))
})

it('renders owned website prompt and downloads in the session panel and responds only after acknowledged control', async () => {
  const read = browserRead()
  read.dialog = { tabId: 'tab', type: 'prompt', message: 'Name for this page', defaultPrompt: 'Ada' }
  read.files = [{ id: 'download', name: 'report.txt', mimeType: 'text/plain', byteLength: 3,
    receivedBytes: 3, state: 'ready', purpose: 'download' }]
  const fake = browserPortFake(read)
  mount(panel(fake))
  await waitFor(() => expect(fake.port.openView).toHaveBeenCalled())
  act(() => fake.observer!.frame(frame()))
  expect(screen.getByRole('textbox', { name: 'Reply to website' })).toHaveValue('Ada')
  expect(screen.getByRole('button', { name: 'Save file' })).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'OK' }))
  await waitFor(() => expect(fake.port.respondDialog).toHaveBeenCalledWith(expect.objectContaining({ id: 'session' }),
    expect.objectContaining({ tabId: 'tab' }), expect.any(String), 1, true, 'Ada', expect.any(String)))
})

it('shows the accepted unavailable reason and retries only on an explicit click with the original command and subject', async () => {
  const fake = browserPortFake()
  vi.mocked(fake.port.listSessions).mockResolvedValue([])
  mount(panel(fake, { selection: { authBoundary: 'login', visitKey: 'missing-browser', subject,
    sessionId: null, tabId: null, enabled: true, historical: false }, preparation: {
    result: { kind: 'unavailable', reason: 'computer_offline', retryable: true },
    request: { subject, browser: { enabled: true, profileId: 'profile' }, computerId: 'main', commandId: 'accepted-prepare' },
  } }))
  expect(await screen.findByText('The selected execution computer is offline.')).toBeVisible()
  expect(fake.port.prepare).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Retry browser' }))
  await waitFor(() => expect(fake.port.prepare).toHaveBeenCalledWith(subject, { enabled: true, profileId: 'profile' }, 'main', 'accepted-prepare'))
  expect(await screen.findByRole('button', { name: 'Open prepared browser' })).toBeVisible()
})

it('reconnects only the explicitly selected owned browser and never replays gestures on recovery', async () => {
  const fake = browserPortFake()
  mount(panel(fake))
  await waitFor(() => expect(fake.port.openView).toHaveBeenCalled())
  expect(fake.port.reconnect).not.toHaveBeenCalled()
  act(() => { fake.observer!.frame(frame()); fake.observer!.disconnected(new Error('Owned connection lost')) })
  await userEvent.click(screen.getByRole('button', { name: 'Reconnect view' }))
  await waitFor(() => expect(fake.port.reconnect).toHaveBeenCalledWith(expect.objectContaining({ id: 'session' }), expect.any(String)))
  await waitFor(() => expect(fake.port.openView).toHaveBeenCalledTimes(2))
  expect(fake.port.input).not.toHaveBeenCalled()
  expect(fake.port.prepare).not.toHaveBeenCalled()
})
