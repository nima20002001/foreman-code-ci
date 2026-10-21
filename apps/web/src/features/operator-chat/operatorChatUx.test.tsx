import { savedClaudeConfiguration } from '../settings/claudeSettings.fixtures'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import userEvent from '@testing-library/user-event'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS, operatorChatSettings, type HarnessConfiguration } from '@foreman-code/contracts'
import { AgentDefaultsUpdateInputSchema } from '@foreman-code/contracts/management'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { ApiError, getManagedAgentDefaults, updateManagedAgentDefaults } from '../../shared/api/client'
import { queryKeys } from '../../shared/api/query'
import { OperatorComposerSettings } from './OperatorComposerSettings'
import { OperatorChat } from './OperatorChat'
import { installCanonicalOperatorFixture } from './canonicalOperator.test-support'
import { configuredOperatorSetup } from './operatorSetupTestFixture'
import { OperatorChatVisibilityProvider } from './visibility'
import { askOperator, useOperatorChatStore } from './operatorChatStore'
import { operatorState } from './pr17-test-fixtures'
import { summarizeOperatorConversation } from './operatorChatStatus'
import { parseChatPreferences } from '../../shared/api/protectedChatStorage'
import { clearRevisionedFormPersistence, useRevisionedForm } from '../settings/revisionedForm'
import { useConversationDraftStore } from '../conversations'

type AgentDefaultsUpdateInput = ReturnType<typeof AgentDefaultsUpdateInputSchema.parse>
type ManagedAgentDefaults = Awaited<ReturnType<typeof getManagedAgentDefaults>>

const api = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), list: vi.fn(), send: vi.fn(), remove: vi.fn(), restore: vi.fn() }))
vi.mock('../../shared/api/client', async (original) => ({ ...await original<typeof import('../../shared/api/client')>(),
  createOperatorConversation: api.create, getOperatorConversation: api.get, sendOperatorMessage: api.send }))
vi.mock('../../shared/api/operatorChatSummaries', () => ({ listOperatorConversationSummaries: api.list, deleteOperatorConversation: api.remove, restoreOperatorConversation: api.restore }))
vi.mock('../../shared/api/operatorChatStream', () => ({ subscribeOperatorChat: () => () => {} }))
vi.mock('../provider-accounts/useProviderHarnessModels', () => ({ useProviderHarnessModels: () => ({ isSuccess: true, data: { models: [
  { id: 'model-a', name: 'Model A', reasoningEfforts: ['low', 'high'], serviceTiers: ['standard', 'priority'], variants: ['high'] },
  { id: 'model-b', name: 'Model B', reasoningEfforts: ['low'], serviceTiers: ['standard'], variants: [] },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', reasoningEfforts: ['low', 'medium', 'high'], serviceTiers: [], variants: [] },
  { id: 'claude-opus-5-5', name: 'Opus 5.5', reasoningEfforts: ['low', 'medium', 'high'], serviceTiers: [], variants: [] },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', reasoningEfforts: [], serviceTiers: [], variants: [] },
] } }) }))
vi.mock('../../shared/api/query', async (original) => ({ ...await original<typeof import('../../shared/api/query')>(), useHarnessDefaultsQuery: () => ({ data: { defaults: { ...DEFAULT_HARNESS_DEFAULTS, claude: savedClaudeConfiguration } } }) }))
let client: QueryClient
beforeEach(installCanonicalOperatorFixture)
beforeEach(() => {
  vi.clearAllMocks(); window.localStorage.clear()
  clearRevisionedFormPersistence()
  useConversationDraftStore.getState().clearAllDrafts()
  useOperatorChatStore.setState({ open: true, historyOpen: true, selectedConversationId: 'conversation-one' })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  api.get.mockImplementation(async (id) => operatorState({ conversation: { ...operatorState().conversation, id },
    messages: id === 'new-chat' ? [] : operatorState().messages.map((message) => ({ ...message, conversationId: id })),
    turnState: 'idle', activeRequestId: null }))
  api.list.mockResolvedValue({ conversations: [summarizeOperatorConversation(operatorState())] })
  api.remove.mockResolvedValue({ conversationId: 'conversation-one' })
  api.restore.mockResolvedValue({ conversationId: 'conversation-one' })
  api.create.mockResolvedValue({ conversation: { ...operatorState().conversation, id: 'new-chat' } })
})
afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks() })
/** The selected chat shows an editable placeholder draft until it loads; wait for the real composer. */
async function loadedComposerInput() {
  return within(await screen.findByRole('form', { name: 'Conversation composer' })).getByRole('textbox', { name: 'Message' })
}
function chat() { render(<QueryClientProvider client={client}><OperatorChatVisibilityProvider enabled><OperatorChat /></OperatorChatVisibilityProvider></QueryClientProvider>) }
describe('Operator chat UX', () => {
  it('opens the chat and sends an app request in a new conversation once', async () => {
    useOperatorChatStore.setState({ open: false, historyOpen: false })
    server.use(http.get('/api/operator/setup', () => HttpResponse.json(configuredOperatorSetup('codex'))))
    api.send.mockImplementation(async (id, command) => ({ replayed: false, state: operatorState({ conversation: { ...operatorState().conversation, id },
      turnState: 'idle', activeRequestId: null,
      messages: [{ id: 'asked', conversationId: id, requestId: command.requestId, role: 'user', content: command.content }] }) }))
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request: async (_name: string, _options: LockOptions, work: (lock: Lock) => unknown) => work({ name: 'outbox', mode: 'exclusive' } as Lock),
    } })
    try {
      chat()
      act(() => askOperator('Install Codex on Computer 1234abcd.'))
      await waitFor(() => expect(api.send).toHaveBeenCalledWith('new-chat', expect.objectContaining({ content: 'Install Codex on Computer 1234abcd.' })))
      expect(useOperatorChatStore.getState()).toMatchObject({ open: true, selectedConversationId: 'new-chat' })
      expect(api.create).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(client.isMutating()).toBe(0))
      await waitFor(() => expect(client.isFetching()).toBe(0))
      expect(api.send).toHaveBeenCalledTimes(1)
    } finally {
      if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
      else Reflect.deleteProperty(navigator, 'locks')
    }
  })
  it('reuses its verified MCP installation when starting another chat', async () => {
    let checks = 0
    server.use(http.get('/api/operator/setup', ({ request }) => {
      expect(new URL(request.url).searchParams.has('conversationId')).toBe(false)
      checks++
      return HttpResponse.json(configuredOperatorSetup('codex'))
    }))
    chat()
    await screen.findByRole('textbox', { name: 'Message' })
    await waitFor(() => expect(checks).toBe(1))
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    await waitFor(() => expect(useOperatorChatStore.getState().selectedConversationId).toBe('new-chat'))
    expect(await screen.findByRole('textbox', { name: 'Message' })).toBeVisible()
    expect(screen.queryByText('Checking Foreman Code MCP installation…')).not.toBeInTheDocument()
    expect(checks).toBe(1)
  })

  it('resolves the first accepted configuration when chat creation races an initial installation check', async () => {
    useOperatorChatStore.getState().select(undefined)
    let finishInitial!: () => void
    const initial = new Promise<void>((resolve) => { finishInitial = resolve })
    let checks = 0
    server.use(http.get('/api/operator/setup', async () => {
      checks++
      if (checks === 1) {
        await initial
        return HttpResponse.json({ ...configuredOperatorSetup('codex'), configurationVersionId: undefined })
      }
      return HttpResponse.json(configuredOperatorSetup('codex'))
    }))
    chat()
    await waitFor(() => expect(checks).toBe(1))
    fireEvent.click(await screen.findByRole('button', { name: 'Start chat' }))
    const input = await screen.findByRole('textbox', { name: 'Message' })
    fireEvent.change(input, { target: { value: 'Draft only' } })
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    finishInitial()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
    expect(checks).toBe(2)
    expect(api.send).not.toHaveBeenCalled()
  })

  it('recovers a stale selected chat without showing an MCP failure', async () => {
    api.get.mockRejectedValue(new ApiError({ code: 'CONVERSATION_NOT_FOUND', message: 'Missing conversation' }, 404))
    const setupTargets: Array<string | null> = []
    server.use(http.get('/api/operator/setup', ({ request }) => {
      const id = new URL(request.url).searchParams.get('conversationId')
      setupTargets.push(id)
      return id ? HttpResponse.json({ code: 'CONVERSATION_NOT_FOUND', message: 'Missing conversation' }, { status: 404 })
        : HttpResponse.json(configuredOperatorSetup('codex'))
    }))
    chat()
    expect(await screen.findByText(/The previous conversation is no longer available/)).toBeVisible()
    await waitFor(() => expect(setupTargets).toContain(null))
    expect(screen.queryByText('Foreman Code MCP could not be checked')).not.toBeInTheDocument()
    expect(screen.queryByText('Conversation could not be loaded')).not.toBeInTheDocument()
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(useOperatorChatStore.getState().selectedConversationId).toBeUndefined()
  })

  it('keeps saved settings usable on refresh failure and hides them after access is denied', async () => {
    chat()
    const input = await screen.findByRole('textbox', { name: 'Message' })
    fireEvent.change(input, { target: { value: 'Hello' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
    server.use(http.get('/api/management/settings/agents', () => HttpResponse.json({ code: 'UNAVAILABLE', message: 'Offline' }, { status: 503 })))
    await client.invalidateQueries({ queryKey: queryKeys.agentDefaults })
    expect(await screen.findByText('Could not refresh Operator settings')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled()
    server.use(http.get('/api/management/settings/agents', () => HttpResponse.json({ code: 'ACCESS_DENIED', message: 'Denied' }, { status: 403 })))
    await client.invalidateQueries({ queryKey: queryKeys.agentDefaults })
    expect(await screen.findByText('Operator settings access unavailable')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /Agent settings:/ })).not.toBeInTheDocument()
  })

  it('does not enable Send for configured setup without an accepted configuration ID', async () => {
    let inspected = false
    server.use(
      http.get('/api/management/settings/agents', () => HttpResponse.json({ revision: 1, versionId: null,
        value: { ...DEFAULT_AGENT_DEFAULTS, operator: { ...DEFAULT_AGENT_DEFAULTS.operator, harness: savedClaudeConfiguration } } })),
      http.get('/api/operator/setup', () => { inspected = true; return HttpResponse.json({ ...configuredOperatorSetup('claude'), configurationVersionId: undefined }) }),
    )
    chat()
    const input = await screen.findByRole('textbox', { name: 'Message' })
    fireEvent.change(input, { target: { value: 'Hello' } })
    await waitFor(() => {
      expect(inspected).toBe(true)
      const setup = client.getQueryCache().findAll({ queryKey: ['operator-chat', 'setup'] })
      expect(setup.length).toBeGreaterThan(0)
      expect(setup.some((query) => query.state.fetchStatus === 'idle' && query.state.status === 'success')).toBe(true)
    })
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(api.send).not.toHaveBeenCalled()
  })

  it('saves chat model and effort to shared Operator defaults and restores them in a future chat', async () => {
    const accepted = operatorChatSettings({ ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'model-b', reasoningEffort: 'low' })
    const pinned = operatorState({ settings: accepted, turnState: 'idle', activeRequestId: null })
    api.get.mockResolvedValue(pinned)
    api.send.mockResolvedValue({ state: pinned, replayed: false })
    chat()
    fireEvent.click(await screen.findByRole('button', { name: /Agent settings:/ }))
    expect(screen.getByLabelText('Accepted chat settings')).toHaveTextContent('This chat: Codex · model-b · low effort')
    expect(screen.getByText('These settings apply to new chats. The selected chat keeps its current settings.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /Choose model/ }))
    fireEvent.click(screen.getByRole('button', { name: /Model A/ }))
    await waitFor(async () => expect((await getManagedAgentDefaults()).value.operator.harness.model).toBe('model-a'))
    await waitFor(() => expect(screen.getByRole('slider', { name: 'Effort' })).toBeEnabled())
    fireEvent.change(screen.getByRole('slider', { name: 'Effort' }), { target: { value: '1' } })
    await waitFor(async () => expect((await getManagedAgentDefaults()).value.operator.harness).toMatchObject({ model: 'model-a', reasoningEffort: 'high' }))
    expect(screen.getByLabelText('Accepted chat settings')).toHaveTextContent('model-b · low effort')
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings: New chats, Model A, high' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Use this selected chat' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(api.send).toHaveBeenCalledWith('conversation-one', expect.objectContaining({ content: 'Use this selected chat', settings: accepted })))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(''))
    const future = operatorChatSettings((await getManagedAgentDefaults()).value.operator.harness)
    cleanup(); client.clear(); clearRevisionedFormPersistence()
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    useOperatorChatStore.getState().select('future-chat')
    api.get.mockResolvedValue(operatorState({ conversation: { ...operatorState().conversation, id: 'future-chat' }, settings: future, turnState: 'idle', activeRequestId: null }))
    chat()
    fireEvent.click(await screen.findByRole('button', { name: 'Agent settings: New chats, Model A, high' }))
    expect(screen.getByLabelText('Accepted chat settings')).toHaveTextContent('model-a · high effort')
    expect(screen.getByRole('switch', { name: 'Show thinking' })).toBeInTheDocument()
  })

  it('saves Haiku without inherited effort through the mounted chat picker and restores supported efforts without changing pinned chat access', async () => {
    const harness = { harness: 'claude' as const, model: 'claude-sonnet-5-5', effort: 'medium' as const,
      authMode: 'subscription' as const, configDirectory: '/unit/profile', permissionMode: 'default' as const,
      sandbox: 'danger-full-access' as const, tools: ['Read', 'Write'], permissionRules: [], instructions: 'Keep the saved policy.', mcpServers: {} }
    let saved: ManagedAgentDefaults = { revision: 6, versionId: null, value: { ...DEFAULT_AGENT_DEFAULTS,
      operator: { ...DEFAULT_AGENT_DEFAULTS.operator, harness } } }
    const requests: AgentDefaultsUpdateInput[] = []
    const pinned = operatorState({ turnState: 'idle', activeRequestId: null, settings: operatorChatSettings({ ...harness, model: 'claude-opus-5-5' }),
      messages: [{ id: 'original-answer', conversationId: 'conversation-one', requestId: 'original-turn', role: 'assistant', content: 'Hello!',
        acceptedModel: { harness: 'claude', model: 'claude-opus-5-5' } }] })
    api.get.mockResolvedValue(pinned)
    server.use(
      http.get('/api/management/harnesses/claude/options', () => HttpResponse.json({
        harness: 'claude', providerVersion: 'mock', authenticated: true,
        models: [
          { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', reasoningEfforts: ['low', 'medium', 'high'],
            serviceTiers: [], variants: [] },
          { id: 'claude-opus-5-5', name: 'Opus 5.5', reasoningEfforts: ['low', 'medium', 'high'],
            serviceTiers: [], variants: [] },
          { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', reasoningEfforts: [], serviceTiers: [], variants: [] },
        ],
        nativeAgents: [], settings: [], restrictions: [], checkedAt: new Date().toISOString(),
      })),
      http.get('/api/management/settings/agents', () => HttpResponse.json(saved)),
      http.put('/api/management/settings/agents', async ({ request }) => {
        const input = AgentDefaultsUpdateInputSchema.parse(await request.json())
        requests.push(input)
        if (input.value.operator.harness.harness === 'claude' && input.value.operator.harness.model === 'claude-haiku-4-5-20251001'
          && Object.hasOwn(input.value.operator.harness, 'effort')) return HttpResponse.json({ error: { code: 'CLAUDE_DEFAULT_SETUP_UNQUALIFIED',
            message: 'The accepted model and effort are absent from the exact native catalog.' } }, { status: 409 })
        saved = { ...saved, revision: saved.revision + 1, value: input.value }
        return HttpResponse.json({ value: saved, replayed: false })
      }),
      http.get('/api/operator/setup', () => HttpResponse.json(configuredOperatorSetup('claude'))),
    )
    chat()
    fireEvent.click(await screen.findByRole('button', { name: 'Agent settings: New chats, Sonnet 5.5, medium' }))
    const choose = async (name: string, id: string) => {
      fireEvent.click(screen.getByRole('button', { name: /Choose model/ }))
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`${name}.*${id}`) }))
    }
    await choose('Haiku 4.5', 'claude-haiku-4-5-20251001')
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]!.value.operator.harness).not.toHaveProperty('effort')
    await waitFor(() => expect(saved.value.operator.harness.model).toBe('claude-haiku-4-5-20251001'))
    const nativeDefault: HarnessConfiguration = { ...harness, model: 'claude-haiku-4-5-20251001' }
    delete nativeDefault.effort
    expect(saved.value.operator.harness).toEqual(nativeDefault)
    expect(screen.queryByText('Changes were not saved')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Agent settings: New chats, Haiku 4.5' })).toBeEnabled())
    expect(screen.queryByRole('slider', { name: 'Effort' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: /Choose model/ })).toBeEnabled())
    await choose('Sonnet 5.5', 'claude-sonnet-5-5')
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]!.value.operator.harness).toEqual(harness)
    await waitFor(() => expect(screen.getByRole('slider', { name: 'Effort' })).toBeEnabled())
    fireEvent.change(screen.getByRole('slider', { name: 'Effort' }), { target: { value: '2' } })
    await waitFor(() => expect(requests).toHaveLength(3))
    await waitFor(() => expect(screen.getByRole('button', { name: /Choose model/ })).toBeEnabled())
    await choose('Opus 5.5', 'claude-opus-5-5')
    await waitFor(() => expect(requests).toHaveLength(4))
    expect(requests[3]!.value.operator.harness).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', sandbox: harness.sandbox,
      tools: harness.tools, instructions: harness.instructions })
    expect(screen.getByRole('article', { name: 'Message from Opus 5.5' })).toHaveTextContent('Hello!')
    expect(api.send).not.toHaveBeenCalled()
    await expect(api.get.mock.results[0]!.value).resolves.toEqual(pinned)
  })

  it.each(['retry settings', 'select a supported model', 'retry a frozen request'])('handles an older Haiku draft when choosing to %s', async (action) => {
    const harness = { harness: 'claude' as const, model: 'claude-sonnet-5-5', effort: 'medium' as const,
      authMode: 'subscription' as const, configDirectory: '/unit/profile', permissionMode: 'default' as const,
      sandbox: 'danger-full-access' as const, tools: ['Read', 'Write'], permissionRules: [], instructions: 'Keep the saved policy.', mcpServers: {} }
    let saved: ManagedAgentDefaults = { revision: 6, versionId: null, value: { ...DEFAULT_AGENT_DEFAULTS,
      operator: { ...DEFAULT_AGENT_DEFAULTS.operator, harness } } }
    const draft = renderHook(() => useRevisionedForm(saved, 'operator-chat:defaults'))
    await waitFor(() => expect(draft.result.current.draft).toBeDefined())
    act(() => draft.result.current.setDraft({ ...saved.value, operator: { ...saved.value.operator,
      harness: { ...harness, model: 'claude-haiku-4-5-20251001' } } }))
    let frozenRequest: AgentDefaultsUpdateInput | undefined
    await act(async () => { await draft.result.current.save(async (input) => {
      frozenRequest = structuredClone(input)
      throw new ApiError({ code: action === 'retry a frozen request' ? 'UNAVAILABLE' : 'CLAUDE_DEFAULT_SETUP_UNQUALIFIED',
        message: 'The accepted model and effort are absent from the exact native catalog.' }, action === 'retry a frozen request' ? 503 : 409)
    }) })
    draft.unmount()
    const requests: AgentDefaultsUpdateInput[] = []
    server.use(
      http.get('/api/management/settings/agents', () => HttpResponse.json(saved)),
      http.put('/api/management/settings/agents', async ({ request }) => {
        const input = AgentDefaultsUpdateInputSchema.parse(await request.json())
        requests.push(input)
        if (action === 'retry a frozen request') return HttpResponse.json({ error: { code: 'CLAUDE_DEFAULT_SETUP_UNQUALIFIED',
          message: 'The accepted model and effort are absent from the exact native catalog.' } }, { status: 409 })
        saved = { ...saved, revision: saved.revision + 1, value: input.value }
        return HttpResponse.json({ value: saved, replayed: false })
      }),
      http.get('/api/operator/setup', () => HttpResponse.json(configuredOperatorSetup('claude'))),
    )
    chat()
    if (action === 'retry a frozen request') expect(await screen.findByText(/The previous save may have committed/)).toBeVisible()
    else expect(await screen.findByText('Changes were not saved')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Agent settings: New chats, Haiku 4.5, medium' })).toBeVisible()
    if (action !== 'select a supported model') fireEvent.click(screen.getByRole('button', { name: 'Retry settings save' }))
    else {
      fireEvent.click(screen.getByRole('button', { name: 'Agent settings: New chats, Haiku 4.5, medium' }))
      fireEvent.click(screen.getByRole('button', { name: /Choose model/ }))
      fireEvent.click(screen.getByRole('button', { name: /Sonnet 5.5.*claude-sonnet-5-5/ }))
    }
    await waitFor(() => expect(requests).toHaveLength(1))
    if (action === 'retry a frozen request') {
      expect(requests[0]).toEqual(frozenRequest)
      expect(requests[0]!.value.operator.harness).toMatchObject({ model: 'claude-haiku-4-5-20251001', effort: 'medium' })
      expect(saved.revision).toBe(6)
      expect(await screen.findByText('Changes were not saved')).toBeVisible()
      expect(api.send).not.toHaveBeenCalled()
      return
    }
    if (action === 'retry settings') expect(requests[0]!.value.operator.harness).not.toHaveProperty('effort')
    else expect(requests[0]!.value.operator.harness).toEqual(harness)
    expect(requests[0]!.expectedRevision).toBe(6)
    expect(requests[0]!.value.operator.harness).toMatchObject({ model: action === 'retry settings' ? 'claude-haiku-4-5-20251001' : harness.model, sandbox: harness.sandbox,
      tools: harness.tools, instructions: harness.instructions })
    await waitFor(() => expect(screen.queryByText('Changes were not saved')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: action === 'retry settings' ? 'Agent settings: New chats, Haiku 4.5' : 'Agent settings: New chats, Sonnet 5.5, medium' })).toBeVisible()
    expect(api.send).not.toHaveBeenCalled()
  })

  it('saves the Codex sandbox to Operator defaults and keeps it for a new chat', async () => {
    chat()
    await screen.findByRole('textbox', { name: 'Message' })
    expect(screen.queryByText('Access changes apply to new chats and harness handoffs. Existing chats keep their accepted access policy.')).not.toBeInTheDocument()
    expect(screen.queryByText('Access edits apply to new chats and harness handoffs. This chat keeps its pinned access policy.')).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: /Agent settings:/ }))
    const user = userEvent.setup()
    const access = within(screen.getByRole('group', { name: 'Operator access' }))
    const guidance = 'Access changes apply to new chats and harness handoffs. Existing chats keep their accepted access policy.'
    expect(screen.queryByText(guidance)).not.toBeInTheDocument()
    const accessHint = access.getByRole('button', { name: 'About Operator access' })
    await user.hover(accessHint)
    expect(screen.getByRole('tooltip')).toHaveTextContent(guidance)
    await user.unhover(accessHint)
    expect(screen.getByRole('combobox', { name: 'Sandbox' })).toHaveValue('danger-full-access')
    expect(screen.queryByText('Saved to Operator defaults for your next message and future chats.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Operator access:/ })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'Sandbox' }), { target: { value: 'workspace-write' } })
    await waitFor(async () => expect((await getManagedAgentDefaults()).value.operator.harness).toMatchObject({ harness: 'codex', sandbox: 'workspace-write' }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Approval requests' })).toBeEnabled())
    fireEvent.change(screen.getByRole('combobox', { name: 'Approval requests' }), { target: { value: 'never' } })
    await waitFor(async () => expect((await getManagedAgentDefaults()).value.operator.harness).toMatchObject({ sandbox: 'workspace-write',
      advanced: { approvalPolicy: 'never' } }))
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    await waitFor(() => expect(useOperatorChatStore.getState().selectedConversationId).toBe('new-chat'))
    fireEvent.click(await screen.findByRole('button', { name: /Agent settings:/ }))
    expect(screen.getByRole('combobox', { name: 'Sandbox' })).toHaveValue('workspace-write')
  })


  it('keeps a draft pinned after changing harness and requires explicit new-chat navigation', async () => {
    const source = operatorState({ revision: 7, turnState: 'idle', activeRequestId: null,
      settings: operatorChatSettings(DEFAULT_HARNESS_DEFAULTS.codex),
      messages: [{ id: 'old-message', conversationId: 'conversation-one', role: 'assistant', content: 'Earlier answer' }] })
    const before = await getManagedAgentDefaults()
    await updateManagedAgentDefaults({ commandId: 'choose-claude-for-new-chat', expectedRevision: before.revision,
      value: { ...before.value, operator: { ...before.value.operator, harness: savedClaudeConfiguration } } })
    api.get.mockImplementation(async id => id === source.conversation.id ? source : operatorState({
      conversation: { ...source.conversation, id }, settings: operatorChatSettings(savedClaudeConfiguration),
      messages: [], turnState: 'idle', activeRequestId: null }))
    chat()
    expect(await screen.findByText('Changed Operator settings apply to a new chat. This draft stays with the selected conversation.')).toBeVisible()
    const input = screen.getByRole('textbox', { name: 'Message' })
    fireEvent.change(input, { target: { value: 'Continue here' } })
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(api.send).not.toHaveBeenCalled()
    expect(useOperatorChatStore.getState().selectedConversationId).toBe('conversation-one')
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    await waitFor(() => expect(useOperatorChatStore.getState().selectedConversationId).toBe('new-chat'))
    expect(useConversationDraftStore.getState().drafts['conversation-one']).toBe('Continue here')
    expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveValue('')
  })

  it('does not promise a handoff when a new chat has no previous messages', async () => {
    const before = await getManagedAgentDefaults()
    await updateManagedAgentDefaults({ commandId: 'choose-claude-for-empty-chat', expectedRevision: before.revision,
      value: { ...before.value, operator: { ...before.value.operator, harness: savedClaudeConfiguration } } })
    api.get.mockResolvedValue(operatorState({ turnState: 'idle', activeRequestId: null, messages: [],
      settings: operatorChatSettings(DEFAULT_HARNESS_DEFAULTS.codex) }))
    chat()
    expect(await screen.findByRole('textbox', { name: 'Message' })).toBeVisible()
    expect(screen.queryByText(/Your next message starts/)).not.toBeInTheDocument()
  })

  it('retains an uncertain settings save and retries the same revision and command before allowing send', async () => {
    const before = await getManagedAgentDefaults()
    const requests: Record<string, unknown>[] = []
    server.use(http.put('/api/management/settings/agents', async ({ request }) => {
      const input = await request.json() as Record<string, unknown>; requests.push(input)
      return requests.length === 1 ? HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Save outcome unknown' } }, { status: 503 })
        : HttpResponse.json({ replayed: true, value: { ...before, revision: before.revision + 1, value: input.value } })
    }))
    chat()
    fireEvent.click(await screen.findByRole('button', { name: /Agent settings:/ }))
    fireEvent.click(screen.getByRole('button', { name: /Choose model/ }))
    fireEvent.click(screen.getByRole('button', { name: /Model A/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Hello' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Retry settings save' }))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]).toEqual(requests[0])
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
  })

  it('handles /new locally even while a turn is running, without sending it to the agent', async () => {
    api.get.mockResolvedValue(operatorState())
    chat()
    const input = await loadedComposerInput()
    fireEvent.change(input, { target: { value: '/new' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(useOperatorChatStore.getState().selectedConversationId).toBe('new-chat'))
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(api.send).not.toHaveBeenCalled()
    expect(useConversationDraftStore.getState().drafts['conversation-one']).toBeUndefined()
  })
  it('offers /new on slash and executes it with Enter without sending a message', async () => {
    chat()
    const input = await loadedComposerInput()
    fireEvent.change(input, { target: { value: '/' } })
    expect(screen.getByRole('listbox', { name: 'Chat commands' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /new/ })).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: /new/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
    expect(api.send).not.toHaveBeenCalled()
  })
  it('retains /new when creation fails', async () => {
    api.create.mockRejectedValue(new Error('Offline'))
    chat()
    const input = await loadedComposerInput()
    fireEvent.change(input, { target: { value: '/new' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByText('Offline')).toBeInTheDocument()
    expect(input).toHaveValue('/new')
  })
  it('loads older chat rows on scroll without replacing the visible history', async () => {
    api.list.mockImplementation(async (_options, limit = 10) => ({ hasMore: limit < 21, conversations: Array.from({ length: Math.min(limit, 21) }, (_, i) => ({ ...summarizeOperatorConversation(operatorState()), conversationId: `chat-${i}`, title: `Topic ${i}` })) }))
    chat()
    // Scoped to the history panel: role queries over the whole chat dialog are slow enough to time out under CI load.
    const history = await screen.findByRole('complementary', { name: 'Operator conversation history' })
    await within(history).findByRole('button', { name: /^Topic 0(?: |$)/ })
    expect(within(history).queryByRole('button', { name: /^Topic 10(?: |$)/ })).not.toBeInTheDocument()
    fireEvent.scroll(history)
    expect(await within(history).findByRole('button', { name: /^Topic 10(?: |$)/ })).toBeInTheDocument()
    expect(api.list).toHaveBeenLastCalledWith(expect.anything(), 20)
    expect(within(history).getByRole('button', { name: /^Topic 0(?: |$)/ })).toBeInTheDocument()
    expect(screen.queryByLabelText('Switch conversation')).not.toBeInTheDocument()
    expect(screen.queryByText(/accepted request IDs/)).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Close Operator chat' })).toHaveLength(1)
  })
  it('removes a chat through its menu and restores it with Undo, without stale polls resurrecting it', async () => {
    const original = operatorState({ turnState: 'idle', activeRequestId: null })
    const restored = operatorState({ turnState: 'idle', activeRequestId: null, revision: original.revision + 2 })
    const staleList = { conversations: [summarizeOperatorConversation(original)] }
    api.list.mockResolvedValue(staleList)
    api.remove.mockResolvedValue({ conversationId: original.conversation.id, revision: original.revision + 1 })
    api.restore.mockImplementation(async () => {
      api.list.mockResolvedValue({ conversations: [summarizeOperatorConversation(restored)] })
      api.get.mockResolvedValue(restored)
      return { conversationId: restored.conversation.id, revision: restored.revision }
    })
    chat()
    fireEvent.click(await screen.findByRole('button', { name: 'Chat options: First conversation' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('conversation-one'))
    await waitFor(() => expect(screen.queryByRole('button', { name: /^First conversation/ })).not.toBeInTheDocument())
    await act(async () => { await client.invalidateQueries({ queryKey: ['operator-chat', 'summaries'] }) })
    expect(screen.queryByRole('button', { name: /^First conversation/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(api.restore).toHaveBeenCalledWith('conversation-one'))
    expect(await screen.findByRole('button', { name: /^First conversation/ })).toBeInTheDocument()
    api.list.mockResolvedValue(staleList)
    await act(async () => { await client.invalidateQueries({ queryKey: ['operator-chat', 'summaries'] }) })
    expect(screen.getByRole('button', { name: /^First conversation/ })).toBeInTheDocument()
  })

  it('exposes all eight resize handles and keeps titles out of the modal header', async () => {
    chat()
    await screen.findByRole('textbox', { name: 'Message' })
    expect(screen.getAllByRole('button', { name: /^Resize Operator chat/ })).toHaveLength(8)
    expect(screen.getByRole('dialog', { name: 'Operator chat' }).querySelector(':scope > header')).toBeNull()
    expect(screen.queryByText(/^Operator ·/)).not.toBeInTheDocument()
  })

  it('resizes with keyboard controls and bounds the panel to the viewport', async () => {
    chat()
    const panel = screen.getByRole('dialog', { name: 'Operator chat' })
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 700, 500))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Resize Operator chat' }), { key: 'ArrowLeft' })
    expect(panel.style.width).toBe('732px')
    expect(panel.style.height).toBe('500px')
  })
  it('shows a typing indicator only while the turn is active', async () => {
    api.get.mockResolvedValue(operatorState())
    chat()
    expect(await screen.findByLabelText('Operator is typing')).toBeInTheDocument()
  })
  it('ignores legacy per-conversation settings so saved Operator defaults remain authoritative', () => {
    const settings = operatorChatSettings(DEFAULT_HARNESS_DEFAULTS.codex, true)
    expect(parseChatPreferences({ open: true, settingsDrafts: { 'conversation-one': settings } })).toEqual({ open: true })
  })

  it('normalizes unsupported effort and fast mode when changing models', () => {
    const onChange = vi.fn()
    render(<QueryClientProvider client={client}><OperatorComposerSettings disabled={false} onChange={onChange}
      value={{ harness: 'codex', model: 'model-a', reasoningEffort: 'high', serviceTier: 'priority', showThinking: false }} /></QueryClientProvider>)
    expect(screen.getByRole('button', { name: /Agent settings:.*Fast/ })).toHaveTextContent('Fast')
    fireEvent.click(screen.getByRole('button', { name: /Agent settings:/ }))
    fireEvent.click(screen.getByRole('button', { name: /Model A Choose model/ }))
    fireEvent.click(screen.getByRole('button', { name: /Model B model-b/ }))
    expect(onChange).toHaveBeenCalledWith({ harness: 'codex', model: 'model-b', reasoningEffort: 'low', serviceTier: 'standard', showThinking: false })
    expect(screen.getByRole('switch', { name: 'Show thinking' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Claude' }))
    expect(onChange).toHaveBeenLastCalledWith(operatorChatSettings(savedClaudeConfiguration))
  })
  it('returns keyboard focus to effort after an automatic settings save', () => {
    const onChange = vi.fn()
    const value = { harness: 'codex' as const, model: 'model-a', reasoningEffort: 'high' as const,
      serviceTier: 'standard' as const, showThinking: false }
    const view = render(<QueryClientProvider client={client}><OperatorComposerSettings disabled={false} onChange={onChange} value={value} /></QueryClientProvider>)
    fireEvent.click(screen.getByRole('button', { name: /Agent settings:/ }))
    const slider = screen.getByRole('slider', { name: 'Effort' })
    slider.focus()
    fireEvent.change(slider, { target: { value: '0' } })
    expect(onChange).toHaveBeenCalledWith({ ...value, reasoningEffort: 'low' })
    view.rerender(<QueryClientProvider client={client}><OperatorComposerSettings disabled onChange={onChange} value={{ ...value, reasoningEffort: 'low' }} /></QueryClientProvider>)
    slider.blur()
    view.rerender(<QueryClientProvider client={client}><OperatorComposerSettings disabled={false} onChange={onChange} value={{ ...value, reasoningEffort: 'low' }} /></QueryClientProvider>)
    expect(slider).toHaveFocus()
  })
})


async function withPr19Locks(work: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(navigator, 'locks')
  let tail: Promise<unknown> = Promise.resolve()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: (_name: string, options: LockOptions, callback: (lock: Lock) => unknown) => {
      const next = tail.catch(() => { /* ignore: a failed holder releases the lock; its caller already saw the error */ }).then(() => {
        options.signal?.throwIfAborted()
        return callback({ name: 'graphql.operator-outbox.v1', mode: 'exclusive' } as Lock)
      })
      tail = next
      return next
    },
  } })
  try { await work() }
  finally { if (original) Object.defineProperty(navigator, 'locks', original); else Reflect.deleteProperty(navigator, 'locks') }
}

describe('PR19 receipt recovery and navigation fencing', () => {
  it('recovers a saved Codex receipt while current Claude setup is unavailable, without a new command identity', async () => withPr19Locks(async () => {
    const outbox = await import('./operatorOutbox')
    const command = await outbox.reserveOperatorMessage('conversation-one', 'Already accepted.', '/original',
      operatorChatSettings(DEFAULT_HARNESS_DEFAULTS.codex), undefined, { configurationVersionId: 'original-config', defaultsRevision: 1 })
    const attempt = await outbox.beginOperatorMessageAttempt('conversation-one', command)
    await outbox.recordOperatorMessageFailure('conversation-one', command.requestId, 'Response lost.', false, attempt)
    server.use(
      http.get('/api/management/settings/agents', () => HttpResponse.json({ revision: 8, versionId: null,
        value: { ...DEFAULT_AGENT_DEFAULTS, operator: { ...DEFAULT_AGENT_DEFAULTS.operator, harness: savedClaudeConfiguration } } })),
      http.get('/api/operator/setup', () => HttpResponse.json({ harness: 'claude', status: 'setup_required',
        endpoint: 'http://127.0.0.1:3000/mcp', checkedAt: new Date().toISOString() })),
    )
    api.send.mockResolvedValue({ replayed: true, state: operatorState({ turnState: 'idle', activeRequestId: null,
      messages: [{ id: 'accepted-message', conversationId: 'conversation-one', requestId: command.requestId, role: 'user', content: command.content }] }) })
    chat()
    const retry = await screen.findByRole('button', { name: 'Retry pending message' })
    expect(retry).toBeEnabled()
    expect(await screen.findByRole('button', { name: /Agent settings:/ })).toBeDisabled()
    fireEvent.click(retry)
    await waitFor(() => expect(api.send).toHaveBeenCalledWith('conversation-one', { ...command, recovery: 'receipt' }))
    await waitFor(() => expect(outbox.readPendingOperatorMessage('conversation-one').command).toBeUndefined())
    expect(api.send).toHaveBeenCalledTimes(1)
  }))

  it.each(['another chat', 'new chat', 'away and back'] as const)('does not clear another draft or steal selection after navigating to %s during a canonical send', async destination => {
    const source = operatorState({ revision: 7, turnState: 'idle', activeRequestId: null,
      conversation: { ...operatorState().conversation, operatorConfigurationVersionId: 'source-config' },
      messages: [{ id: 'old-message', conversationId: 'conversation-one', role: 'assistant', content: 'Earlier answer' }] })
    api.get.mockImplementation(async (id: string) => id === 'conversation-one' ? source : operatorState({
      conversation: { ...source.conversation, id }, turnState: 'idle', activeRequestId: null, messages: [] }))
    api.list.mockResolvedValue({ conversations: [summarizeOperatorConversation(source)] })
    let resolve!: (value: unknown) => void
    api.send.mockImplementation(() => new Promise(done => { resolve = done }))
    chat()
    const input = await screen.findByRole('textbox', { name: 'Message' })
    fireEvent.change(input, { target: { value: 'Continue here' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1))
    const command = api.send.mock.calls[0]![1]
    expect(command.configurationVersionId).toBe('source-config')
    if (destination === 'new chat') {
      fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
      await waitFor(() => expect(useOperatorChatStore.getState().selectedConversationId).toBe('new-chat'))
    } else act(() => {
      useOperatorChatStore.getState().select('another-chat')
      if (destination === 'away and back') useOperatorChatStore.getState().select('conversation-one')
    })
    const selected = useOperatorChatStore.getState().selectedConversationId
    const nextInput = await screen.findByRole('textbox', { name: 'Message' })
    fireEvent.change(nextInput, { target: { value: 'A later editable draft' } })
    await act(async () => resolve({ replayed: false, state: source }))
    await waitFor(() => expect(client.isMutating()).toBe(0))
    expect(useOperatorChatStore.getState().selectedConversationId).toBe(selected)
    expect(nextInput).toHaveValue('A later editable draft')
    expect(api.send).toHaveBeenCalledTimes(1)
  })
})

it('keeps historical OpenCode messages visible with no composer or response controls', async () => {
  const state = operatorState({ turnState: 'idle', activeRequestId: null,
    settings: { harness: 'opencode', model: 'provider/saved-model', variant: 'saved-variant', showThinking: true } })
  api.get.mockResolvedValue(state)
  chat()
  expect((await screen.findAllByText('Retired harness (OpenCode): read-only'))[0]).toBeVisible()
  expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Agent settings:/ })).not.toBeInTheDocument()
  expect(api.send).not.toHaveBeenCalled()
})

it('keeps an unselected retired conversation read-only beside a supported conversation', async () => {
  const supported = operatorState({ turnState: 'idle', activeRequestId: null })
  const retired = operatorState({ turnState: 'idle', activeRequestId: null,
    conversation: { ...supported.conversation, id: 'retired-chat', title: 'Historical chat' },
    settings: { harness: 'opencode', model: 'provider/saved-model', variant: 'saved-variant', showThinking: true } })
  api.list.mockResolvedValue({ conversations: [summarizeOperatorConversation(supported), summarizeOperatorConversation(retired)] })
  api.get.mockImplementation(async id => id === 'retired-chat' ? retired : supported)
  chat()
  expect(await screen.findByRole('textbox', { name: 'Message' })).toBeVisible()
  expect(await screen.findByText('Retired harness (OpenCode): read-only')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Chat options: Historical chat' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Chat options: First conversation' }))
  expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeEnabled()
  expect(api.remove).not.toHaveBeenCalled()
})

it('reads a historical chat when the saved Operator defaults also use the retired harness', async () => {
  server.use(http.get('/api/management/settings/agents', () => HttpResponse.json({ revision: 1, versionId: null,
    value: { ...DEFAULT_AGENT_DEFAULTS, operator: { ...DEFAULT_AGENT_DEFAULTS.operator,
      harness: { harness: 'opencode', model: 'provider/saved-model', variant: '', nativeAgent: 'build',
        thinking: true, autoApprove: false } } } })))
  api.get.mockResolvedValue(operatorState({ turnState: 'idle', activeRequestId: null,
    settings: { harness: 'opencode', model: 'provider/saved-model', variant: '', showThinking: true } }))
  chat()
  expect((await screen.findAllByText('Retired harness (OpenCode): read-only'))[0]).toBeVisible()
  expect(screen.getByRole('region', { name: 'Operator transcript' })).toBeVisible()
  expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
  expect(api.send).not.toHaveBeenCalled()
})
