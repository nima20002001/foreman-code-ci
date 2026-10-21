import type { ReactNode } from 'react'
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, OperatorActivity } from '@foreman-code/contracts'
import { OperatorMessages } from './OperatorMessages'
import { OperatorTranscript } from './OperatorTranscript'
import { useOperatorChatStore } from './operatorChatStore'
import type { OperatorTextProjection } from './operatorTextProjection'

const history = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../../shared/api/operatorChatHistory', () => ({ getOperatorConversationHistory: history.get }))
const message = (id: string, content: string, boundary: string): Message => ({ id, conversationId: 'chat', requestId: 'request',
  role: 'assistant', content, nativeMessageId: id, nativeParentMessageId: 'native-parent', nativeMessageComplete: true, afterActivitySequence: boundary })
const tool: OperatorActivity = { id: 'tool', requestId: 'request', sequence: '1', revision: 1, kind: 'tool', status: 'completed', title: 'Read fixture' }
const first = message('part-a', 'Before the tool.', '0'), last = message('part-b', 'After the tool.', '1')
let client: QueryClient
beforeEach(() => {
  window.localStorage.clear()
  useOperatorChatStore.setState({ selectedConversationId: 'chat' })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const wrap = (content: ReactNode) => <QueryClientProvider client={client}>{content}</QueryClientProvider>

describe('persisted transcript boundaries', () => {
  it.each(['failed', 'canceled', 'failed after approval'])('keeps the terminal activity tail visible: %s', () => {
    const view = render(<OperatorMessages messages={[first]} activities={[tool]} activeRequestId={null} onBrowse={() => {}} />)
    expect(screen.getByText(first.content)).toBeVisible()
    expect(screen.getByText('Tool · Read fixture')).toBeVisible()
    expect(view.container.textContent!.indexOf('Before the tool.')).toBeLessThan(view.container.textContent!.indexOf('Read fixture'))
    view.unmount()
    render(<OperatorMessages messages={[{ ...first }]} activities={[{ ...tool }]} activeRequestId={null} onBrowse={() => {}} />)
    expect(screen.getByText(first.content)).toBeVisible()
    expect(screen.getByText('Tool · Read fixture')).toBeVisible()
  })
  it('preserves text/tool/text while active, completed with real IDs, and reloaded without stream state', () => {
    const timeline: OperatorTextProjection = { requestId: 'request', parts: { 'part-a': first.content, 'part-b': last.content }, timeline: [
      { kind: 'text', id: 'part-a:0', partId: 'part-a', text: first.content }, { kind: 'activity', id: 'tool' },
      { kind: 'text', id: 'part-b:2', partId: 'part-b', text: last.content },
    ] }
    const view = render(<OperatorMessages messages={[first, last]} activities={[tool]} activeRequestId="request" timeline={timeline} onBrowse={() => {}} />)
    const assertOrder = () => {
      expect(screen.getByText(first.content)).toBeVisible()
      expect(screen.getByText(last.content)).toBeVisible()
      const text = view.container.textContent!
      expect(text.indexOf(first.content)).toBeLessThan(text.indexOf('Read fixture'))
      expect(text.indexOf('Read fixture')).toBeLessThan(text.indexOf(last.content))
      expect(screen.getAllByText('Tool · Read fixture')).toHaveLength(1)
    }
    assertOrder()
    view.rerender(<OperatorMessages messages={[first, last]} activities={[tool]} activeRequestId={null} timeline={timeline} onBrowse={() => {}} />)
    assertOrder()
    view.rerender(<OperatorMessages messages={[first, last]} activities={[tool]} activeRequestId={null} onBrowse={() => {}} />)
    assertOrder()
  })
  it('allocates a split request once when an actual history page loads', async () => {
    const earlierTool = { ...tool, id: 'earlier-tool', sequence: '1', title: 'Earlier operation' }
    const newerTool = { ...tool, id: 'newer-tool', sequence: '2', title: 'Later operation' }
    const older = { ...first, afterActivitySequence: '1' }, recent = { ...last, afterActivitySequence: '2' }
    history.get.mockResolvedValue({ conversationId: 'chat', revision: 3, activeRequestId: null,
      entries: [{ sequence: '1', message: older, receipt: null }, { sequence: '2', message: recent, receipt: null }], nextCursor: null })
    render(wrap(<OperatorTranscript conversationId="chat" messages={[recent]} activities={[earlierTool, newerTool]}
      hasEarlierMessages partialText="" />))
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
    await screen.findByText(first.content)
    await waitFor(() => expect(screen.getAllByText('Tool · Earlier operation')).toHaveLength(1))
    expect(screen.getAllByText('Tool · Later operation')).toHaveLength(1)
    expect(screen.getAllByRole('list', { name: 'Conversation history' })).toHaveLength(1)
  })
  it('ignores a new React element for the same approval while the reader is above the bottom', () => {
    const view = render(wrap(<OperatorTranscript messages={[first]} partialText="" approvalRevision="request:v1" approval={<div>Decision</div>} />))
    const scroll = screen.getByRole('region', { name: 'Operator transcript' })
    Object.defineProperties(scroll, { scrollHeight: { configurable: true, value: 900 }, clientHeight: { configurable: true, value: 200 } })
    scroll.scrollTop = 0; fireEvent.scroll(scroll)
    view.rerender(wrap(<OperatorTranscript messages={[{ ...first }]} partialText="" approvalRevision="request:v1" approval={<div>Decision</div>} />))
    expect(screen.queryByRole('button', { name: /New output/ })).not.toBeInTheDocument()
  })
  it('pauses follow-latest before a details resize can move the reader', () => {
    let resized: (() => void) | undefined
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized = callback } observe() {} disconnect() {} })
    render(wrap(<OperatorTranscript messages={[first]} partialText="" approvalRevision="request:v1"
      approval={(onBrowse) => <details><summary onClick={onBrowse}>Request details</summary>Long request details</details>} />))
    const scroll = screen.getByRole('region', { name: 'Operator transcript' })
    Object.defineProperties(scroll, { scrollHeight: { configurable: true, value: 900 }, clientHeight: { configurable: true, value: 200 } })
    scroll.scrollTop = 700
    fireEvent.click(screen.getByText('Request details'))
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 1400 })
    act(() => resized?.())
    expect(scroll.scrollTop).toBe(700)
  })
})
