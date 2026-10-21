import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { expect, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import type { ManagementAction } from '@foreman-code/contracts/management'
import type { AgentChatContext, AgentChatState, AgentChatStreamEvent } from '@foreman-code/contracts/agent-chat'
import { agentChatFixtures } from '@foreman-code/contracts/agent-chat'
import { CODEX_APPROVAL_OPTIONS_FIXTURE } from '@foreman-code/contracts'
import { AgentChatPanel } from '../../graph/AgentPanels'
import { server } from '../../../mocks/server'
import { createAgentChatMock } from '../../../shared/mocks/agentChatHandlers'
import { agentChatStateKey } from './useAgentChat'

/** A controlled wire, not a running browser or native harness. HTTP remains intercepted by MSW. */
export class AgentChatTestSource extends EventTarget {
  static instances: AgentChatTestSource[] = []
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  readyState = 0
  close = vi.fn(() => { this.readyState = 2 })
  constructor(readonly url: string) { super(); AgentChatTestSource.instances.push(this) }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  snapshot(state: AgentChatState, id = 0) {
    this.event({ id, conversationId: state.conversation!.id, type: 'snapshot', data: state as unknown as Record<string, unknown> })
  }
  event(event: AgentChatStreamEvent) { this.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event) })) }
  fail() { this.dispatchEvent(new Event('error')) }
}
export function installChatSource() {
  AgentChatTestSource.instances = []
  vi.stubGlobal('EventSource', AgentChatTestSource)
}
export function approvalState(): AgentChatState {
  const state: AgentChatState = structuredClone(agentChatFixtures.active)
  state.sessionState = 'waiting_approval'
  state.pendingInteraction = {
    session: { harness: 'codex', nativeSessionId: state.conversation!.nativeSession!.nativeSessionId, providerVersion: '0.157.1' },
    turn: { nativeTurnId: 'turn-1', nativeRequestId: 'native-approval-1' }, nativeRequestType: 'item/commandExecution/requestApproval',
    request: { command: ['read', 'README.md'] }, responseOptions: CODEX_APPROVAL_OPTIONS_FIXTURE,
  }
  state.responseAvailability = { nativeSessionId: state.pendingInteraction.session.nativeSessionId, nativeRequestId: state.pendingInteraction.turn.nativeRequestId!,
    nativeTurnId: state.pendingInteraction.turn.nativeTurnId, nativeRequestType: state.pendingInteraction.nativeRequestType, available: true,
    status: 'available', path: 'live_callback', reason: 'live_callback', message: 'Native reply callback is available.' }
  return state
}
export function mountChat(initial: AgentChatState = agentChatFixtures.empty, actions?: ManagementAction[]) {
  const mock = createAgentChatMock(initial, actions)
  server.use(...mock.handlers)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const renderPanel = (context: AgentChatContext) => <QueryClientProvider client={client}>
    <AgentChatPanel name="Coder" context={context} activity="Business occurrence 1 · technical attempt 1" running onNewConversation={newConversation} />
  </QueryClientProvider>
  const newConversation = vi.fn()
  const rendered = render(renderPanel(initial.context))
  const ready = () => waitFor(() => {
    expect(client.getQueryData(agentChatStateKey(initial.context))).toBeDefined()
    expect(screen.getByRole('status', { name: 'Agent state' })).toBeInTheDocument()
  })
  return { mock, client, ready, newConversation, ...rendered,
    switchContext: (context: AgentChatContext) => rendered.rerender(renderPanel(context)),
    refresh: () => client.invalidateQueries({ queryKey: agentChatStateKey(initial.context) }),
  }
}

/** Hovers a control and returns the tooltip it describes, not any other open tooltip. */
export async function chatTooltip(control: HTMLElement) {
  await userEvent.hover(control)
  return waitFor(() => {
    const id = control.getAttribute('aria-describedby')?.split(' ').at(-1)
    const tooltip = id ? document.getElementById(id) : null
    expect(tooltip).toHaveAttribute('role', 'tooltip')
    return tooltip!
  })
}
