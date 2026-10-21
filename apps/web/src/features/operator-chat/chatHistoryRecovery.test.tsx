import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import type { OperatorActivity, OperatorConversationState } from '@foreman-code/contracts'
import { agentChatFixtures, type AgentChatState } from '@foreman-code/contracts/agent-chat'
import { server } from '../../mocks/server'
import { installChatSource, mountChat } from '../conversations/agentChat/testSupport'
import { useConversationDraftStore } from '../conversations/conversationDraftStore'
import { OperatorHistory } from './OperatorHistory'
import { OperatorTranscript } from './OperatorTranscript'
import { newerOperatorConversationState } from './operatorConversationReadback'
import { operatorState } from './pr17-test-fixtures'

const activity = (sequence: number, output = ''): OperatorActivity => ({
  id: `activity-${sequence}`, requestId: 'request-one', sequence: String(sequence), revision: sequence,
  kind: 'tool', status: 'completed', title: `Step ${sequence}`, output,
})
const activities = (first: number, last: number, output = '') =>
  Array.from({ length: last - first + 1 }, (_, index) => activity(first + index, output))
afterEach(() => { vi.unstubAllGlobals(); useConversationDraftStore.getState().clearAllDrafts() })

it.each(['agent messages', 'operator messages', 'operator activity'] as const)(
  'marks evicted %s and reloads nearer history after six backward pages', async kind => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let count = 0
    let initialReads = 0
    const state: AgentChatState = structuredClone(agentChatFixtures.idleAfterCompletion)
    state.messages = []
    state.hasEarlierMessages = true
    const id = kind === 'agent messages' ? state.conversation!.id : 'chat'
    let activeClient = client
    let unmount: () => void
    if (kind === 'agent messages') {
      installChatSource()
      const mounted = mountChat(state)
      activeClient = mounted.client
      unmount = mounted.unmount
      await mounted.ready()
    }
    server.use(http.get(kind === 'agent messages'
      ? '/api/workspaces/:workspaceId/agent-chat/conversations/:id/history'
      : '/api/operator/conversations/:id/history', ({ request }) => {
      const before = new URL(request.url).searchParams.get('before')
      if (!before) initialReads += 1
      const sequence = before ? Number(before) - 1 : 900
      count += 1
      const message = { id: String(sequence), conversationId: id, role: 'user' as const, content: `History ${sequence}` }
      if (kind === 'agent messages') return HttpResponse.json({ conversationId: id, messages: [message], nextCursor: String(sequence) })
      return HttpResponse.json({ conversationId: id, revision: 1, activeRequestId: null, nextCursor: String(sequence),
        entries: [{ sequence: String(sequence), message, receipt: null }] })
    }))
    server.use(http.get('/api/operator/conversations/:id/activity', ({ request }) => {
      const before = new URL(request.url).searchParams.get('before')
      if (before === '901') initialReads += 1
      const sequence = Number(before) - 1
      count += 1
      return HttpResponse.json({ activities: [activity(sequence)], nextCursor: String(sequence) })
    }))
    if (kind !== 'agent messages') {
      const view = render(<QueryClientProvider client={client}>{kind === 'operator messages'
        ? <OperatorHistory conversationId="chat" renderMessages={messages => <>{messages.map(message => <p key={message.id}>{message.content}</p>)}</>} />
        : <OperatorTranscript conversationId="chat" messages={[]} partialText="" activeRequestId="request-one"
          activities={[activity(901)]} activityNextCursor="901" />}</QueryClientProvider>)
      unmount = view.unmount
    }
    const button = kind === 'operator activity' ? 'Load earlier activity' : 'Load earlier messages'
    const content = kind === 'operator activity' ? 'Tool · Step' : 'History'
    for (let index = 0; index < 6; index += 1) {
      fireEvent.click(await screen.findByRole('button', { name: button }))
      await screen.findByText(`${content} ${900 - index}`)
      await waitFor(() => expect(screen.getByRole('button', { name: button })).toBeEnabled())
      expect(count).toBe(index + 1)
      expect(initialReads).toBe(1)
    }
    expect(screen.queryByText(`${content} 900`)).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'History window' })).toHaveTextContent('Only part of earlier history is shown')
    fireEvent.click(screen.getByRole('button', { name: 'Reload nearer history' }))
    expect(await screen.findByText(`${content} 900`)).toBeInTheDocument()
    expect(initialReads).toBe(2)
    expect(count).toBe(7)
    expect(screen.queryByRole('status', { name: 'History window' })).not.toBeInTheDocument()
    unmount!()
    activeClient.clear()
    client.clear()
  },
)

it('recovers the activity interval missed after reconnecting from an initial null cursor', async () => {
  const initial = operatorState({ activities: [activity(1)], activityNextCursor: null })
  const next = operatorState({ revision: 151, activities: activities(52, 151), activityNextCursor: '52' })
  const merged = newerOperatorConversationState(initial, next, 'read')
  expect(merged.activityNextCursor).toBe('52')
  expect(merged.activities?.map(entry => entry.sequence)).toEqual(activities(52, 151).map(entry => entry.sequence))
  const cursors: string[] = []
  server.use(http.get('/api/operator/conversations/:id/activity', ({ request }) => {
    const before = new URL(request.url).searchParams.get('before')!
    cursors.push(before)
    return HttpResponse.json({ activities: activities(2, 51), nextCursor: '2' })
  }))
  const client = new QueryClient()
  render(<QueryClientProvider client={client}><OperatorTranscript conversationId={merged.conversation.id}
    messages={[]} partialText="" activeRequestId="request-one" activities={merged.activities}
    activityNextCursor={merged.activityNextCursor} /></QueryClientProvider>)
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier activity' }))
  await screen.findByText('Tool · Step 2')
  expect(cursors).toEqual(['52'])
  expect(screen.getAllByText('Tool · Step 52')).toHaveLength(1)
  client.clear()
})

it('bounds the live Operator cache by count and UTF-8 bytes while advancing its recoverable cursor', async () => {
  let state: OperatorConversationState = operatorState({ activities: [], activityNextCursor: null })
  const output = '漢'.repeat(8_000)
  for (let end = 100; end <= 2_000; end += 100) {
    state = newerOperatorConversationState(state, operatorState({ revision: end,
      activities: activities(end - 99, end, output), activityNextCursor: String(end - 99) }), 'read')
    expect(state.activities!.length).toBeLessThanOrEqual(100)
    expect(new TextEncoder().encode(JSON.stringify(state.activities)).byteLength).toBeLessThanOrEqual(256 * 1024)
    expect(state.activities!.at(-1)?.sequence).toBe(String(end))
    expect(state.activityNextCursor).toBe(state.activities![0]?.sequence)
  }
  const stale = newerOperatorConversationState(state, operatorState({ revision: 1,
    activities: [activity(1)], activityNextCursor: null }), 'receipt')
  expect(stale.activities).toEqual(state.activities)
  expect(stale.activityNextCursor).toBe(state.activityNextCursor)
  const boundary = Number(state.activityNextCursor)
  server.use(http.get('/api/operator/conversations/:id/activity', ({ request }) => {
    expect(new URL(request.url).searchParams.get('before')).toBe(state.activityNextCursor)
    return HttpResponse.json({ activities: activities(boundary - 50, boundary - 1), nextCursor: String(boundary - 50) })
  }))
  const client = new QueryClient()
  render(<QueryClientProvider client={client}><OperatorTranscript conversationId={state.conversation.id}
    messages={[]} partialText="" activeRequestId="request-one" activities={state.activities}
    activityNextCursor={state.activityNextCursor} /></QueryClientProvider>)
  expect(screen.getAllByText(/^Tool · Step /).length).toBeLessThanOrEqual(100)
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier activity' }))
  await screen.findByText(`Tool · Step ${boundary - 1}`)
  expect(screen.getAllByText('Tool · Step 2000')).toHaveLength(1)
  client.clear()
})
