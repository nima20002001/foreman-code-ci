import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { useConversationDraftStore } from '../conversationDraftStore'
import { intentUnavailable } from './model'
import { completedFixture, ephemeralFixture, startedFixture } from './f7.testSupport'
import { chatTooltip, mountChat } from './testSupport'

const clients: ReturnType<typeof mountChat>['client'][] = []
afterEach(() => { clients.splice(0).forEach((client) => client.clear()); useConversationDraftStore.getState().clearAllDrafts(); vi.unstubAllGlobals() })

describe('F7 B-R06 terminal-decided ephemeral Codex facts', () => {
  it('continues the resident session after completion, then blocks restart loss without creating a replacement', async () => {
    const initial = ephemeralFixture('empty'), mounted = mountChat(initial); clients.push(mounted.client); await mounted.ready()
    const sends = () => mounted.mock.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/messages'))
    const send = async (text: string) => {
      fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: text } })
      await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
      await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(''))
      return sends().at(-1)!.body as SendAgentChatMessageRequest
    }
    const first = await send('First live ephemeral turn')
    let state = completedFixture(startedFixture(mounted.mock.getState(initial.context), first.requestId), 'First answer')
    mounted.mock.setState(state); await act(() => mounted.refresh())
    await screen.findAllByLabelText('Completed').then(items => items.at(-1)!)
    expect(state.capabilities.resume).toBe(true)
    const second = await send('Follow up in the resident session')
    expect(second.expectedConversationId).toBe(state.conversation!.id)
    expect(second.requestId).not.toBe(first.requestId)
    const identity = state.conversation!.nativeSession
    state = completedFixture(startedFixture(mounted.mock.getState(initial.context), second.requestId), 'Second answer')
    expect(state.conversation!.nativeSession).toEqual(identity)
    const lost = ephemeralFixture('restarted')
    state = { ...state, sessionState: lost.sessionState, capabilities: lost.capabilities, availability: lost.availability, revision: state.revision + 1 }
    mounted.mock.setState(state); await act(() => mounted.refresh())
    await screen.findByText('Original session unavailable')
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Keep after restart' } })
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    expect(await chatTooltip(screen.getByRole('status', { name: 'Agent state' })))
      .toHaveTextContent('ephemeral Codex session was lost')
    expect(screen.queryByRole('button', { name: /resume/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Choose another Agent for a new conversation' })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter' })
    expect(sends()).toHaveLength(2)
    expect(mounted.mock.getState(initial.context).conversation!.nativeSession).toEqual(identity)
  })

  it('never overrides a false current capability based on Codex or an optimistic canSend flag', () => {
    const state = ephemeralFixture('live')
    expect(intentUnavailable(state, 'next_turn')).toBeUndefined()
    state.capabilities.resume = false; state.capabilities.unavailable.resume = 'Current continuation is unavailable.'
    expect(intentUnavailable(state, 'next_turn')).toBe('Current continuation is unavailable.')
    expect(intentUnavailable(ephemeralFixture('restarted'), 'next_turn')).toMatch(/lost when the API restarted/)
  })
})
