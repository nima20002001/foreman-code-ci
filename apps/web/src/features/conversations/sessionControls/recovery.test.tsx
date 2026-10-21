import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionControlStateSchema, unavailableSessionControls } from '@foreman-code/contracts'
import { OperatorComposer } from '../../operator-chat/OperatorComposer'
import { ConversationComposer } from '../ConversationComposer'
import { SessionContext } from './SessionControls'
import { useConversationDraftStore } from '../conversationDraftStore'
import type { ComposerSessionControls } from './useSessionControls'

function controller() {
  const capabilities = unavailableSessionControls('profile')
  const state = SessionControlStateSchema.parse({
    conversationId: 'chat', revision: 4, profileKey: 'profile', desiredMode: 'plan', appliedMode: 'plan',
    defaults: {}, desired: {}, applied: {}, applicability: 'applied', nativeSessionId: 'native',
    nativeProviderVersion: 'fixture-1', nativeStatus: 'resume-required',
    compaction: null, compactions: [], busyReason: null,
    capabilities: { ...capabilities, plan: { supported: true, reason: null },
      compact: { supported: true, reason: null } },
    context: { nativeSessionId: 'native', model: 'model', generation: 'connection', sequence: 1,
      source: 'codex', accuracy: 'native', usedTokens: 50000, capacityTokens: 100000,
      lifetimeTokens: 80000, cost: null, observedAt: '2026-10-08T00:00:00.000Z', stale: true },
  })
  return { state, query: { isError: false, refetch: vi.fn() }, mutation: { isPending: false, isError: false },
    change: vi.fn(async () => state), command: vi.fn(async () => true) } as unknown as ComposerSessionControls
}

afterEach(() => {
  cleanup()
  useConversationDraftStore.getState().clearAllDrafts()
})

it.each(['operator', 'agent'])('shows the last known context after reloading %s chat and offers no session options', role => {
  const controls = controller()
  if (role === 'operator') {
    render(<><SessionContext controls={controls} /><OperatorComposer conversationId="chat" sessionControls={controls} onNewChat={vi.fn()} onSubmit={vi.fn()} /></>)
  } else {
    render(<><SessionContext controls={controls} /><ConversationComposer conversationId="chat" sessionControls={controls} onSubmit={vi.fn()} /></>)
  }
  expect(screen.queryByRole('combobox', { name: 'Conversation mode' })).not.toBeInTheDocument()
  expect(screen.queryByLabelText(/session options/i)).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '50% context · stale' }))
  expect(screen.getByText('Last known usage. Waiting for a native update.')).toBeInTheDocument()
  expect(screen.queryByText('Send a message to discover this native session’s controls.')).not.toBeInTheDocument()
})

it('drops the stale label once a native update loads the session', () => {
  const controls = controller()
  const view = render(<SessionContext controls={controls} />)
  expect(screen.getByRole('button', { name: '50% context · stale' })).toBeInTheDocument()
  controls.state = { ...controls.state!, nativeStatus: 'loaded', context: { ...controls.state!.context!, stale: false } }
  view.rerender(<SessionContext controls={controls} />)
  expect(screen.getByRole('button', { name: '50% context' })).toBeInTheDocument()
})
