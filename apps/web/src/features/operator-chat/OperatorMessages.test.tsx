import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Message, OperatorActivity } from '@foreman-code/contracts'
import type { HarnessOptions } from '@foreman-code/contracts/management'
import { OperatorMessages } from './OperatorMessages'
import { operatorTextPartKey, projectOperatorActivity, projectOperatorText } from './operatorTextProjection'

const user: Message = { id: 'user', conversationId: 'chat', requestId: 'turn', role: 'user', content: 'Read the file' }
const thinking: OperatorActivity = { id: 'native-thought', requestId: 'turn', sequence: '1', revision: 1, kind: 'thinking', title: 'Thinking', status: 'running', output: 'Checking the requested file.' }
const tool: OperatorActivity = { ...thinking, id: 'native-read', sequence: '2', kind: 'file_read', title: 'Read file', input: 'note.txt', output: 'file content' }

describe('Operator message ownership', () => {
  it('identifies shortened live and persisted answers, then clears the notice for a complete answer', () => {
    const truncation = { truncated: true, originalBytes: 30_000 }
    const timeline = projectOperatorText(undefined, 'turn', { requestId: 'turn', partId: 'answer',
      mode: 'append', text: 'Retained prefix', truncation })
    const view = render(<OperatorMessages messages={[user]} activities={[]} activeRequestId="turn"
      partialText="Retained prefix" timeline={timeline} onBrowse={() => {}} />)
    expect(screen.getByRole('note', { name: 'Shortened message' })).toHaveTextContent(/^This message was shortened\.$/)
    const saved: Message = { id: 'saved', conversationId: 'chat', requestId: 'turn', role: 'assistant',
      content: 'Retained prefix', truncation }
    view.rerender(<OperatorMessages messages={[user, saved]} activities={[]} onBrowse={() => {}} />)
    expect(screen.getByRole('note', { name: 'Shortened message' })).toBeVisible()
    expect(screen.getByText('Retained prefix')).toBeVisible()
    view.rerender(<OperatorMessages messages={[user, { ...saved, truncation: { truncated: false, originalBytes: 15 } }]}
      activities={[]} onBrowse={() => {}} />)
    expect(screen.queryByRole('note', { name: 'Shortened message' })).not.toBeInTheDocument()
  })

  it('labels each assistant with its accepted turn model, including live output and unavailable catalog entries', () => {
    const modelCatalogs: Partial<Record<HarnessOptions['harness'], HarnessOptions['models']>> = {
      codex: [{ id: 'gpt-6.1-sol', name: 'Sol 6.1', reasoningEfforts: ['medium'], variants: [], serviceTiers: [] }],
      claude: [{ id: 'claude-opus-5-5', name: 'Opus 5.5', reasoningEfforts: ['medium'], variants: [], serviceTiers: [] },
        { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', reasoningEfforts: ['medium'], variants: [], serviceTiers: [] }],
    }
    const messages: Message[] = [
      { ...user, acceptedModel: { harness: 'claude', model: 'claude-opus-5-5' } },
      { id: 'opus', conversationId: 'chat', requestId: 'turn', role: 'assistant', content: 'Earlier answer', acceptedModel: { harness: 'claude', model: 'claude-opus-5-5' } },
      { ...user, id: 'sol-user', requestId: 'sol', acceptedModel: { harness: 'codex', model: 'gpt-6.1-sol' } },
      { id: 'sol-answer', conversationId: 'chat', requestId: 'sol', role: 'assistant', content: 'Later answer', acceptedModel: { harness: 'codex', model: 'gpt-6.1-sol' } },
      { id: 'unknown', conversationId: 'chat', requestId: 'unknown', role: 'assistant', content: 'Catalog entry removed', acceptedModel: { harness: 'opencode', model: 'provider/recorded-model' } },
      { id: 'legacy', conversationId: 'chat', requestId: 'legacy', role: 'assistant', content: 'No accepted configuration was recorded' },
      { ...user, id: 'live-user', requestId: 'live', acceptedModel: { harness: 'claude', model: 'claude-opus-5-5' } },
    ]
    render(<OperatorMessages messages={messages} activities={[]} modelCatalogs={modelCatalogs}
      activeRequestId="live" partialText="Live answer" working onBrowse={() => {}} />)
    expect(screen.getAllByRole('article', { name: 'Message from Opus 5.5' })).toHaveLength(2)
    expect(screen.getByRole('article', { name: 'Message from Sol 6.1' })).toHaveTextContent('Later answer')
    expect(screen.getByRole('article', { name: 'Message from provider/recorded-model' })).toHaveTextContent('Catalog entry removed')
    expect(screen.getByRole('article', { name: 'Message from Assistant' })).toHaveTextContent('No accepted configuration was recorded')
    expect(screen.queryByRole('article', { name: 'Message from Sonnet 5.5' })).not.toBeInTheDocument()
  })

  it('keeps saved reasoning beside its original turn when reading multiple loaded turns', () => {
    const reasoning = (id: string, requestId: string, content: string): Message => ({ id, conversationId: 'chat', requestId, role: 'assistant', activityChannel: 'reasoning', content })
    render(<OperatorMessages messages={[
      reasoning('leading', 'older', 'Earlier saved reasoning'),
      { ...user, content: 'First question' }, reasoning('reasoning-1', 'turn', 'First turn reasoning'),
      { id: 'answer-1', conversationId: 'chat', requestId: 'turn', role: 'assistant', content: 'First answer' },
      { ...user, id: 'user-2', requestId: 'turn-2', content: 'Second question' }, reasoning('reasoning-2', 'turn-2', 'Second turn reasoning'),
      { id: 'answer-2', conversationId: 'chat', requestId: 'turn-2', role: 'assistant', content: 'Second answer' },
    ]} activities={[]} onBrowse={() => {}} />)
    for (const toggle of screen.getAllByRole('button', { name: 'Thinking' })) fireEvent.click(toggle)
    const rows = within(screen.getByRole('list', { name: 'Conversation history' })).getAllByRole('listitem')
    expect(rows.map(row => row.textContent)).toEqual([
      expect.stringContaining('Earlier saved reasoning'), expect.stringContaining('First question'),
      expect.stringContaining('First turn reasoning'), expect.stringContaining('First answer'),
      expect.stringContaining('Second question'), expect.stringContaining('Second turn reasoning'), expect.stringContaining('Second answer'),
    ])
  })

  it('preserves the earlier reasoning disclosure when a later saved turn arrives', () => {
    const saved: Message[] = [user, { id: 'reasoning', conversationId: 'chat', requestId: 'turn', role: 'assistant', activityChannel: 'reasoning', content: 'Saved reasoning' },
      { id: 'answer', conversationId: 'chat', requestId: 'turn', role: 'assistant', content: 'Saved answer' }]
    const view = render(<OperatorMessages messages={saved} activities={[]} onBrowse={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
    view.rerender(<OperatorMessages messages={[...saved, { ...user, id: 'next-user', requestId: 'next', content: 'Next question' },
      { id: 'next-reasoning', conversationId: 'chat', requestId: 'next', role: 'assistant', activityChannel: 'reasoning', content: 'Next reasoning' }]}
      activities={[]} onBrowse={() => {}} />)
    expect(screen.getAllByRole('button', { name: 'Thinking' })[0]).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('region', { name: 'Thinking summary' })).toHaveTextContent('Saved reasoning')
    expect(screen.getAllByRole('button', { name: 'Thinking' })[1]).toHaveAttribute('aria-expanded', 'false')
  })

  it('puts thinking and tools inside the assistant container through streaming and final persistence', () => {
    const props = { messages: [user], activities: [thinking, tool], activeRequestId: 'turn', working: true, partialText: 'The file', onBrowse() {} }
    const view = render(<OperatorMessages {...props} />)
    const mine = screen.getByRole('article', { name: 'Message from You' })
    const assistant = screen.getByRole('article', { name: 'Message from Assistant' })
    expect(within(mine).queryByText('Thinking')).not.toBeInTheDocument()
    fireEvent.click(within(assistant).getByRole('button', { name: 'Thinking' }))
    expect(within(assistant).getByRole('region', { name: 'Thinking summary' })).toHaveTextContent('Checking the requested file.')
    expect(within(assistant).getByText('Read · Read file')).toBeInTheDocument()
    expect(within(assistant).getByText('Read · Read file').closest('.operator-answer')).toBeNull()
    expect(within(assistant).getByText('Read · Read file').closest('header')).toBeNull()
    expect(within(assistant).getByText('Read · Read file').closest('summary')?.querySelectorAll('svg')).toHaveLength(1)
    expect(within(assistant).getByText('The file').closest('.operator-answer')).not.toBeNull()
    expect(mine.closest('li')).toHaveAttribute('data-message-role', 'user')
    expect(assistant.closest('li')).toHaveAttribute('data-message-role', 'assistant')
    view.rerender(<OperatorMessages {...props} working={false} partialText="" messages={[user, { id: 'answer', conversationId: 'chat', requestId: 'turn', role: 'assistant', content: 'The file is read.' }]} />)
    expect(screen.getAllByRole('article', { name: 'Message from Assistant' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Thinking' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(assistant).getByText('The file is read.')).toBeInTheDocument()
  })

  it('does not attach another request’s thinking to the current assistant', () => {
    render(<OperatorMessages messages={[user]} activities={[{ ...thinking, requestId: 'older' }]} activeRequestId="turn" working onBrowse={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Operator is typing' })).toBeInTheDocument()
  })

  it('keeps live answer text between the tool calls that surround it', () => {
    const first = { ...tool, id: 'read', sequence: '2', status: 'completed' as const, title: 'Read file' }
    const second = { ...tool, id: 'write', sequence: '3', status: 'running' as const, title: 'Write file' }
    let stream = projectOperatorActivity(undefined, 'turn', 'turn', first.id)
    stream = projectOperatorText(stream, 'turn', { requestId: 'turn', partId: 'answer', mode: 'append', text: 'First answer.' })
    stream = projectOperatorActivity(stream, 'turn', 'turn', second.id)
    stream = projectOperatorText(stream, 'turn', { requestId: 'turn', partId: 'answer', mode: 'append', text: ' More answer.' })
    stream = projectOperatorText(stream, 'turn', { requestId: 'turn', partId: 'answer', mode: 'replace', text: 'First answer. More answer.' })
    const view = render(<OperatorMessages messages={[user]} activities={[first, second]} activeRequestId="turn" working
      partialText="First answer. More answer." timeline={stream} onBrowse={() => {}} />)
    const assistant = screen.getByRole('article', { name: 'Message from Assistant' })
    expect([...assistant.querySelectorAll('.operator-tool-activity, .operator-answer')].map((item) => item.textContent)).toEqual([
      expect.stringContaining('Read file'), 'First answer.', expect.stringContaining('Write file'), ' More answer.',
    ])
    view.rerender(<OperatorMessages messages={[user, { id: 'saved', conversationId: 'chat', requestId: 'turn', role: 'assistant', content: 'First answer. More answer.' }]}
      activities={[first, second]} timeline={stream} onBrowse={() => {}} />)
    expect([...screen.getByRole('article', { name: 'Message from Assistant' }).querySelectorAll('.operator-tool-activity, .operator-answer')]
      .map((item) => item.textContent)).toEqual([
      expect.stringContaining('Read file'), 'First answer.', expect.stringContaining('Write file'), ' More answer.',
    ])
  })

  it('keeps completed commentary and tools in order after the final answer replaces streaming state', () => {
    const first = { ...tool, id: 'create', sequence: '1', status: 'completed' as const, title: 'Create folder' }
    const second = { ...tool, id: 'verify', sequence: '2', status: 'completed' as const, title: 'Verify folder' }
    const assistant = (id: string, content: string, afterActivitySequence: string): Message => ({
      id, conversationId: 'chat', requestId: 'turn', role: 'assistant', content,
      nativeMessageId: id, afterActivitySequence,
    })
    render(<OperatorMessages messages={[user, assistant('comment-1', 'Creating the folder.', '0'),
      assistant('comment-2', 'The first attempt was blocked.', '1'), assistant('final', 'Created and verified.', '2')]}
      activities={[first, second]} onBrowse={() => {}} />)
    const ordered = [...screen.getByRole('list', { name: 'Conversation history' }).querySelectorAll('.operator-tool-activity, .operator-answer')]
      .map((item) => item.textContent)
    expect(ordered).toEqual(['Creating the folder.', expect.stringContaining('Create folder'),
      'The first attempt was blocked.', expect.stringContaining('Verify folder'), 'Created and verified.'])
  })

  it('replaces a live commentary segment with its persisted message without duplicating or dropping it', () => {
    let stream = projectOperatorText(undefined, 'turn', { requestId: 'turn', partId: 'native-comment', mode: 'append', text: 'I will create it.' })
    stream = projectOperatorActivity(stream, 'turn', 'turn', 'create')
    const create = { ...tool, id: 'create', sequence: '1', status: 'running' as const, title: 'Create folder' }
    const view = render(<OperatorMessages messages={[user]} activities={[create]} activeRequestId="turn" working
      partialText="I will create it." timeline={stream} onBrowse={() => {}} />)
    expect(screen.getAllByText('I will create it.')).toHaveLength(1)
    const saved: Message = { id: 'saved-comment', conversationId: 'chat', requestId: 'turn', role: 'assistant',
      content: 'I will create it.', nativeMessageId: 'native-comment', afterActivitySequence: '0' }
    view.rerender(<OperatorMessages messages={[user, saved]} activities={[create]} activeRequestId="turn" working
      partialText="" timeline={stream} onBrowse={() => {}} />)
    expect(screen.getAllByText('I will create it.')).toHaveLength(1)
    const articles = screen.getAllByRole('article', { name: 'Message from Assistant' })
    expect(within(articles[0]).getByText('I will create it.')).toBeVisible()
    expect(within(articles[1]).getByText('Read · Create folder')).toBeVisible()
  })

  it('does not add blank lines to the top of a new streamed answer bubble', () => {
    let stream = projectOperatorText(undefined, 'turn', { requestId: 'turn', partId: 'first', mode: 'append', text: 'First update.' })
    stream = projectOperatorText(stream, 'turn', { requestId: 'turn', partId: 'second', mode: 'append', text: 'Second update.' })
    expect(stream?.timeline.filter((item) => item.kind === 'text').map((item) => item.text)).toEqual(['First update.', 'Second update.'])
  })
})

it('keeps working feedback when a saved full-native part consumes all projected text and retains another item at part zero', () => {
  const native = { harness: 'codex', sessionId: 'session', turnId: 'native-turn', itemId: 'item', partId: '0' }
  const key = operatorTextPartKey(native)
  const saved: Message = { id: 'saved', conversationId: 'chat', requestId: 'turn', role: 'assistant',
    nativeMessageId: 'item', activityNative: native, nativeMessageComplete: true, content: 'Saved answer' }
  const timeline = projectOperatorText(undefined, 'turn', { requestId: 'turn', partId: key, mode: 'append', text: 'Saved answer' })
  const view = render(<OperatorMessages messages={[user, saved]} activities={[]} activeRequestId="turn" working
    timeline={timeline} partialText="Saved answer" onBrowse={() => {}} />)
  expect(screen.getAllByText('Saved answer')).toHaveLength(1)
  expect(screen.getByRole('status', { name: 'Operator is typing' })).toBeVisible()
  const secondKey = operatorTextPartKey({ ...native, itemId: 'child' })
  const next = projectOperatorText(timeline, 'turn', { requestId: 'turn', partId: secondKey, mode: 'append', text: 'Child answer' })
  view.rerender(<OperatorMessages messages={[user, saved]} activities={[]} activeRequestId="turn" working
    timeline={next} partialText="Saved answer\n\nChild answer" onBrowse={() => {}} />)
  expect(screen.getAllByText('Saved answer')).toHaveLength(1)
  expect(screen.getByText('Child answer')).toBeVisible()
  expect(screen.queryByRole('status', { name: 'Operator is typing' })).not.toBeInTheDocument()
})
