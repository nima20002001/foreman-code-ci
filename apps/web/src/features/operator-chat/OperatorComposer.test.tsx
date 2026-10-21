import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { OperatorComposer } from './OperatorComposer'
import { useConversationDraftStore } from '../conversations'

afterEach(() => { cleanup(); useConversationDraftStore.getState().clearAllDrafts() })

it('puts a single attachment action inline with the message input and preserves file-only send', () => {
  const send = vi.fn()
  render(<OperatorComposer conversationId="owned-attachment-chat" attachmentControl={<button type="button">Attach files</button>}
    hasAttachments onSubmit={send} onNewChat={vi.fn()} />)
  const composer = screen.getByRole('form', { name: 'Conversation composer' })
  expect(within(composer).queryByRole('button', { name: 'New chat' })).not.toBeInTheDocument()
  expect(within(composer).getAllByRole('button', { name: 'Attach files' })).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Attach files' }).closest('.operator-composer-input')).toBe(screen.getByRole('textbox', { name: 'Message' }).parentElement)
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  expect(send).toHaveBeenCalledWith('')
})

it('keeps the explicit /new command available after removing the toolbar button', () => {
  const start = vi.fn()
  render(<OperatorComposer conversationId="owned-command-chat" onSubmit={vi.fn()} onNewChat={start} />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: '/new' } })
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter' })
  expect(start).toHaveBeenCalledOnce()
})

it('starts the suggested new chat while message sending is unavailable', () => {
  const start = vi.fn()
  const send = vi.fn()
  render(<OperatorComposer conversationId="command-chat" sendDisabled onSubmit={send} onNewChat={start} />)
  const input = screen.getByRole('textbox', { name: 'Message' })
  fireEvent.change(input, { target: { value: '/n' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(start).toHaveBeenCalledOnce()
  expect(send).not.toHaveBeenCalled()
})

it.each(['ordinary text', '/compact', '/plan', '/unknown', 'first line\nsecond line'])('keeps Stop independent of an active-turn draft %j', content => {
  const stop = vi.fn()
  const send = vi.fn()
  render(<OperatorComposer conversationId="active-chat" sendDisabled isSending hasAttachments
    onCancel={stop} onSubmit={send} onNewChat={vi.fn()} />)
  const input = screen.getByRole('textbox', { name: 'Message' })
  fireEvent.change(input, { target: { value: content } })
  const button = screen.getByRole('button', { name: 'Stop response' })
  expect(button).toBeEnabled()
  button.focus()
  expect(button).toHaveFocus()
  fireEvent.click(button)
  expect(stop).toHaveBeenCalledOnce()
  expect(input).toHaveValue(content)
  expect(send).not.toHaveBeenCalled()
})
