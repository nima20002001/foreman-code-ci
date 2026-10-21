import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { DEFAULT_HARNESS_DEFAULTS, operatorChatSettings, SessionControlStateSchema,
  unavailableSessionControls } from '@foreman-code/contracts'
import { agentChatFixtures } from '@foreman-code/contracts/agent-chat'
import type { AcceptedProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import { server } from '../../mocks/server'
import { OperatorChat } from '../operator-chat/OperatorChat'
import { useOperatorChatStore } from '../operator-chat/operatorChatStore'
import { summarizeOperatorConversation } from '../operator-chat/operatorChatStatus'
import { configuredOperatorSetup } from '../operator-chat/operatorSetupTestFixture'
import { operatorState } from '../operator-chat/pr17-test-fixtures'
import { OperatorChatVisibilityProvider } from '../operator-chat/visibility'
import { savedClaudeConfiguration } from '../settings/claudeSettings.fixtures'
import { clearRevisionedFormPersistence } from '../settings/revisionedForm'
import { installChatSource, mountChat } from './agentChat/testSupport'
import { useConversationDraftStore } from './conversationDraftStore'

vi.mock('../../shared/api/operatorChatStream', () => ({ subscribeOperatorChat: () => () => undefined }))

const clients: QueryClient[] = []
type Surface = 'Operator' | 'Agent'
type Provider = 'codex' | 'claude'

beforeEach(() => {
  localStorage.clear()
  clearRevisionedFormPersistence()
  useConversationDraftStore.getState().clearAllDrafts()
  useOperatorChatStore.getState().reset()
  installChatSource()
})

afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  useOperatorChatStore.getState().reset()
  vi.unstubAllGlobals()
})

function mount(surface: Surface, provider: Provider, planSupported: boolean,
  binding?: AcceptedProviderAccountBinding) {
  const conversationId = surface === 'Operator' ? 'conversation-one' : agentChatFixtures.idleAfterCompletion.conversation.id
  const capabilities = unavailableSessionControls('saved-profile')
  const controls = SessionControlStateSchema.parse({
    conversationId, revision: 1, profileKey: 'saved-profile', desiredMode: 'regular', appliedMode: 'regular',
    defaults: {}, desired: {}, applied: {}, applicability: 'safe-resume', nativeStatus: 'resume-required',
    nativeSessionId: 'saved-native-session', nativeProviderVersion: 'fixture', compaction: null, compactions: [],
    busyReason: null, capabilities: { ...capabilities, plan: { supported: planSupported, reason: null } },
    context: { nativeSessionId: 'saved-native-session', model: 'model', generation: 'saved-connection', sequence: 1,
      observedAt: '2026-10-01T00:00:00.000Z', source: provider, accuracy: 'native', usedTokens: 50000,
      capacityTokens: 100000, lifetimeTokens: 50000, cost: null, stale: true },
  })
  const root = surface === 'Operator' ? '/api/operator/conversations/:id'
    : '/api/workspaces/:workspaceId/agent-chat/conversations/:id'
  server.use(http.get(`${root}/session-controls`, () => HttpResponse.json(controls)))
  if (surface === 'Agent') {
    const state = structuredClone(agentChatFixtures.idleAfterCompletion)
    state.conversation.harness = provider
    state.capabilities.harness = provider
    if (binding) state.conversation.providerAccountBinding = binding
    const view = mountChat(state)
    clients.push(view.client)
    return
  }
  const configuration = provider === 'codex' ? DEFAULT_HARNESS_DEFAULTS.codex : savedClaudeConfiguration
  const state = operatorState({ turnState: 'idle', activeRequestId: null,
    settings: operatorChatSettings(configuration), ...(binding ? { providerAccountBinding: binding } : {}),
  })
  server.use(
    http.get('/api/operator/setup', () => HttpResponse.json(configuredOperatorSetup(provider))),
    http.get('/api/operator/conversations/summaries', () => HttpResponse.json({
      conversations: [summarizeOperatorConversation(state)],
    })),
    http.get('/api/operator/conversations/:id', () => HttpResponse.json(state)),
  )
  useOperatorChatStore.setState({ open: true, historyOpen: false, selectedConversationId: conversationId })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><OperatorChatVisibilityProvider enabled>
    <OperatorChat />
  </OperatorChatVisibilityProvider></QueryClientProvider>)
}

for (const surface of ['Operator', 'Agent'] as const) describe(`${surface} chat notices`, () => {
  it.each(['codex', 'claude'] as const)('hides legacy %s profile information throughout the chat', async provider => {
    mount(surface, provider, true, { kind: 'legacy-profile', provider, target: null,
      profileRef: provider === 'codex' ? 'saved-profile' : null, historicalSubject: 'unknown' })
    const meter = await screen.findByRole('button', { name: '50% context · stale' })
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeVisible()
    expect(screen.queryAllByText(/legacy.*profile|historical provider identity is unknown/i)).toHaveLength(0)
    expect(screen.queryByTitle(/legacy.*profile/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Saved account details' })).not.toBeInTheDocument()
    fireEvent.click(meter)
    expect(screen.queryAllByText(/legacy.*profile|historical provider identity is unknown/i)).toHaveLength(0)
  })

  it.each([true, false])('keeps resume-required controls quiet with native plan support %s', async supported => {
    mount(surface, 'codex', supported)
    const meter = await screen.findByRole('button', { name: '50% context · stale' })
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeVisible()
    expect(screen.queryAllByText(/saved session controls|next message or control|send a message to resume/i))
      .toHaveLength(0)
    expect(screen.queryAllByText(/historical provider identity is unknown|saved account: not recorded/i)).toHaveLength(0)
    fireEvent.click(meter)
    expect(screen.queryAllByText(/saved session controls|next message or control|send a message to resume/i))
      .toHaveLength(0)
  })
})
